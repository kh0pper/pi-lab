/**
 * ask-user.ts — Claude Code AskUserQuestion parity.
 *
 * Registers an `ask_user` tool the model calls when it needs the user to pick
 * between discrete options (clarifying questions, design choices, either/or
 * decisions). The tool BLOCKS the turn until answered, like Claude Code:
 *
 *   - TUI: each question renders as a native pi selector (ctx.ui.select);
 *     "Other…" opens a free-text input. Multi-select loops with ✓ toggles.
 *   - Web/PWA: the question broadcasts to connected clients as an interactive
 *     card (mobile.ts forwards "pi-lab:ask-user" over SSE; answers come back
 *     via POST /api/mobile/chat/answer → "pi-lab:ask-user-answer").
 *   - First answer wins — answering on the phone dismisses the TUI selector
 *     (AbortSignal) and vice versa.
 *
 * Bus contract:
 *   emits    "pi-lab:ask-user"          { id, questions }
 *   emits    "pi-lab:ask-user-resolved" { id, answered }
 *   handles  "pi-lab:ask-user-answer"   { id, answers:[{question,answer}], handled← }
 *   handles  "pi-lab:ask-user-pending"  { pending← [{id, questions}] }  (sync fill)
 *
 * Aborting the turn (Esc) cancels the question: the tool returns an error
 * result and both surfaces are dismissed. TUI dismissal (Esc on the selector)
 * only closes the terminal dialog — the web card stays live so the phone can
 * still answer; abort the turn to cancel outright.
 *
 * No-op for bots (PI_BOT_PERMISSION_POLICY) and subagent children
 * (PIBOT_SUBAGENT_DEPTH >= 1) — they have no user to ask. In print mode /
 * non-TTY sessions the TUI path is skipped (web-only), matching how those
 * sessions are actually driven.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

interface AskOption {
	label: string;
	description?: string;
}

interface AskQuestion {
	question: string;
	header?: string;
	options: AskOption[];
	multiSelect?: boolean;
}

interface Answer {
	question: string;
	answer: string;
}

interface Pending {
	id: string;
	questions: AskQuestion[];
	settle: (answers: Answer[] | null) => void;
}

const OTHER = "Other…";

/** Render one option as a single selector row. */
function optionRow(o: AskOption, checked?: boolean): string {
	const mark = checked === undefined ? "" : checked ? "[x] " : "[ ] ";
	return `${mark}${o.label}${o.description ? ` — ${o.description}` : ""}`;
}

/** Walk the questions through pi's native TUI dialogs. Returns null if the
 * user dismisses (web card stays live) — never throws. */
async function runTuiFlow(ctx: ExtensionContext, questions: AskQuestion[], signal: AbortSignal): Promise<Answer[] | null> {
	const answers: Answer[] = [];
	for (const [i, q] of questions.entries()) {
		const title = `${questions.length > 1 ? `(${i + 1}/${questions.length}) ` : ""}${q.header ? `${q.header}: ` : ""}${q.question}`;
		if (q.multiSelect) {
			const picked = new Set<string>();
			for (;;) {
				if (signal.aborted) return null;
				const rows = q.options.map((o) => optionRow(o, picked.has(o.label)));
				const done = `── done${picked.size ? ` (${picked.size} selected)` : ""} ──`;
				const choice = await ctx.ui.select(title, [...rows, OTHER, done], { signal });
				if (choice === undefined) return null; // dismissed — leave web card live
				if (choice === done) break;
				if (choice === OTHER) {
					const text = await ctx.ui.input(q.question, "type your answer", { signal });
					if (text?.trim()) picked.add(text.trim());
					continue;
				}
				const idx = rows.indexOf(choice);
				const label = q.options[idx]?.label;
				if (label) picked.has(label) ? picked.delete(label) : picked.add(label);
			}
			answers.push({ question: q.question, answer: picked.size ? [...picked].join(", ") : "(none)" });
		} else {
			if (signal.aborted) return null;
			const rows = q.options.map((o) => optionRow(o));
			const choice = await ctx.ui.select(title, [...rows, OTHER], { signal });
			if (choice === undefined) return null;
			if (choice === OTHER) {
				const text = await ctx.ui.input(q.question, "type your answer", { signal });
				if (text === undefined) return null;
				answers.push({ question: q.question, answer: text.trim() || "(no answer)" });
			} else {
				const idx = rows.indexOf(choice);
				answers.push({ question: q.question, answer: q.options[idx]?.label ?? choice });
			}
		}
	}
	return answers;
}

