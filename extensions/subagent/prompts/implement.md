---
description: Full implementation workflow - scout gathers context, architect designs precise edits, editor applies them
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "scout" agent to find all code relevant to: $@
2. Then, use the "architect" agent to design the code change for "$@" using the context from the previous step (use {previous} placeholder) — it produces a precise per-file edit proposal, no edits.
3. Finally, use the "editor" agent to apply the change proposal from the previous step exactly (use {previous} placeholder).

Execute this as a chain, passing output between steps via {previous}.

(The architect/editor split is the default because it measurably improves edit quality on local models — the strong model spends capacity on the solution, the cheap model on edit formatting. For the old single-worker path use /implement-worker.)
