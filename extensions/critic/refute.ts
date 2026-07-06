/**
 * refute.ts — refuter verdict contract, parser, and downgrade logic (1C).
 * PURE: no pi imports.
 *
 * FAIL-OPEN-TO-BLOCKER: unlike the leg verdict (which fails open to success),
 * a refuter that produces no clean verdict leaves the blocker STANDING. A
 * broken/uncertain refuter must never erase a real blocker. `refuted: true`
 * additionally requires strict keys (⊆ {refuted, reason}) — the refuter has
 * read/bash tools and can quote arbitrary JSON into its transcript; unrelated
 * JSON must not erase a blocker.
 *
 * FAIL-CLOSED PARSE ERRORS: applyRefutations never sets `passed: true` on a
 * verdict carrying `parseError` — "unparseable output counts as FAILED" holds
 * no matter what gets refuted.
 */

export const REFUTER_INSTRUCTION =
	"\n\nEnd your reply with exactly one fenced JSON block, nothing after it:\n" +
	"```json\n" +
	'{"refuted": true|false, "reason": "one line — why the blocker is wrong, or why it stands"}\n' +
	"```\n" +
	'Set "refuted": true ONLY if you found a concrete reason the blocker is wrong (behavior ' +
	"implemented in another file, a framework mechanism that handles it, an existing test that " +
	"covers it, a false assumption about runtime). If you are unsure, set false — do not refute on vibes.";

export interface RefutableFinding {
	category?: string;
	severity?: string;
	detail?: string;
	/** Set by applyRefutations — lets the sidecar filter disproven findings. */
	refuted?: boolean;
}

export interface RefutableVerdict {
	passed: boolean;
	findings: RefutableFinding[];
	parseError?: string;
}

function tryParse(raw: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(raw);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Pick the model the refuters run on — MUST differ from the model that raised
 * the blockers (same-model refutes lose the diversity that makes the pass
 * meaningful). No hardcoded lab model: the "other" model is derived from the
 * managed-local list when the diverse default collides with the main model.
 * Returns null when no distinct model exists → caller skips the refute-pass.
 */
export function resolveRefuteModel(opts: {
	/** Model the critics actually ran on (from their verdicts), when known. */
	mainModel: string | null | undefined;
	/** Explicit critic.refuteModel config, when set. */
	configured?: string;
	/** critic.diverseModel (or its default) — the preferred refute model. */
	diverse: string;
	/** Object.keys(settings.localModels) in declaration order. */
	managedRefs: string[];
}): string | null {
	const { mainModel, configured, diverse, managedRefs } = opts;
	if (configured && configured !== mainModel) return configured;
	if (diverse !== mainModel) return diverse;
	return managedRefs.find((r) => r !== mainModel) ?? null;
}

export function parseRefuterVerdict(output: string): { refuted: boolean; reason?: string } {
	const blocks = [...output.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)];
	for (let i = blocks.length - 1; i >= 0; i--) {
		const obj = tryParse(blocks[i][1].trim());
		if (!obj || typeof obj.refuted !== "boolean") continue;
		if (obj.refuted === true) {
			// strict keys on the fail-dangerous direction only
			const keys = Object.keys(obj);
			if (keys.length > 2 || !keys.every((k) => k === "refuted" || k === "reason")) continue;
		}
		return { refuted: obj.refuted, reason: typeof obj.reason === "string" ? obj.reason : undefined };
	}
	// no clean verdict → blocker stands
	return { refuted: false };
}

/**
 * Apply refutation results: downgrade refuted findings in place (blocker →
 * warn, mark `refuted`, prefix the rebuttal) and recompute each touched
 * verdict's `passed` = "no blockers remain AND no parseError". Returns the
 * refutation list with PRE-mutation details (for telemetry/display).
 *
 * INTENDED SEMANTICS: recomputation overrides the critic's own `passed` —
 * warns never contribute to failure anywhere downstream (the verdict contract
 * keys `passed` on blockers only), so a verdict whose every blocker was
 * refuted correctly flips to passed. Everything downstream (confirm prompt,
 * fix-review sidecar arming, tournament trigger) keys off this recomputed state.
 */
export function applyRefutations(
	verdicts: Array<{ agent: string; verdict: RefutableVerdict }>,
	results: Array<{ agent: string; finding: RefutableFinding; refuted: boolean; reason: string }>,
): Array<{ agent: string; detail: string; reason: string }> {
	const refuted: Array<{ agent: string; detail: string; reason: string }> = [];
	const touched = new Set<RefutableVerdict>();
	for (const r of results) {
		if (!r.refuted) continue;
		refuted.push({ agent: r.agent, detail: (r.finding.detail ?? "").slice(0, 300), reason: r.reason });
		r.finding.severity = "warn";
		r.finding.refuted = true;
		r.finding.detail = `[refuted: ${r.reason}] ${r.finding.detail ?? ""}`;
		const owner = verdicts.find((v) => v.verdict.findings.includes(r.finding));
		if (owner) touched.add(owner.verdict);
	}
	for (const v of touched) {
		const blockers = v.findings.filter((f) => f.severity === "blocker").length;
		v.passed = blockers === 0 && !v.parseError;
	}
	return refuted;
}
