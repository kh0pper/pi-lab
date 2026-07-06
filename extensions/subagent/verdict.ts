/**
 * verdict.ts — leg failure-verdict protocol for subagent chains (D4).
 *
 * Chain legs are asked (via a runtime-appended instruction) to end with:
 *
 *   ```verdict
 *   {"ok": true, "reason": ""}
 *   ```
 *
 * Parsing mirrors critic/index.ts's mechanics (fenced-last-first, balanced-brace
 * fallback anchored on the key) but with FAIL-OPEN missing-verdict semantics —
 * a deliberate inversion vs critics: a critic's forgotten verdict costs a human
 * glance; a leg's forgotten verdict triggering decompose costs a splitter spawn
 * plus 2–4 sub-legs of local-model minutes. 35B-class models forget output
 * format rules; forgetting must be cheap (missing verdict = success = today's
 * behavior).
 *
 * Refinements from review:
 * - Callers must pass the CONCATENATION of all text parts of the final
 *   assistant message (a verdict in a second text part must not vanish).
 * - Accept drifted fences (```json / bare ```), not only ```verdict.
 * - Key-strictness (ok + optional reason/ran) applies ONLY to ok:true
 *   candidates — an explicit ok:false in any shape counts (padded honest
 *   failures must not become successes). Strictness exists to reject unrelated
 *   quoted JSON that happens to contain an "ok" field.
 * - The VERDICT_INSTRUCTION example uses the literal `true|false` placeholder,
 *   which is intentionally NOT valid JSON — an echoed instruction can never be
 *   parsed as a verdict.
 *
 * Pure module: no pi imports (loader-gate covered by bin/pi-extension-check).
 */

export interface LegVerdict {
	ok: boolean;
	reason?: string;
	/** Commands the leg claims to have executed to verify its work (optional). */
	ran?: string[];
	/** false when no verdict block was found (fail-open success). */
	found: boolean;
}

export const VERDICT_INSTRUCTION =
	`\n\nFINAL OUTPUT REQUIREMENT: end your reply with a fenced verdict block exactly like:\n` +
	"```verdict\n" +
	`{"ok": true|false, "reason": "one line, required when ok is false", "ran": ["test/build commands you executed"]}\n` +
	"```\n" +
	`Set "ok": false with a one-line reason if you could NOT fully complete the task ` +
	`(file missing, anchor not found, tests failing, ...). "ran" is optional — list the ` +
	`verification commands you actually executed, if any. Write nothing after the block.`;

interface Candidate {
	obj: Record<string, unknown>;
	tagged: boolean;
}

function tryParse(text: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(text);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function collectCandidates(output: string): Candidate[] {
	const candidates: Candidate[] = [];
	// fenced blocks, any tag (```verdict preferred via `tagged`)
	const fence = /```([a-zA-Z]*)\n([\s\S]*?)```/g;
	let m: RegExpExecArray | null;
	while ((m = fence.exec(output)) !== null) {
		const obj = tryParse(m[2].trim());
		if (obj && typeof obj.ok === "boolean") candidates.push({ obj, tagged: m[1] === "verdict" });
	}
	// balanced-brace fallback anchored on the last `"ok"` occurrence outside fences
	if (candidates.length === 0) {
		const anchor = output.lastIndexOf('"ok"');
		if (anchor >= 0) {
			const start = output.lastIndexOf("{", anchor);
			if (start >= 0) {
				let depth = 0;
				for (let i = start; i < output.length; i++) {
					if (output[i] === "{") depth++;
					else if (output[i] === "}") {
						depth--;
						if (depth === 0) {
							const obj = tryParse(output.slice(start, i + 1));
							if (obj && typeof obj.ok === "boolean") candidates.push({ obj, tagged: false });
							break;
						}
					}
				}
			}
		}
	}
	return candidates;
}

export function parseLegVerdict(output: string): LegVerdict {
	const candidates = collectCandidates(output);
	// last candidate wins; ```verdict-tagged blocks take precedence over untagged
	const pick = [...candidates].reverse().find((c) => c.tagged) ?? candidates[candidates.length - 1];
	if (!pick) return { ok: true, found: false };
	const obj = pick.obj;
	const ranOf = (o: Record<string, unknown>): string[] | undefined =>
		Array.isArray(o.ran) && o.ran.every((x) => typeof x === "string") ? (o.ran as string[]) : undefined;
	if (obj.ok === false) {
		// explicit failure counts in any shape
		return { ok: false, reason: typeof obj.reason === "string" ? obj.reason : undefined, ran: ranOf(obj), found: true };
	}
	// ok:true candidates must be strict (only ok/reason/ran keys) — rejects
	// unrelated quoted JSON like {"ok": true, "data": {...}}
	const keys = Object.keys(obj);
	const strict = keys.length <= 3 && keys.every((k) => k === "ok" || k === "reason" || k === "ran");
	if (!strict) return { ok: true, found: false };
	return { ok: true, reason: typeof obj.reason === "string" ? obj.reason : undefined, ran: ranOf(obj), found: true };
}

/** Remove verdict-shaped fenced blocks so they never leak into {previous} or final content. */
export function stripVerdictBlocks(output: string): string {
	return output
		.replace(/```([a-zA-Z]*)\n([\s\S]*?)```/g, (whole, _tag, body) => {
			const obj = tryParse(String(body).trim());
			const verdictShaped =
				obj &&
				typeof obj.ok === "boolean" &&
				Object.keys(obj).length <= 3 &&
				Object.keys(obj).every((k) => k === "ok" || k === "reason" || k === "ran");
			return verdictShaped ? "" : whole;
		})
		.trim();
}

/**
 * Parse 2–4 sub-steps from splitter output. Scans the WHOLE output for
 * numbered lines (the model may frame them with headers); continuation lines
 * are folded into the preceding item.
 */
export function parseNumberedList(output: string): string[] {
	const items: string[] = [];
	let current = -1;
	for (const line of stripVerdictBlocks(output).split("\n")) {
		const m = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
		if (m) {
			current = Number(m[1]);
			items.push(m[2].trim());
		} else if (current > 0 && items.length > 0 && line.trim() && !line.match(/^#{1,3}\s/)) {
			items[items.length - 1] += ` ${line.trim()}`;
		} else if (line.match(/^#{1,3}\s/)) {
			current = -1; // a header ends the current list run
		}
	}
	return items;
}
