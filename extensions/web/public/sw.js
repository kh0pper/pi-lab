/**
 * Service Worker — App Shell caching strategy.
 *
 * Caches the app shell (HTML, manifest) for offline access.
 * API requests are always network-first (never cached).
 */

const CACHE_NAME = "pi-mobile-v3";

const APP_SHELL_URLS = [
	"/mobile",
	"/mobile/manifest.json",
];

// ── Install: pre-cache the app shell ─────────────────────────

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_URLS))
	);
	// Activate immediately — don't wait for old tabs to close
	self.skipWaiting();
});

// ── Activate: clean up old caches ────────────────────────────

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches.keys().then((keys) =>
			Promise.all(
				keys
					.filter((key) => key !== CACHE_NAME)
					.map((key) => caches.delete(key))
			)
		)
	);
	// Take control of all tabs immediately
	self.clients.claim();
});

// ── Fetch: network-first for API, cache-first for app shell ──

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);

	// API requests — always network, never cache
	if (url.pathname.startsWith("/api/")) {
		return;
	}

	// App shell — network-first, cache only as offline fallback. Cache-first
	// (even stale-while-revalidate) meant one full page load on stale UI
	// after every server-side app.html change — invisible breakage on phones.
	event.respondWith(
		fetch(event.request)
			.then((response) => {
				if (response.ok) {
					const copy = response.clone();
					event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)));
				}
				return response;
			})
			.catch(() => caches.match(event.request).then((cached) => cached ?? Response.error()))
	);
});
