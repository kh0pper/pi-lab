/**
 * pi-mobile — PWA mobile app for Pi agents.
 *
 * Mounts on pi-webserver (pi-lab fork — Perch session UI):
 *   Page: /mobile               — PWA app shell (Chat / Session / Files / Activity)
 *   Page: /mobile/manifest.json — PWA manifest
 *   Page: /mobile/sw.js         — Service worker
 *   API:  /api/mobile/health    — Health check
 *   API:  /api/mobile/chat/*    — prompt submission (auto-routes /commands), SSE events
 *   API:  /api/mobile/status    — agent status incl. model / idle / plan-mode state
 *   API:  /api/mobile/models    — available models (plan-mode chip picker)
 *   API:  /api/mobile/files/*   — workspace file browser
 *   API:  /api/mobile/logs/*    — tool-activity SSE
 *   API:  /api/mobile/skills, /extensions — read-only lists
 *
 * Upstream's td/crm/calendar/cron proxies were removed: they shelled out to
 * CLIs from the original author's personal toolkit that don't exist here.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExtensionAPI, ExtensionContext, SlashCommandInfo } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { annotate, readLocalModels, startModel } from "../../lib/local-models.mjs";
import { readSessionMeta, setSessionArchived } from "../../lib/sessions.mjs";

// ── Static files ─────────────────────────────────────────────

const PUBLIC_DIR = path.resolve(import.meta.dirname, "public");

function readPublicFile(filePath: string): string {
	return fs.readFileSync(path.join(PUBLIC_DIR, filePath), "utf-8");
}

const APP_HTML = readPublicFile("app.html");
const MANIFEST_JSON = readPublicFile("manifest.json");
const SW_JS = readPublicFile("sw.js");

/** Cache for screen JS modules — loaded lazily on first request. */
const screenCache = new Map<string, string>();

function getScreenJs(name: string): string | null {
	if (screenCache.has(name)) return screenCache.get(name)!;
	const screensDir = path.join(PUBLIC_DIR, "screens");
	const filePath = path.join(screensDir, `${name}.js`);
	// Prevent path traversal — must stay within screens directory
	if (!filePath.startsWith(screensDir + path.sep) && filePath !== screensDir) return null;
	if (!fs.existsSync(filePath)) return null;
	const content = fs.readFileSync(filePath, "utf-8");
	screenCache.set(name, content);
	return content;
}

// ── HTTP helpers ─────────────────────────────────────────────

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
	res.writeHead(status, { "Content-Type": contentType });
	res.end(body);
}

function json(res: ServerResponse, status: number, data: unknown): void {
	send(res, status, "application/json; charset=utf-8", JSON.stringify(data));
}

function readBody(req: IncomingMessage, maxSize?: number): Promise<string> {
	const MAX_SIZE = maxSize ?? 1024 * 1024; // 1 MB default
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let totalSize = 0;
		req.on("data", (c: Buffer) => {
			totalSize += c.length;
			if (totalSize > MAX_SIZE) {
				req.destroy();
				reject(new Error("Request body too large"));
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

// ── Slash command routing ─────────────────────────────────────

/** Parse a slash command string into name and args. */
function parseCommand(text: string): { name: string; args: string } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;

	if (trimmed.startsWith("/skill:")) {
		const rest = trimmed.slice(7);
		const spaceIndex = rest.indexOf(" ");
		if (spaceIndex === -1) return { name: `skill:${rest}`, args: "" };
		return { name: `skill:${rest.slice(0, spaceIndex)}`, args: rest.slice(spaceIndex + 1) };
	}

	const spaceIndex = trimmed.indexOf(" ");
	if (spaceIndex === -1) return { name: trimmed.slice(1), args: "" };
	return { name: trimmed.slice(1, spaceIndex), args: trimmed.slice(spaceIndex + 1) };
}

/** Strip YAML frontmatter from file content. */
function stripFrontmatter(content: string): string {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) return content;
	return content.slice(match[0].length);
}

/** Bash-style argument parsing — respects quoted strings. */
function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;
	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === ' ' || char === '\t') {
			if (current) { args.push(current); current = ""; }
		} else {
			current += char;
		}
	}
	if (current) args.push(current);
	return args;
}

/** Substitute $1, $@, $ARGUMENTS, ${@:N}, ${@:N:L} in template content. */
function substituteArgs(content: string, args: string[]): string {
	let result = content;
	result = result.replace(/\$(\d+)/g, (_, num: string) => args[parseInt(num, 10) - 1] ?? "");
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr: string, lengthStr?: string) => {
		let start = parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) return args.slice(start, start + parseInt(lengthStr, 10)).join(" ");
		return args.slice(start).join(" ");
	});
	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	return result;
}

