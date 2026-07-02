/**
 * remote-register — makes every interactive pi session visible to the local
 * pi-hub daemon (hub/server.mjs).
 *
 * On session_start: POST /register to the hub's loopback registry with
 * {pid, sessionId, sessionFile, cwd, name}; the hub replies with a port from
 * its pool, and we start this process's web server on it via the
 * "command:web" bus event (vendored extensions/web handles it — no TUI
 * needed). Heartbeats re-register every 30s (idempotent upsert, so a hub
 * restart repopulates within one beat); session_shutdown unregisters.
 *
 * OPT-IN per machine: does nothing unless settings.json configures
 *   "remoteRegister": { "hubUrl": "http://127.0.0.1:4201" }
 * (the hub's REGISTRY listener — loopback-only, never behind Tailscale Serve).
 *
 * Never registers bot pi processes (PI_BOT_PERMISSION_POLICY) or subagent
 * children (PIBOT_SUBAGENT_DEPTH >= 1) — bot traffic would exhaust the hub's
 * port pool and expose bot sessions. All hub calls are fire-and-forget with
 * short timeouts: a down hub must never affect the session.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function hubUrl(): string | null {
	const settingsPath = resolve(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(settingsPath)) return null;
	try {
		const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			remoteRegister?: { hubUrl?: string; enabled?: boolean };
		};
		if (raw.remoteRegister?.enabled === false) return null;
		return raw.remoteRegister?.hubUrl ?? null;
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	if (process.env["PI_BOT_PERMISSION_POLICY"]) return;
	if (Number(process.env["PIBOT_SUBAGENT_DEPTH"] ?? "0") >= 1) return;

	const url = hubUrl();
	if (!url) return;
	const base = url.replace(/\/+$/, "");

	let webStarted = false;
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let payload: Record<string, unknown> | null = null;
	let nameFn: (() => string) | null = null;

	async function register(): Promise<void> {
		if (!payload) return;
		// Re-derive the display name each beat — a mid-session rename
		// (pi.setSessionName / the PWA's Rename button) reaches the hub within
		// one heartbeat via the idempotent upsert.
		if (nameFn) payload.name = nameFn();
		try {
			const res = await fetch(`${base}/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(2000),
			});
			if (!res.ok) return;
			const { port } = (await res.json()) as { port?: number };
			if (port && !webStarted) {
				// Start this session's web server on the hub-assigned port.
				pi.events.emit("command:web", { args: String(port) });
				webStarted = true;
			}
		} catch {
			// hub down — try again on the next heartbeat
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		let sessionId = "";
		let sessionFile = "";
		try {
			sessionId = ctx.sessionManager.getSessionId?.() ?? "";
			sessionFile = ctx.sessionManager.getSessionFile?.() ?? "";
		} catch {
			// no session persistence (--no-session) — still register, just unnamed
		}
		const cwd = ctx.cwd ?? process.cwd();
		nameFn = () => {
			try {
				return ctx.sessionManager.getSessionName?.() || basename(cwd);
			} catch {
				return basename(cwd);
			}
		};
		payload = {
			pid: process.pid,
			sessionId,
			sessionFile,
			cwd,
			name: nameFn(),
		};
		await register();
		if (!heartbeat) {
			heartbeat = setInterval(() => void register(), 30_000);
			heartbeat.unref?.();
		}
	});

	pi.on("session_shutdown", async () => {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = null;
		try {
			await fetch(`${base}/unregister`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pid: process.pid }),
				signal: AbortSignal.timeout(1000),
			});
		} catch {
			// hub sweeps dead pids anyway
		}
	});
}
