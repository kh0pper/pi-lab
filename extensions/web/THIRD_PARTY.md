# Third-party code in extensions/web/

This directory is a vendored fork of two MIT-licensed packages by Espen
Nilsen (`github.com/espennilsen/pi`), absorbed into pi-lab on 2026-07-01 so
the web stack can be reshaped freely (multi-session hub, unified design):

- **@e9n/pi-webserver v0.2.0** → `webserver.ts` (was `src/index.ts`),
  `server.ts`, `helpers.ts`, `logger.ts`, `dashboard.html`
- **@e9n/pi-mobile v0.3.0** → `mobile.ts` (was `src/index.ts`), `public/`

Original license: `LICENSE.pi-webserver` (MIT). Both packages declared no
runtime dependencies.

Notable divergences from upstream (grow over time):

- `server.ts`: `listen(port, "127.0.0.1")` + an `error` handler — loopback
  only, no process crash on EADDRINUSE.
- `index.ts` (new): single merged entry for both halves, with a guard that
  no-ops in bot pi processes and subagent children.
- `public/app.html`: API base derived from `location.pathname` instead of
  hardcoded absolute `/api/mobile` paths, so the UI works behind a
  path-prefix reverse proxy (pi-hub `/s/<id>/…`).
- `server.ts`: dropped upstream's blanket `Access-Control-Allow-Origin: *` —
  everything is same-origin now; cross-host PWA connect would need an
  explicit origin allowlist.