/** Determine how to route a slash command. */
function routeCommand(text: string, commands: SlashCommandInfo[]): {
	action: "event-bus" | "expand-and-send" | "unknown";
	eventName?: string;
	expandedText?: string;
	info?: SlashCommandInfo;
} {
	const parsed = parseCommand(text);
	if (!parsed) return { action: "unknown" };

	const cmd = commands.find(c => c.name === parsed.name);
	if (!cmd) return { action: "unknown" };

	if (cmd.source === "extension") {
		return { action: "event-bus", eventName: `command:${parsed.name}`, info: cmd };
	}

	if (cmd.source === "skill") {
		try {
			const content = fs.readFileSync(cmd.sourceInfo.path, "utf-8");
			const body = stripFrontmatter(content).trim();
			const baseDir = cmd.sourceInfo.baseDir || cmd.sourceInfo.path.replace(/\/[^\/]+$/, "");
			const block = `<skill name="${parsed.name.replace("skill:", "")}" location="${cmd.sourceInfo.path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
			return { action: "expand-and-send", expandedText: parsed.args ? `${block}\n\n${parsed.args}` : block, info: cmd };
		} catch {
			return { action: "unknown" };
		}
	}

	if (cmd.source === "prompt") {
		try {
			const content = fs.readFileSync(cmd.sourceInfo.path, "utf-8");
			const body = stripFrontmatter(content).trim();
			const args = parseCommandArgs(parsed.args);
			return { action: "expand-and-send", expandedText: substituteArgs(body, args), info: cmd };
		} catch {
			return { action: "unknown" };
		}
	}

	return { action: "unknown" };
}

// ── API: Chat ────────────────────────────────────────────────

let _pi: ExtensionAPI | null = null;
/** Last-seen extension context — used to report model/idle state (pi-lab fork). */
let _lastCtx: ExtensionContext | null = null;
/** Mirrored plan-mode state (bus: "plan-mode:state"). */
let _planState: { enabled: boolean; executing: boolean; todosDone: number; todosTotal: number } | null = null;
/** provider/id of a local model server currently being started, if any. */
let _modelStarting: string | null = null;
/** Mirrored permission mode (bus: "perm-mode:state"). */
let _permMode: string | null = null;

/** Files the agent sent to the user via the send_user_file tool: id → meta. */
const _sentFiles = new Map<string, { path: string; name: string; mime: string; size: number }>();

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
	".txt": "text/plain", ".md": "text/markdown", ".html": "text/html", ".json": "application/json",
	".csv": "text/csv", ".log": "text/plain", ".zip": "application/zip", ".mp4": "video/mp4",
};
function guessMime(p: string): string {
	return MIME_BY_EXT[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}

/** Access log for remote-debugging phone/PWA behavior — which client build
 * hit which endpoint when. Fire-and-forget appends; ~/.pi/agent/mobile-access.log. */
const ACCESS_LOG = path.join(process.env["HOME"] ?? "/tmp", ".pi", "agent", "mobile-access.log");
function logAccess(req: IncomingMessage, note: string): void {
	try {
		const url = new URL(req.url ?? "/", "http://x");
		const b = url.searchParams.get("b") ?? "-";
		const ua = String(req.headers["user-agent"] ?? "").slice(0, 60);
		fs.appendFile(ACCESS_LOG, `${new Date().toISOString()} ${note} b=${b} ua="${ua}"\n`, () => {});
	} catch {
		// never let logging break a request
	}
}

/** Active SSE client connections. */
const sseClients = new Set<ServerResponse>();
/** Active log SSE client connections. */
const logClients = new Set<ServerResponse>();

/** Broadcast a log entry to connected log SSE clients. */
function broadcastLog(data: unknown): void {
	const payload = `data: ${JSON.stringify(data)}\n\n`;
	for (const res of logClients) {
		if (!res.writable) { logClients.delete(res); continue; }
		try { res.write(payload); } catch { logClients.delete(res); }
	}
}

/** Broadcast an event to all connected SSE clients. */
function broadcast(data: unknown): void {
	const payload = `data: ${JSON.stringify(data)}\n\n`;
	for (const res of sseClients) {
		if (!res.writable) { sseClients.delete(res); continue; }
		try { res.write(payload); } catch { sseClients.delete(res); }
	}
}

async function handleChatApi(req: IncomingMessage, res: ServerResponse, subPath: string): Promise<void> {
	// GET /commands — list available slash commands
	if (subPath === "/commands" && req.method === "GET") {
		if (!_pi) { json(res, 503, { error: "Agent not ready" }); return; }
		const commands = _pi.getCommands();
		json(res, 200, { commands });
		return;
	}

	// POST /prompt — submit a prompt (handles slash commands; images allowed → 40MB cap)
	if (subPath === "/prompt" && req.method === "POST") {
		logAccess(req, "prompt");
		try {
			const body = JSON.parse(await readBody(req, 40 * 1024 * 1024));
			if (!_pi) { json(res, 503, { error: "Agent not ready" }); return; }
			const prompt = body.prompt;
			if (!prompt || typeof prompt !== "string") {
				json(res, 400, { error: "Missing 'prompt' string in request body" });
				return;
			}

			// Web-initiated turn: notify.ts pushes when the reply is ready,
			// regardless of run duration (Claude-remote behavior).
			_pi.events.emit("pi-lab:web-prompt", {});

			// Route slash commands through event bus or expansion
			if (prompt.trim().startsWith("/")) {
				const commands = _pi.getCommands();
				const route = routeCommand(prompt.trim(), commands);

				// Unknown command-shaped input must NOT fall through to the model
				// as plain text — it will freelance (e.g. "/todos" once triggered a
				// crow-tasks MCP dump of the whole lab task DB). Paths like
				// "/etc/hosts" (name contains "/") still pass through as prose.
				const parsedName = parseCommand(prompt.trim())?.name ?? "";
				if (route.action === "unknown" && parsedName && !parsedName.includes("/")) {
					json(res, 404, { error: `Unknown command: /${parsedName} — type / to see available commands` });
					return;
				}

				if (route.action === "event-bus") {
					// Extension command — emit on event bus
					const parsed = parseCommand(prompt.trim())!;
					_pi.events.emit(route.eventName!, { args: parsed.args });
					broadcast({ type: "command_dispatched", command: parsed.name, args: parsed.args, time: new Date().toISOString() });
					json(res, 200, { ok: true, dispatched: true, command: parsed.name, source: "extension" });
					return;
				}

				if (route.action === "expand-and-send") {
					// Skill or prompt template — expand and send as user message
					_pi.sendUserMessage(route.expandedText!);
					const parsed = parseCommand(prompt.trim())!;
					broadcast({ type: "command_dispatched", command: parsed.name, args: parsed.args, time: new Date().toISOString() });
					json(res, 200, { ok: true, dispatched: true, command: parsed.name, source: route.info?.source });
					return;
				}
			}

			// Regular prompt — no matching slash command. Images (pi-lab fork)
			// ride the message as native ImageContent so vision models see
			// them directly, exactly like pasting into the terminal.
			const images = Array.isArray(body.images) ? (body.images as Array<{ dataBase64?: string; mimeType?: string }>) : [];
			const imageBlocks = images
				.filter((i) => i?.dataBase64 && i?.mimeType?.startsWith("image/"))
				.slice(0, 8)
				.map((i) => ({ type: "image" as const, data: i.dataBase64 as string, mimeType: i.mimeType as string }));
			if (imageBlocks.length > 0) {
				_pi.sendUserMessage([{ type: "text", text: prompt }, ...imageBlocks]);
			} else {
				_pi.sendMessage(
					{
						customType: "mobile-prompt",
						content: `📱 **Mobile:** ${prompt}`,
						display: true,
					},
					{ triggerTurn: true },
				);
			}
			json(res, 200, { ok: true, message: "Prompt submitted" });
		} catch {
			json(res, 400, { error: "Invalid JSON body" });
		}
		return;
	}

	// GET /history — recent conversation for page load / SSE reconnect
	// (pi-lab fork: without this, replies that arrive while the phone tab is
	// backgrounded are simply never seen).
	if (subPath === "/history" && req.method === "GET") {
		logAccess(req, "history");
		try {
			const entries = (_lastCtx?.sessionManager.getEntries?.() ?? []) as Array<{
				type: string;
				customType?: string;
				content?: unknown;
				message?: { role?: string; content?: unknown };
			}>;
			const out: Array<{ kind: string; text?: string; [k: string]: unknown }> = [];
			for (const e of entries) {
				// Phone-submitted prompts are custom_message entries (customType
				// "mobile-prompt"), NOT role:"user" messages — without this branch
				// the user's own messages vanish from the chat on every reload.
				if (e.type === "custom_message" && e.customType === "mobile-prompt" && typeof e.content === "string") {
					const t = e.content.replace(/^📱 \*\*Mobile:\*\* /, "").trim();
					if (t) out.push({ kind: "user", text: t });
					continue;
				}
				if (e.type !== "message" || !e.message) continue;
				const { role, content } = e.message;
				let text = "";
				if (typeof content === "string") text = content;
				else if (Array.isArray(content)) {
					text = (content as Array<{ type?: string; text?: string }>)
						.filter((b) => b?.type === "text" && typeof b.text === "string")
						.map((b) => b.text)
						.join("\n");
					const imgs = (content as Array<{ type?: string }>).filter((b) => b?.type === "image").length;
					if (imgs) text = `${text}  📷×${imgs}`.trim();
				}
				if (text.trim()) {
					if (role === "user") out.push({ kind: "user", text: text.trim() });
					else if (role === "assistant") out.push({ kind: "agent", text: text.trim() });
				}
				// send_user_file calls re-render as file cards INLINE, at their
				// original position in the conversation (they used to be tacked
				// onto the end after reloads). Files whose registration died
				// with a previous server process are re-registered by path, so
				// mockup cards survive session restarts too.
				if (role === "assistant" && Array.isArray(content)) {
					for (const b of content as Array<{ type?: string; name?: string; arguments?: { path?: string; caption?: string } }>) {
						if (b?.type !== "toolCall" || b.name !== "send_user_file" || !b.arguments?.path) continue;
						const resolved = path.isAbsolute(b.arguments.path) ? b.arguments.path : path.resolve(_cwd, b.arguments.path);
						let id: string | null = null;
						for (const [k, v] of _sentFiles) if (v.path === resolved) id = k; // latest registration wins
						if (!id) {
							try {
								const st = fs.statSync(resolved);
								if (!st.isDirectory()) {
									id = randomBytes(24).toString("base64url");
									_sentFiles.set(id, { path: resolved, name: path.basename(resolved), mime: guessMime(resolved), size: st.size });
									if (_sentFiles.size > 100) _sentFiles.delete(_sentFiles.keys().next().value!);
								}
							} catch {
								// file no longer on disk — no card
							}
						}
						if (id) {
							const meta = _sentFiles.get(id)!;
							out.push({ kind: "file", id, name: meta.name, mime: meta.mime, size: meta.size, caption: b.arguments.caption ?? "" });
						}
					}
				}
			}
			// Unanswered ask_user questions re-render as live cards after a
			// reload/reconnect (answered synchronously by ask-user.ts).
			const q: { pending?: Array<{ id: string; questions: unknown }> } = {};
			_pi?.events.emit("pi-lab:ask-user-pending", q);
			json(res, 200, { messages: out.slice(-60), pendingAsk: q.pending ?? [] });
		} catch (err) {
			json(res, 200, { messages: [], error: String((err as Error).message ?? err) });
		}
		return;
	}

	// POST /answer — reply to a pending ask_user question card. Body:
	// { id, answers: [{ question, answer }] }. Routed to ask-user.ts over the
	// bus; it settles the blocked tool call (synchronous fill: `handled`).
	if (subPath === "/answer" && req.method === "POST") {
		try {
			const body = JSON.parse(await readBody(req)) as { id?: string; answers?: unknown; handled?: boolean };
			if (!body.id || !Array.isArray(body.answers)) { json(res, 400, { error: "id and answers[] required" }); return; }
			if (!_pi) { json(res, 503, { error: "Agent not ready" }); return; }
			_pi.events.emit("pi-lab:ask-user-answer", body);
			if (!body.handled) { json(res, 404, { error: "question expired or already answered" }); return; }
			json(res, 200, { ok: true });
		} catch {
			json(res, 400, { error: "Invalid JSON body" });
		}
		return;
	}

	// SSE stream — broadcast agent events to connected mobile clients
	if (subPath === "/events" && req.method === "GET") {
		logAccess(req, "events-open");
		req.on("close", () => logAccess(req, "events-close"));
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.write(`data: ${JSON.stringify({ type: "connected", time: new Date().toISOString() })}\n\n`);

		// Register this SSE connection for broadcast
		sseClients.add(res);

		// Keepalive ping every 15s — a real data event, NOT an SSE comment:
		// comments never reach EventSource.onmessage, so the client can't
		// tell a healthy-quiet stream from a zombie connection after the
		// phone froze the tab. The client reconnects when pings go stale.
		const keepalive = setInterval(() => {
			if (!res.writable) { clearInterval(keepalive); return; }
			try { res.write(`data: {"type":"ping"}\n\n`); } catch { clearInterval(keepalive); sseClients.delete(res); }
		}, 15_000);

		req.on("close", () => {
			clearInterval(keepalive);
			sseClients.delete(res);
		});
		return;
	}

	json(res, 404, { error: "Not found" });
}

// ── API: Files ───────────────────────────────────────────────

let _cwd = process.cwd();

const SKIP_DIRS = new Set(["node_modules", ".git", ".todos", "dist", "build", ".next", ".nuxt", "__pycache__"]);

function safeResolvePath(requestedPath: string): string | null {
	const resolved = path.resolve(_cwd, requestedPath);
	// Prevent path traversal — must stay within cwd
	if (!resolved.startsWith(_cwd + path.sep) && resolved !== _cwd) return null;
	// Dereference symlinks to prevent sandbox escape
	try {
		const real = fs.realpathSync(resolved);
		if (!real.startsWith(_cwd + path.sep) && real !== _cwd) return null;
		return real;
	} catch {
		// Path doesn't exist yet (e.g. new file write) — allow if logical path is valid
		return resolved;
	}
}

async function handleFilesApi(req: IncomingMessage, res: ServerResponse, subPath: string): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");
	const filePath = url.searchParams.get("path") ?? "/";

	// GET /list?path=/ — list directory contents
	if ((subPath === "/list" || subPath === "") && req.method === "GET") {
		const resolved = safeResolvePath(filePath);
		if (!resolved) { json(res, 400, { error: "Invalid path" }); return; }

		try {
			const stat = fs.statSync(resolved);
			if (!stat.isDirectory()) { json(res, 400, { error: "Not a directory" }); return; }

			const entries = fs.readdirSync(resolved, { withFileTypes: true });
			const items = entries
				.filter(e => !SKIP_DIRS.has(e.name))
				.map(e => {
					const fullPath = path.join(resolved, e.name);
					const relativePath = path.relative(_cwd, fullPath);
					try {
						const s = fs.statSync(fullPath);
						return {
							name: e.name,
							path: relativePath,
							type: e.isDirectory() ? "directory" : "file",
							size: e.isDirectory() ? 0 : s.size,
							modified: s.mtime.toISOString(),
						};
					} catch {
						return { name: e.name, path: relativePath, type: e.isDirectory() ? "directory" : "file", size: 0, modified: "" };
					}
				})
				.sort((a, b) => {
					if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
					return a.name.localeCompare(b.name);
				});

			json(res, 200, { path: path.relative(_cwd, resolved) || ".", items });
		} catch {
			json(res, 404, { error: "Directory not found" });
		}
		return;
	}

	// GET /read?path=src/index.ts — read file content
	if (subPath === "/read" && req.method === "GET") {
		const resolved = safeResolvePath(filePath);
		if (!resolved) { json(res, 400, { error: "Invalid path" }); return; }

		try {
			const stat = fs.statSync(resolved);
			if (stat.isDirectory()) { json(res, 400, { error: "Is a directory" }); return; }
			if (stat.size > 512 * 1024) { json(res, 400, { error: "File too large (max 512KB)" }); return; }
			const content = fs.readFileSync(resolved, "utf-8");
			json(res, 200, { path: path.relative(_cwd, resolved), content, size: stat.size });
		} catch {
			json(res, 404, { error: "File not found" });
		}
		return;
	}

	json(res, 404, { error: "Not found" });
}

// ── Route handlers ───────────────────────────────────────────

function handlePage(req: IncomingMessage, res: ServerResponse, subPath: string): void {
	const p = subPath.replace(/\/+$/, "") || "/";

	switch (p) {
		case "/":
			logAccess(req, "shell");
			send(res, 200, "text/html; charset=utf-8", APP_HTML);
			return;
		case "/manifest.json":
			send(res, 200, "application/manifest+json; charset=utf-8", MANIFEST_JSON);
			return;
		case "/sw.js":
			logAccess(req, "sw.js");
			send(res, 200, "application/javascript; charset=utf-8", SW_JS);
			return;
		default:
			// Screen JS modules: /mobile/screens/chat.js → public/screens/chat.js
			if (p.startsWith("/screens/") && p.endsWith(".js")) {
				const screenName = p.slice("/screens/".length, -3);
				// Reject screen names with path traversal attempts
				if (screenName.includes("/") || screenName.startsWith("..")) {
					send(res, 404, "text/plain", "Not found");
					return;
				}
				const content = getScreenJs(screenName);
				if (content) {
					send(res, 200, "application/javascript; charset=utf-8", content);
					return;
				}
			}
			// SPA fallback
			send(res, 200, "text/html; charset=utf-8", APP_HTML);
			return;
	}
}

async function handleApi(req: IncomingMessage, res: ServerResponse, subPath: string): Promise<void> {
	const p = subPath.replace(/\/+$/, "") || "/";

	// Health check
	if (p === "/health") {
		json(res, 200, { status: "ok", version: "0.1.0", timestamp: new Date().toISOString() });
		return;
	}

	// Upload API (pi-lab fork) — send the session a file (screenshot, log, …)
	// like Claude Code remote. Body: {name, dataBase64}. Saved under
	// <cwd>/.pi/uploads/ so the agent can read it (vision models can view
	// images via the read tool).
	if (p === "/upload" && req.method === "POST") {
		try {
			const MAX = 20 * 1024 * 1024; // 20 MB decoded
			const raw = await new Promise<string>((resolve, reject) => {
				const chunks: Buffer[] = [];
				let total = 0;
				req.on("data", (c: Buffer) => {
					total += c.length;
					if (total > MAX * 1.4) { req.destroy(); reject(new Error("too large")); return; }
					chunks.push(c);
				});
				req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
				req.on("error", reject);
			});
			const body = JSON.parse(raw) as { name?: string; dataBase64?: string };
			if (!body.name || !body.dataBase64) { json(res, 400, { error: "name and dataBase64 required" }); return; }
			const data = Buffer.from(body.dataBase64, "base64");
			if (data.length > MAX) { json(res, 400, { error: "file too large (max 20MB)" }); return; }
			const safeName = body.name.replace(/[^\w.-]+/g, "_").slice(-80) || "upload";
			const uploadsDir = path.join(_cwd, ".pi", "uploads");
			fs.mkdirSync(uploadsDir, { recursive: true });
			const fileName = `${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}-${safeName}`;
			fs.writeFileSync(path.join(uploadsDir, fileName), data);
			json(res, 201, { path: path.join(".pi", "uploads", fileName), bytes: data.length });
		} catch (err) {
			json(res, 400, { error: String((err as Error).message ?? err) });
		}
		return;
	}

	// Model switch API (pi-lab fork) — set the session's active model. For
	// managed local models whose server is down, this STARTS the server
	// (docker compose, stopping same-group peers), then switches — progress
	// streams over SSE as model_starting/model_switched/model_error events.
	// Auto-mode permission classifier fallback — set via permission-modes.ts's
	// bus API (fresh re-read + atomic write + abort-on-parse-failure lives there).
	if (p === "/classifier" && req.method === "POST") {
		try {
			const body = JSON.parse(await readBody(req)) as { model?: string };
			const q: { model?: string; error?: string | null } = { model: (body.model ?? "").trim() };
			_pi?.events.emit("pi-lab:classifier-set", q);
			if (q.error === undefined) { json(res, 503, { error: "permission-modes extension not loaded" }); return; }
			if (q.error) { json(res, 400, { error: q.error }); return; }
			json(res, 200, { ok: true, model: q.model });
		} catch (err) {
			json(res, 400, { error: (err as Error).message });
		}
		return;
	}

	if (p === "/model" && req.method === "POST") {
		try {
			const body = JSON.parse(await readBody(req)) as { model?: string };
			const ref = (body.model ?? "").trim();
			const slash = ref.indexOf("/");
			if (slash <= 0) { json(res, 400, { error: "model must be provider/id" }); return; }
			if (!_pi || !_lastCtx) { json(res, 503, { error: "Agent not ready" }); return; }
			const model = _lastCtx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
			if (!model) { json(res, 404, { error: `unknown model: ${ref}` }); return; }

			// model_switched broadcast rides pi's model_select event (below) —
			// that path also covers plan-mode pickers and /agent-models.
			const doSwitch = async (): Promise<boolean> => _pi!.setModel(model);

			const managed = readLocalModels()[ref];
			if (managed) {
				let up = false;
				try {
					const probe = await fetch(`${managed.url.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(1500) });
					up = probe.ok;
				} catch {
					up = false;
				}
				if (!up) {
					if (_modelStarting) { json(res, 409, { error: `already starting ${_modelStarting}` }); return; }
					_modelStarting = ref;
					json(res, 202, { starting: true, model: ref });
					void (async () => {
						try {
							await startModel(ref, {
								onProgress: (stage) =>
									broadcast({ type: "model_starting", model: ref, stage, time: new Date().toISOString() }),
							});
							if (!(await doSwitch())) {
								broadcast({ type: "model_error", model: ref, error: "server up but setModel failed", time: new Date().toISOString() });
							}
						} catch (err) {
							broadcast({ type: "model_error", model: ref, error: String((err as Error).message ?? err), time: new Date().toISOString() });
						} finally {
							_modelStarting = null;
						}
					})();
					return;
				}
			}

			if (!(await doSwitch())) { json(res, 502, { error: `could not switch to ${ref} (server down / no key?)` }); return; }
			json(res, 200, { ok: true, current: ref });
		} catch {
			json(res, 400, { error: "Invalid JSON body" });
		}
		return;
	}

	// Session rename (pi-lab fork) — pi-native: appends a session_info entry,
	// so the name also shows in pi's own resume picker. Empty name = clear.
	if (p === "/session/rename" && req.method === "POST") {
		try {
			const body = JSON.parse(await readBody(req)) as { name?: string };
			if (typeof body.name !== "string") { json(res, 400, { error: "name (string) required" }); return; }
			if (!_pi) { json(res, 503, { error: "Agent not ready" }); return; }
			const name = body.name.trim().slice(0, 120);
			_pi.setSessionName(name);
			json(res, 200, { ok: true, name: name || null });
		} catch {
			json(res, 400, { error: "Invalid JSON body" });
		}
		return;
	}

	// Session archive (pi-lab fork) — sidecar flag; hides this session from
	// the Perch roost / /sessions lists once it is no longer live.
	if (p === "/session/archive" && req.method === "POST") {
		try {
			const body = JSON.parse(await readBody(req)) as { archived?: boolean };
			const id = _lastCtx?.sessionManager?.getSessionId?.() ?? "";
			if (!id) { json(res, 503, { error: "no persistent session (--no-session?)" }); return; }
			const archived = body.archived !== false;
			setSessionArchived(id, archived);
			json(res, 200, { ok: true, archived });
		} catch {
			json(res, 400, { error: "Invalid JSON body" });
		}
		return;
	}

	// Models API — available models + local server state + vision (pi-lab fork)
	if (p === "/models" && req.method === "GET") {
		let refs: string[] = [];
		let current: string | null = null;
		const vision = new Map<string, boolean>();
		try {
			const available = _lastCtx ? _lastCtx.modelRegistry.getAvailable() : [];
			refs = available.map((m) => `${m.provider}/${m.id}`);
			for (const m of available) {
				vision.set(`${m.provider}/${m.id}`, Array.isArray((m as { input?: string[] }).input) && (m as { input?: string[] }).input!.includes("image"));
			}
			current = _lastCtx?.model ? `${_lastCtx.model.provider}/${_lastCtx.model.id}` : null;
		} catch {
			// registry unavailable — empty list
		}
		const detailed = (await annotate(refs)).map((d) => ({ ...d, vision: vision.get(d.ref) ?? false }));
		json(res, 200, { models: refs, detailed, current, starting: _modelStarting });
		return;
	}

	// Status API — aggregated agent health
	if (p === "/status") {
		const tools = _pi ? _pi.getAllTools() : [];
		const uptime = process.uptime();
		const mem = process.memoryUsage();
		let model: string | null = null;
		let idle: boolean | null = null;
		let contextPercent: number | null = null;
		let modelVision = false;
		let sessionId: string | null = null;
		let sessionName: string | null = null;
		let sessionArchived = false;
		try {
			model = _lastCtx?.model ? `${_lastCtx.model.provider}/${_lastCtx.model.id}` : null;
			idle = _lastCtx?.isIdle() ?? null;
			const input = (_lastCtx?.model as { input?: string[] } | undefined)?.input;
			modelVision = Array.isArray(input) && input.includes("image");
			sessionId = _lastCtx?.sessionManager?.getSessionId?.() ?? null;
			sessionName = _lastCtx?.sessionManager?.getSessionName?.() ?? null;
			if (sessionId) sessionArchived = readSessionMeta()[sessionId]?.archived === true;
		} catch {
			// context gone — report unknowns
		}
		json(res, 200, {
			agent: {
				name: "Pi Agent",
				status: _pi ? "healthy" : "down",
				version: "0.1.0",
				model,
				modelVision,
				idle,
				contextPercent,
				planMode: _planState,
				permMode: _permMode,
				cwd: _cwd,
				sessionId,
				sessionName,
				sessionArchived,
				classifier: (() => {
					// answered synchronously by permission-modes.ts
					const q: { dedicated?: string | null; fallback?: string } = {};
					_pi?.events.emit("pi-lab:classifier-info", q);
					return q.fallback !== undefined ? q : null;
				})(),
			},
			system: {
				nodeVersion: process.version,
				platform: process.platform,
				arch: process.arch,
				uptimeSeconds: Math.round(uptime),
				memoryMB: Math.round(mem.rss / 1024 / 1024),
				heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
				heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
			},
			tools: { count: tools.length, names: tools.map(t => t.name).sort() },
			sseClients: sseClients.size,
			timestamp: new Date().toISOString(),
		});
		return;
	}

	// Chat API
	if (p.startsWith("/chat")) {
		await handleChatApi(req, res, p.slice("/chat".length) || "/");
		return;
	}

	// Agent-sent files (pi-lab fork): only paths explicitly registered by the
	// send_user_file tool are servable — no traversal surface.
	if (p.startsWith("/files/sent/") && req.method === "GET") {
		const id = p.slice("/files/sent/".length).split("?")[0];
		const meta = _sentFiles.get(id);
		if (!meta) { json(res, 404, { error: "unknown or expired file" }); return; }
		try {
			const stat = fs.statSync(meta.path);
			const url = new URL(req.url ?? "", "http://x");
			// XSS hardening: only inert raster images render inline on this
			// (authenticated) origin. SVG/HTML/unknown types are forced to
			// download as octet-stream; nosniff + sandbox close the rest.
			// EXCEPTION (?view=1): HTML/SVG mockups render in a fully
			// sandboxed document — CSP `sandbox` with no allowances puts the
			// content in an opaque origin with scripts, forms, plugins, and
			// same-origin access all disabled. Static markup/CSS only, which
			// is exactly what design mockups need (tailnet-viewable through
			// the hub, mirroring Claude Code's mockup links).
			const INLINE_SAFE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
			const VIEW_SANDBOXED = new Set(["text/html", "image/svg+xml"]);
			const wantsDownload = url.searchParams.get("download") === "1";
			const wantsView = url.searchParams.get("view") === "1" && VIEW_SANDBOXED.has(meta.mime) && !wantsDownload;
			const inline = !wantsDownload && (INLINE_SAFE.has(meta.mime) || wantsView);
			const headers: Record<string, string> = {
				"Content-Type": INLINE_SAFE.has(meta.mime) || wantsView ? meta.mime : "application/octet-stream",
				"Content-Length": String(stat.size),
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "sandbox",
			};
			if (!inline) headers["Content-Disposition"] = `attachment; filename="${meta.name.replace(/["\r\n]/g, "")}"`;
			res.writeHead(200, headers);
			fs.createReadStream(meta.path).pipe(res);
		} catch {
			json(res, 404, { error: "file no longer readable" });
		}
		return;
	}

	// Workspace file download (pi-lab fork) — cwd-restricted like /files/read.
	if (p === "/files/download" && req.method === "GET") {
		const url = new URL(req.url ?? "", "http://x");
		const resolved = safeResolvePath(url.searchParams.get("path") ?? "");
		if (!resolved || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
			json(res, 404, { error: "not found" });
			return;
		}
		const stat = fs.statSync(resolved);
		res.writeHead(200, {
			"Content-Type": "application/octet-stream", // always download, never render on this origin
			"Content-Length": String(stat.size),
			"Content-Disposition": `attachment; filename="${path.basename(resolved).replace(/["\r\n]/g, "")}"`,
			"X-Content-Type-Options": "nosniff",
		});
		fs.createReadStream(resolved).pipe(res);
		return;
	}

	// Files API — workspace file browser
	if (p.startsWith("/files")) {
		await handleFilesApi(req, res, p.slice("/files".length) || "/");
		return;
	}

	// Skills API — list registered skills
	if (p === "/skills" && req.method === "GET") {
		const tools = _pi ? _pi.getAllTools() : [];
		const skills = tools.map(t => ({
			name: t.name,
			description: t.description ?? "",
		}));
		json(res, 200, { skills });
		return;
	}

	// Extensions API — list registered tools/extensions
	if (p === "/extensions" && req.method === "GET") {
		const tools = _pi ? _pi.getAllTools() : [];
		const grouped: Record<string, string[]> = {};
		for (const t of tools) {
			const prefix = t.name.includes("_") ? t.name.split("_")[0] : "core";
			if (!grouped[prefix]) grouped[prefix] = [];
			grouped[prefix].push(t.name);
		}
		const extensions = Object.entries(grouped).map(([name, toolNames]) => ({
			name,
			tools: toolNames,
			toolCount: toolNames.length,
		}));
		json(res, 200, { extensions });
		return;
	}

	// Logs API — live log streaming
	if (p === "/logs/events" && req.method === "GET") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.write(`data: ${JSON.stringify({ type: "connected", time: new Date().toISOString() })}\n\n`);
		logClients.add(res);
		const keepalive = setInterval(() => {
			if (!res.writable) { clearInterval(keepalive); return; }
			try { res.write(": ping\n\n"); } catch { clearInterval(keepalive); logClients.delete(res); }
		}, 15_000);
		req.on("close", () => { clearInterval(keepalive); logClients.delete(res); });
		return;
	}

	json(res, 404, { error: "Not found" });
}

