/**
 * context.ts — sibling-file selection for critic route-bundle context (1B).
 * PURE: no pi imports, so the loader gate stays meaningful and this is unit-testable.
 */

export const SIBLING_MAX_PER_DIR = 6;

/** Lock/generated/binary siblings a critic gains nothing from. */
export const SIBLING_SKIP_RE =
	/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.(min\.(js|css)|map|png|jpe?g|gif|ico|webp|avif|bmp|woff2?|ttf|otf|eot|wasm|gz|zip|pdf|mp[34]|mov|webm|db|sqlite|lockb)$/i;

function dirOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i === -1 ? "" : p.slice(0, i);
}

/**
 * Repo-relative files in the same directory as a changed file, excluding the
 * changed files themselves and lock/generated/binary files, deduped, capped
 * per directory. Behavior that spans a framework's file-group (SvelteKit
 * +page.svelte / +page.server.ts, …) is surfaced so a critic reviewing one
 * half sees the other.
 */
export function selectSiblings(
	changedFiles: string[],
	lsFiles: string[],
	opts: { maxPerDir?: number } = {},
): string[] {
	const maxPerDir = opts.maxPerDir ?? SIBLING_MAX_PER_DIR;
	const changed = new Set(changedFiles);
	const dirs = new Set(changedFiles.map(dirOf));
	const out: string[] = [];
	const perDir = new Map<string, number>();
	const seen = new Set<string>();
	for (const f of lsFiles) {
		const d = dirOf(f);
		if (!dirs.has(d) || changed.has(f) || seen.has(f) || SIBLING_SKIP_RE.test(f)) continue;
		const n = perDir.get(d) ?? 0;
		if (n >= maxPerDir) continue;
		perDir.set(d, n + 1);
		seen.add(f);
		out.push(f);
	}
	return out;
}
