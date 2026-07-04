/**
 * remote-ask.ts — race a blocking TUI dialog against a phone answer card.
 *
 * Shared by permission-gating / permission-modes (and mirrors the inline
 * implementation in plan-mode's what-next picker). Rides the ask_user bus
 * contract, so zero client code is needed:
 *
 *   emits    "pi-lab:ask-user"          { id, questions }   → PWA card + ntfy push
 *   handles  "pi-lab:ask-user-answer"   (settles on matching id, sets handled)
 *   handles  "pi-lab:ask-user-pending"  (MERGE — card survives reload/reconnect)
 *   emits    "pi-lab:ask-user-resolved" (dismisses cards everywhere)
 *
 * Semantics for permission use: the FIRST explicit answer wins (terminal or
 * phone); the losing dialog is dismissed (AbortSignal / resolved event).
 * Nothing else settles the race — permission questions require an explicit
 * answer. A TUI dismissal settles `undefined`; callers keep fail-closed
 * behavior by treating that as deny.
 *
 * NOT auto-loaded as an extension (subdir, not index.ts) — import only.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface RemoteOption {
	label: string;
	description?: string;
}

export function raceWithPhone(
	pi: ExtensionAPI,
	q: { question: string; header?: string; options: RemoteOption[] },
	runTui: (signal: AbortSignal) => Promise<string | undefined>,
): Promise<string | undefined> {
	const qid = `perm-${Math.random().toString(36).slice(2, 10)}`;
	const questions = [{ question: q.question, header: q.header ?? "Permission", options: q.options }];
	let settled = false;
	let settle!: (v: string | undefined) => void;
	const done = new Promise<string | undefined>((r) => {
		settle = (v) => {
			if (!settled) {
				settled = true;
				r(v);
			}
		};
	});
	const offAnswer = pi.events.on("pi-lab:ask-user-answer", (data) => {
		const d = (data ?? {}) as { id?: string; answers?: Array<{ answer?: string }>; handled?: boolean };
		if (d.id !== qid || !Array.isArray(d.answers)) return;
		d.handled = true;
		settle(String(d.answers[0]?.answer ?? ""));
	});
	const offPending = pi.events.on("pi-lab:ask-user-pending", (data) => {
		const d = (data ?? {}) as { pending?: Array<{ id: string; questions: unknown }> };
		if (!settled) d.pending = [...(d.pending ?? []), { id: qid, questions }];
	});
	const tuiAbort = new AbortController();
	pi.events.emit("pi-lab:ask-user", { id: qid, questions });
	void runTui(tuiAbort.signal)
		.then((c) => settle(c))
		.catch(() => settle(undefined));
	return done.then((choice) => {
		tuiAbort.abort();
		offAnswer();
		offPending();
		pi.events.emit("pi-lab:ask-user-resolved", { id: qid, answered: true });
		// Persist the exchange (not sent to the LLM) so the answered card
		// survives reloads — bus-only prompts otherwise leave no trace in
		// the session at all.
		if (choice !== undefined) {
			try {
				pi.appendEntry("pi-lab-remote-ask", { question: q.question, header: q.header ?? "Permission", options: q.options, answer: choice });
			} catch {
				// persistence is best-effort
			}
		}
		return choice;
	});
}
