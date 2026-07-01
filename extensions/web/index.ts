/**
 * web — pi-lab's vendored web stack (shared HTTP server + mobile PWA).
 *
 * Forked from @e9n/pi-webserver v0.2.0 and @e9n/pi-mobile v0.3.0 (MIT, Espen
 * Nilsen — see THIRD_PARTY.md). Vendored so we own the code: loopback-only
 * listen with an error handler (no EADDRINUSE crash), relative API base in the
 * PWA (path-prefix mountable behind pi-hub), one merged entry point, and a
 * bot guard.
 *
 * Replaces the npm:@e9n/pi-webserver + npm:@e9n/pi-mobile entries in
 * ~/.pi/agent/settings.json packages — NEVER load both this and the npm
 * copies at once (duplicate commands/mounts + a port race).
 *
 * Settings stay under the existing "pi-webserver" key:
 *   "pi-webserver": { "autostart": false, "port": 4100, "apiToken": "..." }
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { setupMobile } from "./mobile.ts";
import { setupWebserver } from "./webserver.ts";

export default function (pi: ExtensionAPI) {
	// Bot pi processes must never run web servers: they'd race for ports and
	// expose bot sessions over HTTP. Subagent children likewise.
	if (process.env["PI_BOT_PERMISSION_POLICY"]) return;
	if (Number(process.env["PIBOT_SUBAGENT_DEPTH"] ?? "0") >= 1) return;

	setupWebserver(pi);
	setupMobile(pi);
}