// ── Extension entry point ────────────────────────────────────

export function setupMobile(pi: ExtensionAPI) {
	_pi = pi;

	// send_user_file — the agent pushes a file/screenshot to connected web
	// clients (Claude-Code-remote style). Images render inline in the chat;
	// everything else shows as a download card.
	pi.registerTool({
		name: "send_user_file",
		label: "Send file to user",
		description:
			"Send a file (screenshot, report, artifact, …) to the user's web/phone chat. Images are shown inline; other files appear as a download card. Use when the file IS the deliverable and the user is (or may be) watching remotely.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to an existing file (absolute or relative to cwd)" }),
			caption: Type.Optional(Type.String({ description: "Short caption shown with the file" })),
		}),
		async execute(_id, params) {
			const resolved = path.isAbsolute(params.path) ? params.path : path.resolve(_cwd, params.path);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(resolved);
			} catch {
				return { content: [{ type: "text", text: `File not found: ${resolved}` }], isError: true };
			}
			if (stat.isDirectory()) return { content: [{ type: "text", text: `Is a directory: ${resolved}` }], isError: true };
			if (stat.size > 200 * 1024 * 1024) return { content: [{ type: "text", text: "File too large to send (200MB cap)" }], isError: true };
			const id = randomBytes(24).toString("base64url");
			const meta = { path: resolved, name: path.basename(resolved), mime: guessMime(resolved), size: stat.size };
			_sentFiles.set(id, meta);
			if (_sentFiles.size > 100) _sentFiles.delete(_sentFiles.keys().next().value!);
			broadcast({
				type: "user_file",
				id,
				name: meta.name,
				mime: meta.mime,
				size: meta.size,
				caption: params.caption ?? "",
				time: new Date().toISOString(),
			});
			const watchers = sseClients.size;
			const viewNote = meta.mime === "text/html" || meta.mime === "image/svg+xml"
				? " The card has a View link that renders it in the browser (sandboxed, scripts disabled — keep mockups static HTML+CSS)."
				: "";
			return {
				content: [
					{
						type: "text",
						text: `Sent ${meta.name} (${Math.round(meta.size / 1024)}KB) to the web chat${watchers ? ` — ${watchers} client(s) connected` : " (no clients connected right now; it will appear when the chat reloads history — mention the path too)"}.${viewNote}`,
					},
				],
			};
		},
	});

	function mount(): void {
		pi.events.emit("web:mount", {
			name: "mobile",
			label: "Mobile",
			description: "PWA mobile app for Pi agents",
			prefix: "/mobile",
			handler: handlePage,
		});

		pi.events.emit("web:mount-api", {
			name: "mobile-api",
			label: "Mobile API",
			description: "Mobile app API endpoints",
			prefix: "/mobile",
			handler: handleApi,
		});
	}

	pi.events.on("web:ready", mount);
	pi.on("session_start", async (_event, ctx) => {
		_cwd = ctx.cwd;
		_lastCtx = ctx;
		pi.events.emit("plan-mode:get", {}); // ask plan-mode to announce current state
		pi.events.emit("perm-mode:get", {});
	});

	pi.events.on("plan-mode:state", (data) => {
		_planState = data as typeof _planState;
		broadcast({ type: "plan_state", ...(_planState ?? {}), time: new Date().toISOString() });
	});

	pi.events.on("perm-mode:state", (data) => {
		_permMode = (data as { mode?: string })?.mode ?? null;
		broadcast({ type: "perm_mode", mode: _permMode, time: new Date().toISOString() });
	});

	// ask_user tool (ask-user.ts) — forward question cards and their
	// resolution to connected clients.
	pi.events.on("pi-lab:ask-user", (data) => {
		const d = (data ?? {}) as { id?: string; questions?: unknown };
		broadcast({ type: "ask_user", id: d.id, questions: d.questions, time: new Date().toISOString() });
	});
	pi.events.on("pi-lab:ask-user-resolved", (data) => {
		const d = (data ?? {}) as { id?: string; answered?: boolean };
		broadcast({ type: "ask_user_resolved", id: d.id, answered: d.answered !== false, time: new Date().toISOString() });
	});

	// Surface blocking terminal prompts (permission-gating) to web clients —
	// otherwise the session just looks mysteriously quiet from the phone.
	pi.events.on("pi-lab:attention", (data) => {
		const d = (data ?? {}) as { reason?: string; detail?: string };
		broadcast({ type: "attention", reason: d.reason ?? "attention", detail: d.detail ?? "", time: new Date().toISOString() });
	});

	// Keep the context fresh so /status reports the CURRENT model (pickers and
	// /agent-models can switch it mid-session).
	pi.on("turn_start", async (_event, ctx) => {
		_lastCtx = ctx;
	});
	pi.on("agent_end", async (_event, ctx) => {
		_lastCtx = ctx;
	});

	// ANY model change (plan-mode picker, /agent-models, /model endpoint,
	// plan-exit restore) → tell connected clients so the header chip updates
	// immediately instead of waiting for the next agent_end status refresh.
	pi.on("model_select", async (event, ctx) => {
		_lastCtx = ctx;
		const m = event.model as { provider?: string; id?: string } | undefined;
		if (!m?.provider || !m?.id) return;
		broadcast({ type: "model_switched", model: `${m.provider}/${m.id}`, source: event.source, time: new Date().toISOString() });
	});

	// ── SSE event forwarding ──────────────────────────────
	// Register once — broadcast to all connected SSE clients.

	pi.on("agent_start", async () => {
		broadcast({ type: "agent_start", time: new Date().toISOString() });
	});

	pi.on("agent_end", async () => {
		broadcast({ type: "agent_end", time: new Date().toISOString() });
	});

	pi.on("turn_end", async (event) => {
		const msg = event.message as { role?: string; content?: unknown[] } | undefined;
		const content: unknown[] = [];
		if (msg?.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				const b = block as Record<string, unknown>;
				if (b.type === "text") {
					content.push({ type: "text", text: String(b.text ?? "").slice(0, 8192) });
				} else if (b.type === "thinking") {
					content.push({ type: "thinking", thinking: String(b.thinking ?? "").slice(0, 4096) });
				}
			}
		}
		broadcast({ type: "turn_end", turn: event.turnIndex, content, toolResults: event.toolResults.length });
	});

	pi.on("tool_call", async (event) => {
		broadcast({ type: "tool_start", toolName: event.toolName, toolCallId: event.toolCallId });
	});

	pi.on("tool_result", async (event) => {
		const content: unknown[] = [];
		for (const c of event.content) {
			const b = c as unknown as Record<string, unknown>;
			if (b.type === "text") {
				content.push({ type: "text", text: String(b.text ?? "").slice(0, 4096) });
			}
		}
		broadcast({ type: "tool_end", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError, content });
	});

	// ── Command result forwarding ──────────────────────────────
	// When extensions send command_result via pi.sendMessage(), forward to SSE clients.
	pi.events.on("command_result", (data: unknown) => {
		const d = data as { command?: string; message?: string; type?: string };
		broadcast({ type: "command_result", command: d.command, message: d.message, notificationType: d.type, time: new Date().toISOString() });
	});

	// ── Log event forwarding ──────────────────────────────

	pi.on("tool_call", async (event) => {
		broadcastLog({ level: "info", source: "tool", msg: `→ ${event.toolName}`, time: new Date().toISOString() });
	});

	pi.on("tool_result", async (event) => {
		const level = event.isError ? "error" : "info";
		broadcastLog({ level, source: "tool", msg: `← ${event.toolName}${event.isError ? " (error)" : ""}`, time: new Date().toISOString() });
	});

	pi.on("session_shutdown", async () => {
		_pi = null;
		for (const res of sseClients) { try { res.end(); } catch {} }
		sseClients.clear();
		for (const res of logClients) { try { res.end(); } catch {} }
		logClients.clear();
	});
}
