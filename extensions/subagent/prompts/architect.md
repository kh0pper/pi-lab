---
description: Architect/editor implementation - a strong model designs the change, a cheap model applies it, reviewer checks
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "architect" agent to design the code change for: $@ — it produces a precise change proposal with per-file edit sketches (no edits).
2. Then, use the "editor" agent to apply the change proposal from the previous step exactly (use {previous} placeholder).
3. Finally, use the "reviewer" agent to review the applied changes against the original request "$@" and the proposal (use {previous} placeholder).

Execute this as a chain, passing output between steps via {previous}.