export default function (pi: ExtensionAPI) {
	// Bots and subagent children have no user to ask — a blocked ask_user
	// there would hang the leg until its turn budget kills it.
	if (process.env["PI_BOT_PERMISSION_POLICY"]) return;
	if (Number(process.env["PIBOT_SUBAGENT_DEPTH"] ?? "0") >= 1) return;

	const pending = new Map<string, Pending>();

	// Web answers (mobile.ts POST /answer). Synchronous fill: `handled` tells
	// the HTTP handler whether the id matched a live question.
	pi.events.on("pi-lab:ask-user-answer", (data) => {
		const d = (data ?? {}) as { id?: string; answers?: unknown; handled?: boolean };
		const p = d.id ? pending.get(d.id) : undefined;
		if (!p || !Array.isArray(d.answers)) return;
		const byQuestion = new Map(
			(d.answers as Array<{ question?: string; answer?: string }>)
				.filter((a) => typeof a?.answer === "string")
				.map((a) => [a.question ?? "", String(a.answer)]),
		);
		// Re-key to the tool's own question list so a stale/partial client
		// payload can't inject extra questions into the result.
		const answers: Answer[] = p.questions.map((q, i) => ({
			question: q.question,
			answer: byQuestion.get(q.question) ?? [...byQuestion.values()][i] ?? "(no answer)",
		}));
		d.handled = true;
		p.settle(answers);
	});

	// Live questions for /history reloads (sync fill). MERGE — plan-mode's
	// what-next card answers this query too.
	pi.events.on("pi-lab:ask-user-pending", (data) => {
		const d = (data ?? {}) as { pending?: Array<{ id: string; questions: AskQuestion[] }> };
		d.pending = [...(d.pending ?? []), ...[...pending.values()].map(({ id, questions }) => ({ id, questions }))];
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask the user",
		description:
			"Ask the user one or more questions with discrete answer options (single or multi-select; an 'Other' free-text choice is added automatically). Renders as a native selector in the terminal AND as a tappable card on the web/phone chat — use this instead of writing questions as plain text whenever the answers are enumerable (clarifying requirements, design choices, either/or decisions). Blocks until the user answers, so batch related questions into one call (max 4).",
		promptSnippet: "ask_user: ask the user clarifying/decision questions with tappable answer options",
		promptGuidelines: [
			"When you need the user to decide between enumerable options (clarifying questions, design choices), call ask_user rather than asking in plain text — it renders tappable choices in the terminal and on the phone.",
		],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({ description: "The complete question to ask the user" }),
					header: Type.Optional(Type.String({ description: "Very short topic label (max ~12 chars), e.g. 'Auth', 'Storage'" })),
					options: Type.Array(
						Type.Object({
							label: Type.String({ description: "Concise choice text (1-5 words)" }),
							description: Type.Optional(Type.String({ description: "What this choice means / trade-offs" })),
						}),
						{ minItems: 2, maxItems: 6, description: "2-6 distinct options ('Other' is added automatically)" },
					),
					multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options (default false)" })),
				}),
				{ minItems: 1, maxItems: 4 },
			),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const questions = params.questions as AskQuestion[];
			const id = toolCallId;

			let settle!: (answers: Answer[] | null) => void;
			const answered = new Promise<Answer[] | null>((r) => {
				let done = false;
				settle = (a) => {
					if (!done) {
						done = true;
						r(a);
					}
				};
			});
			pending.set(id, { id, questions, settle });

			// Turn abort (Esc) cancels the question everywhere.
			const tuiAbort = new AbortController();
			const onAbort = () => {
				tuiAbort.abort();
				settle(null);
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			// Web card (mobile.ts → SSE; notify.ts → ntfy push).
			pi.events.emit("pi-lab:ask-user", { id, questions });

			// TUI selector — only when a terminal is actually attached.
			if (process.stdout.isTTY) {
				void runTuiFlow(ctx, questions, tuiAbort.signal)
					.then((a) => {
						if (a) settle(a);
					})
					.catch(() => {
						// dialog machinery failed — web path stays live
					});
			}

			const answers = await answered;
			pending.delete(id);
			signal?.removeEventListener("abort", onAbort);
			tuiAbort.abort(); // dismiss a still-open TUI dialog if web answered first
			pi.events.emit("pi-lab:ask-user-resolved", { id, answered: answers !== null });

			if (!answers) return { content: [{ type: "text", text: "Question cancelled — the user aborted without answering." }], isError: true };
			const text = answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
			return { content: [{ type: "text", text }] };
		},
	});
}
