#!/usr/bin/env python3
"""critic-gate-report — evaluate the tournament.auto FLIP CRITERION.

Reads ~/.pi/agent/critic-telemetry.jsonl and prints pass/fail/insufficient for
each of the six ROADMAP criteria ("THE FLIP CRITERION", docs/ROADMAP.md). All
six must hold over >=30 rows of normal use before tournament.auto flips to
true. Criterion 6 (fix-review regression) is not machine-decidable — the
report lists the fixReview rows for human review.

Usage: python3 scripts/critic-gate-report.py [path-to-telemetry.jsonl]
"""

import json
import os
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.pi/agent/critic-telemetry.jsonl")

MIN_ROWS = 30
MIN_PROBES = 8


def load(path):
    rows = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    except FileNotFoundError:
        print(f"no telemetry at {path}")
        sys.exit(1)
    return rows


def pct(n, d):
    return f"{100 * n / d:.0f}% ({n}/{d})" if d else "n/a (0 samples)"


def status(ok, insufficient=False):
    return "INSUFFICIENT DATA" if insufficient else ("PASS" if ok else "FAIL")


def main():
    rows = load(PATH)
    n = len(rows)
    print(f"critic-gate-report — {n} telemetry rows ({PATH})")
    print(f"row threshold: {'PASS' if n >= MIN_ROWS else f'INSUFFICIENT ({n}/{MIN_ROWS})'}\n")

    failures = 0

    # 1. inter-critic disagreement < 20% (rows with 2 parsed verdicts)
    two = [r for r in rows if len([v for v in r.get("verdicts", []) if not v.get("parseError")]) == 2]
    dis = [r for r in two if r.get("agree") is False]
    ok1 = len(two) > 0 and len(dis) / len(two) < 0.20
    print(f"1. inter-critic disagreement  {pct(len(dis), len(two))}  target <20%  -> {status(ok1, not two)}")
    failures += 0 if ok1 else 1

    # 2. >=70% of failed-runs-with-followup flip to pass (prior linkage)
    linked = [r for r in rows if r.get("prior")]
    flips = [r for r in linked if all(v.get("passed") for v in r.get("verdicts", []))]
    ok2 = len(linked) > 0 and len(flips) / len(linked) >= 0.70
    print(f"2. prior-linked flip-to-pass  {pct(len(flips), len(linked))}  target >=70%  -> {status(ok2, not linked)}")
    failures += 0 if ok2 else 1

    # 3. userSentFindings:false on < 30% of failed runs (false-positive proxy)
    failed = [r for r in rows if r.get("userSentFindings") is not None and not all(v.get("passed") for v in r.get("verdicts", []))]
    dismissed = [r for r in failed if r.get("userSentFindings") is False]
    ok3 = len(failed) > 0 and len(dismissed) / len(failed) < 0.30
    print(f"3. findings dismissed by user {pct(len(dismissed), len(failed))}  target <30%  -> {status(ok3, not failed)}")
    failures += 0 if ok3 else 1

    # 4. parseError rate < 10% (per verdict; recovered verdicts don't count as errors)
    verdicts = [v for r in rows for v in r.get("verdicts", [])]
    perr = [v for v in verdicts if v.get("parseError")]
    recovered = [v for v in verdicts if v.get("recovered")]
    ok4 = len(verdicts) > 0 and len(perr) / len(verdicts) < 0.10
    print(f"4. verdict parse-error rate   {pct(len(perr), len(verdicts))}  target <10%  -> {status(ok4, not verdicts)}"
          + (f"   [{len(recovered)} recovered by retry]" if recovered else ""))
    failures += 0 if ok4 else 1

    # 5. cross-model recall: >=8 probe/diverse rows, novel-blocker rate < 25%
    probes = [r for r in rows if r.get("source") == "probe" or (r.get("modelOverride") and r.get("prior"))]
    novel = [r for r in probes if any((v.get("blockers") or 0) > 0 for v in r.get("verdicts", []))]
    enough = len(probes) >= MIN_PROBES
    ok5 = enough and len(novel) / len(probes) < 0.25
    print(f"5. cross-model probes         {len(probes)}/{MIN_PROBES} rows; novel-blocker {pct(len(novel), len(probes))}  target <25%  -> {status(ok5, not enough)}")
    failures += 0 if ok5 else 1

    # 6. fix-review regression check — human judgment
    fr = [r for r in rows if r.get("fixReview")]
    print(f"6. fix-review rows for human regression review: {len(fr)}")
    for r in fr:
        passed = all(v.get("passed") for v in r.get("verdicts", []))
        print(f"   - ts={r.get('ts')} cwd={r.get('cwd')} passed={passed} sent={r.get('userSentFindings')}")
    print("   (criterion 6: zero cases where a fixReview run passed but the invariant was later found violated —")
    print("    one counterexample resets the clock; verify against your own knowledge of those changes)")

    print()
    if n < MIN_ROWS:
        print(f"VERDICT: keep tournament.auto OFF — only {n}/{MIN_ROWS} rows.")
    elif failures:
        print(f"VERDICT: keep tournament.auto OFF — {failures} criteria failing/insufficient.")
    else:
        print("VERDICT: criteria 1-5 hold. If criterion 6 also holds on review, flip tournament.auto")
        print("         (one line in extensions/tournament.ts) and record the evidence in docs/ROADMAP.md.")


if __name__ == "__main__":
    main()
