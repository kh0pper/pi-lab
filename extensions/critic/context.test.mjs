import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Compile the pure module to ESM and import it.
const out = join(mkdtempSync(join(tmpdir(), "ctx-")), "context.mjs");
execFileSync("npx", ["esbuild", "extensions/critic/context.ts", `--outfile=${out}`, "--format=esm", "--log-level=warning"]);
const { selectSiblings } = await import(out);

const a = (n, c) => { if (!c) { console.error("FAIL", n); process.exit(1); } console.log("ok", n); };

const ls = [
  "src/routes/+page.svelte", "src/routes/+page.server.ts", "src/routes/+layout.svelte",
  "src/routes/tasks/+page.svelte", "src/routes/tasks/+page.server.ts",
  "src/lib/util.ts",
];

// touching +page.svelte surfaces its same-dir siblings, not itself, not other dirs
let s = selectSiblings(["src/routes/+page.svelte"], ls);
a("includes same-dir sibling", s.includes("src/routes/+page.server.ts"));
a("includes layout sibling", s.includes("src/routes/+layout.svelte"));
a("excludes the changed file itself", !s.includes("src/routes/+page.svelte"));
a("excludes other directories", !s.includes("src/routes/tasks/+page.server.ts"));

// a changed file with no siblings yields nothing
a("no siblings → empty", selectSiblings(["src/lib/util.ts"], ls).length === 0);

// siblings already in the diff are not repeated
s = selectSiblings(["src/routes/+page.svelte", "src/routes/+page.server.ts"], ls);
a("sibling already changed is excluded", !s.includes("src/routes/+page.server.ts"));

// lock/generated/binary siblings are filtered
const withJunk = ["pkg/index.ts", "pkg/package-lock.json", "pkg/logo.png", "pkg/helper.ts"];
s = selectSiblings(["pkg/index.ts"], withJunk);
a("lockfile filtered", !s.includes("pkg/package-lock.json"));
a("binary filtered", !s.includes("pkg/logo.png"));
a("real sibling kept", s.includes("pkg/helper.ts"));

// per-dir cap
const many = Array.from({ length: 20 }, (_, i) => `d/f${i}.ts`).concat(["d/changed.ts"]);
a("per-dir cap respected", selectSiblings(["d/changed.ts"], many, { maxPerDir: 6 }).length === 6);

console.log("ALL SIBLING TESTS PASS");
