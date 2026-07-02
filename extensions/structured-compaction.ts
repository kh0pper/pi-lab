/**
 * Structured Compaction Extension
 *
 * Pi's default compaction produces a markdown narrative with headers like
 * `## Decisions`, `## Open Items`, `## Next Steps`. This extension hooks the
 * `session_compact` event (fired AFTER compaction completes), parses those
 * headers out of the narrative, and writes a structured JSON state file at
 * `~/.pi/agent/session-state.json`. The companion `session-state-loader.ts`
 * extension reads that file on the next session start and surfaces it via
 * the system prompt — providing continuity across compaction boundaries.
 *
 * No extra LLM round-trip. No JSON-schema dependency on the model. The
 * structure is extracted deterministically from the markdown the default
 * compaction already produces.
 *
 * Configuration (in ~/.pi/agent/settings.json):
 *   "structuredCompaction": {
 *     "enabled": true,
 *     "stateFilePath": "~/.pi/agent/session-state.json"
 *   }
 *
 * Both fields are optional. Enabled by default. Path defaults shown above.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface SessionState {
	updated_at: string;
	cwd?: string;
	goals: string[];
	decisions: string[];
	open_items: string[];
	next_steps: string[];
	/** One-line error summaries only — bodies are scrubbed (see scrubErrors). */
	errors: string[];
	key_context: string;
}

const EMPTY_STATE: SessionState = {
	updated_at: "",
	goals: [],
	decisions: [],
	open_items: [],
	next_steps: [],
	errors: [],
	key_context: "",
};

const HEADER_MAP: Array<{ field: keyof Omit<SessionState, "updated_at" | "cwd">; headers: string[] }> = [
	{ field: "goals", headers: ["goal", "goals", "objective", "objectives", "what we are doing"] },
	{ field: "decisions", headers: ["decisions", "key decisions", "decisions made"] },
	{ field: "open_items", headers: ["open items", "open", "blockers", "in progress", "todo", "todos"] },
	{ field: "next_steps", headers: ["next steps", "next", "to do next", "follow-ups"] },
	// Opportunistic: pi's default summary prompt doesn't emit an Errors header today,
	// but if one appears (custom compaction, future upstream) we capture it.
	{ field: "errors", headers: ["errors", "error traces", "critical errors", "failures"] },
	{ field: "key_context", headers: ["key context", "context", "critical context", "background"] },
];

/**
 * Error-scrubbing (research: models self-condition on their own past errors —
 * re-injecting error-laden history measurably degrades long-horizon accuracy).
 * Keep the SIGNAL (that something failed, one line) and drop the NOISE
 * (stack traces, repeated tool-error bodies) before anything is persisted and
 * re-injected into future sessions by session-state-loader.
 */
function scrubErrors(items: string[]): string[] {
	return items.map((line) => {
		const flat = line.replace(/\s+/g, " ").trim();
		return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
	});
}

function parseSummary(summary: string): Partial<SessionState> {
	const out: Partial<SessionState> = {};
	const headerRegex = /^#{1,3}\s+(.+?)\s*$/gm;
	const sections: Array<{ header: string; start: number; end: number }> = [];
	let m: RegExpExecArray | null;
	while ((m = headerRegex.exec(summary)) !== null) {
		sections.push({ header: m[1].toLowerCase().trim(), start: m.index + m[0].length, end: summary.length });
	}
	for (let i = 0; i < sections.length - 1; i++) sections[i].end = sections[i + 1].start - 1;

	for (const section of sections) {
		const body = summary.slice(section.start, section.end).trim();
		if (!body) continue;
		const matched = HEADER_MAP.find((h) => h.headers.some((hh) => section.header.includes(hh)));
		if (!matched) continue;

		if (matched.field === "key_context") {
			out.key_context = body;
		} else {
			const items = body
				.split("\n")
				.map((line) => line.replace(/^\s*[-*+]\s+/, "").trim())
				.filter((line) => line.length > 0 && !line.startsWith("```"));
			(out[matched.field] as string[] | undefined) = items;
		}
	}
	return out;
}

function dedupAppend(existing: string[], incoming: string[], cap = 50): string[] {
	const seen = new Set(existing.map((x) => x.toLowerCase()));
	const merged = [...existing];
	for (const x of incoming) {
		const k = x.toLowerCase();
		if (!seen.has(k)) {
			seen.add(k);
			merged.push(x);
		}
	}
	return merged.slice(-cap);
}

function expandHome(p: string): string {
	if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
	return resolve(p);
}

function loadExisting(path: string): SessionState {
	if (!existsSync(path)) return { ...EMPTY_STATE };
	try {
		const data = JSON.parse(readFileSync(path, "utf8"));
		return {
			updated_at: typeof data.updated_at === "string" ? data.updated_at : "",
			cwd: typeof data.cwd === "string" ? data.cwd : undefined,
			goals: Array.isArray(data.goals) ? data.goals : [],
			decisions: Array.isArray(data.decisions) ? data.decisions : [],
			open_items: Array.isArray(data.open_items) ? data.open_items : [],
			next_steps: Array.isArray(data.next_steps) ? data.next_steps : [],
			errors: Array.isArray(data.errors) ? data.errors : [],
			key_context: typeof data.key_context === "string" ? data.key_context : "",
		};
	} catch {
		return { ...EMPTY_STATE };
	}
}

interface Settings {
	enabled: boolean;
	stateFilePath: string;
}

function loadSettings(): Settings {
	const settingsPath = resolve(homedir(), ".pi", "agent", "settings.json");
	let raw: { structuredCompaction?: Partial<Settings> } = {};
	try {
		if (existsSync(settingsPath)) raw = JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch {
		/* ignore corrupt settings */
	}
	const cfg = raw.structuredCompaction ?? {};
	return {
		enabled: cfg.enabled !== false,
		stateFilePath: expandHome(cfg.stateFilePath ?? "~/.pi/agent/session-state.json"),
	};
}

export default function (pi: ExtensionAPI) {
	const settings = loadSettings();
	if (!settings.enabled) return;

	pi.on("session_compact", (event) => {
		const summary = event.compactionEntry?.summary;
		if (!summary || typeof summary !== "string") return;

		const parsed = parseSummary(summary);
		if (
			!parsed.goals?.length &&
			!parsed.decisions?.length &&
			!parsed.open_items?.length &&
			!parsed.next_steps?.length &&
			!parsed.errors?.length &&
			!parsed.key_context
		) {
			return;
		}

		const existing = loadExisting(settings.stateFilePath);
		const next: SessionState = {
			updated_at: new Date().toISOString(),
			cwd: process.cwd(),
			goals: dedupAppend(existing.goals, parsed.goals ?? [], 10),
			decisions: dedupAppend(existing.decisions, parsed.decisions ?? [], 50),
			open_items: scrubErrors(parsed.open_items ?? existing.open_items),
			next_steps: parsed.next_steps ?? existing.next_steps,
			errors: scrubErrors(parsed.errors ?? []).slice(-10), // latest compaction only, capped
			key_context: parsed.key_context ?? existing.key_context,
		};

		try {
			mkdirSync(dirname(settings.stateFilePath), { recursive: true });
			writeFileSync(settings.stateFilePath, JSON.stringify(next, null, 2));
		} catch {
			/* fail silently — compaction itself succeeded */
		}
	});
}
