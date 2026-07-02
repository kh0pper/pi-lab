---
description: Analyze this repository and create/update its AGENTS.md context file
---

Analyze this repository and write an `AGENTS.md` file at its root (pi reads AGENTS.md or CLAUDE.md automatically at session start — prefer AGENTS.md; if a CLAUDE.md already exists, fold its still-true content in and note that AGENTS.md is now canonical).

Explore first — do not guess:
1. Read the README, package/build manifests, and directory layout.
2. Identify: what the project is, how to build/run/test it (exact commands), the architecture in a few sentences, and any non-obvious conventions or footguns an agent must respect.
3. Check git history for conventions (commit style, branch habits).

Then write AGENTS.md with these qualities:
- Short enough to read in one screenful; every line earns its place.
- Exact commands, not descriptions of commands.
- Non-obvious constraints ("don't X because Y") beat restating what code shows.
- No aspirational fluff, no boilerplate headers without content.

If an AGENTS.md already exists, update it: verify each existing claim against the current code, fix what drifted, and add what's missing.

$@
