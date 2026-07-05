/**
 * MCP Client Extension
 *
 * Reads ~/.pi/agent/mcp.json (and optionally .mcp.json in cwd ancestors),
 * connects to each MCP server (stdio or HTTP) via @modelcontextprotocol/sdk,
 * and registers their tools with pi as mcp__<server>__<tool>.
 *
 * Config (matches Claude Code's .mcp.json):
 *   stdio: { "name": { "command": "...", "args": [...], "env": {...}, "cwd": "..." } }
 *   http:  { "name": { "url": "https://host/path/mcp", "headers": {...}, "transport": "streamable" | "sse" } }
 *
 * Precedence: global config first, then .mcp.json files from the filesystem
 * root down to cwd — the NEAREST project file wins (Claude Code semantics).
 *
 * Prompt-size controls (each MCP tool schema costs ~200 tokens of system
 * prompt; 9 servers ≈ 63k tokens, so big servers should not load everywhere):
 *   - "optIn": true on a global entry → the server loads ONLY in projects
 *     whose .mcp.json opts in with { "name": { "enabled": true } } (bare flag,
 *     no command/url — credentials stay in the global file).
 *   - { "name": null } or { "name": { "disabled": true } } in a project
 *     .mcp.json removes a globally-defined server for that project tree.
 *   - "router": true on an entry → instead of registering every tool, the
 *     server gets ONE gateway tool `mcp__<server>` with
 *     action=list|describe|call — tool schemas load on demand (~200 tokens
 *     instead of ~200×N). Project flag-only entries may toggle it:
 *     { "name": { "router": false } }.
 */

import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

interface StdioServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	router?: boolean;
}

interface HttpServerConfig {
	url: string;
	headers?: Record<string, string>;
	transport?: "streamable" | "sse";
	router?: boolean;
}

type McpServerConfig = StdioServerConfig | HttpServerConfig;

function isHttpConfig(c: McpServerConfig): c is HttpServerConfig {
	return typeof (c as HttpServerConfig).url === "string";
}

interface ServerState {
	name: string;
	config: McpServerConfig;
	client: Client | null;
	tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
	reconnectAttempts: number;
	healthy: boolean;
	/** registration forms already created this session (pi has no unregisterTool —
	 * live toggles swap the ACTIVE tool set instead; see pi-lab:mcp-apply) */
	registeredDirect?: boolean;
	registeredRouter?: boolean;
}

const MAX_RECONNECT = 5;
const CALL_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 10_000;
const DESCRIPTION_LIMIT_QWEN = 200;

type McpServerEntry =
	| (McpServerConfig & { disabled?: boolean; optIn?: boolean; enabled?: boolean })
	| { disabled?: boolean; enabled?: boolean; router?: boolean }
	| null;

/** Per-server view of the merged config — powers the PWA "MCP servers" card. */
interface McpServerMeta {
	name: string;
	/** would load under the CURRENT config files (next session) */
	active: boolean;
	optIn: boolean;
	optedIn: boolean;
	disabled: boolean;
	routed: boolean;
	/** a project .mcp.json fully redefines this server (command/url present) */
	projectDefined: boolean;
}

function loadMcpConfigDetailed(): {
	active: Record<string, McpServerConfig>;
	meta: McpServerMeta[];
	/** definition (incl. merged router flag) for every known server, active or not */
	defs: Record<string, McpServerConfig>;
} {
	// Layers, lowest precedence first: global, then root → cwd (nearest wins).
	const paths: string[] = [join(homedir(), ".pi", "agent", "mcp.json")];
	const ancestors: string[] = [];
	let dir = process.cwd();
	while (true) {
		ancestors.push(join(dir, ".mcp.json"));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	paths.push(...ancestors.reverse());

	const merged: Record<string, McpServerEntry> = {};
	const optedIn = new Set<string>();
	const projectDefined = new Set<string>();
	paths.forEach((p, layer) => {
		if (!existsSync(p)) return;
		try {
			const parsed = JSON.parse(readFileSync(p, "utf8")) as { mcpServers?: Record<string, McpServerEntry> };
			if (!parsed.mcpServers) return;
			for (const [name, entry] of Object.entries(parsed.mcpServers)) {
				// Project-layer flag-only entries control an inherited definition
				// rather than replacing it.
				const isFlagOnly = layer > 0 && entry !== null
					&& !("command" in entry) && !("url" in entry);
				if (isFlagOnly) {
					const flags = entry as { enabled?: boolean; disabled?: boolean; router?: boolean };
					if (flags.enabled === true) optedIn.add(name);
					if (flags.disabled === true) { merged[name] = null; continue; }
					if (typeof flags.router === "boolean" && merged[name] && typeof merged[name] === "object") {
						merged[name] = { ...(merged[name] as object), router: flags.router } as McpServerEntry;
					}
					continue;
				}
				merged[name] = entry;
			}
		} catch { /* skip malformed */ }
	});

	const out: Record<string, McpServerConfig> = {};
	const defs: Record<string, McpServerConfig> = {};
	const meta: McpServerMeta[] = [];
	for (const [name, entry] of Object.entries(merged)) {
		const flags = (entry ?? {}) as { disabled?: boolean; optIn?: boolean; router?: boolean };
		const hasDef = entry !== null && (("command" in entry) || ("url" in entry));
		const active = Boolean(
			entry && flags.disabled !== true && hasDef && !(flags.optIn === true && !optedIn.has(name)),
		);
		meta.push({
			name,
			active,
			optIn: flags.optIn === true,
			optedIn: optedIn.has(name),
			disabled: entry === null || flags.disabled === true,
			routed: flags.router === true,
			projectDefined: projectDefined.has(name),
		});
		if (!hasDef) continue;
		const { disabled: _d, optIn: _o, enabled: _e, ...cfg } = entry as Record<string, unknown>;
		defs[name] = cfg as unknown as McpServerConfig; // keeps `router` for the registration path
		if (active) out[name] = defs[name];
	}
	return { active: out, meta, defs };
}

function loadMcpConfig(): Record<string, McpServerConfig> {
	return loadMcpConfigDetailed().active;
}

function cleanEnv(base: NodeJS.ProcessEnv, overlay?: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(base)) if (typeof v === "string") out[k] = v;
	if (overlay) for (const [k, v] of Object.entries(overlay)) out[k] = v;
	return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
	});
}

async function connectServer(state: ServerState): Promise<void> {
	const cfg = state.config;
	const transport = isHttpConfig(cfg)
		? (cfg.transport === "sse"
			? new SSEClientTransport(new URL(cfg.url), {
				requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
			})
			: new StreamableHTTPClientTransport(new URL(cfg.url), {
				requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
			}))
		: new StdioClientTransport({
			command: cfg.command,
			args: cfg.args ?? [],
			env: cleanEnv(process.env, cfg.env),
			cwd: cfg.cwd,
		});
	const client = new Client({ name: "pi-lab-mcp-client", version: "0.1.0" }, { capabilities: {} });
	await withTimeout(client.connect(transport), STARTUP_TIMEOUT_MS, `connect ${state.name}`);
	const res = await withTimeout(client.listTools(), STARTUP_TIMEOUT_MS, `listTools ${state.name}`);
	state.client = client;
	state.tools = (res.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
	state.healthy = true;
	state.reconnectAttempts = 0;
}

async function reconnectWithBackoff(state: ServerState): Promise<void> {
	if (state.reconnectAttempts >= MAX_RECONNECT) {
		throw new Error(`MCP server ${state.name} exceeded max reconnect attempts (${MAX_RECONNECT})`);
	}
	const delay = Math.min(500 * Math.pow(2, state.reconnectAttempts), 8000);
	state.reconnectAttempts++;
	await new Promise((r) => setTimeout(r, delay));
	try { await state.client?.close(); } catch { /* ignore */ }
	await connectServer(state);
}

function truncateDescription(desc: string | undefined, limit: number): string {
	if (!desc) return "";
	if (desc.length <= limit) return desc;
	return desc.slice(0, limit - 1).trimEnd() + "…";
}

export default async function mcpClientExtension(pi: ExtensionAPI) {
	const servers = loadMcpConfig();
	if (Object.keys(servers).length === 0) return;

	const states = new Map<string, ServerState>();
	const isQwenLike = (): boolean => /crow-local|qwen|llama/i.test(process.env.PI_PROVIDER ?? "");

	await Promise.allSettled(
		Object.entries(servers).map(async ([name, config]) => {
			const state: ServerState = {
				name, config,
				client: null,
				tools: [],
				reconnectAttempts: 0, healthy: false,
			};
			states.set(name, state);
			try {
				await connectServer(state);
			} catch (err) {
				console.error(`[pi-lab/mcp-client] ${name}: ${(err as Error).message}`);
			}
		}),
	);

	const descLimit = isQwenLike() ? DESCRIPTION_LIMIT_QWEN : 1024;

	type ToolResult = {
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
		isError: boolean;
	};

	// Shared call path for direct tools, the router gateway, and (indirectly)
	// the bus bridge below: reconnect if needed, invoke, normalize content.
	async function invokeServerTool(
		state: ServerState,
		toolName: string,
		args: Record<string, unknown>,
		signal: AbortSignal | undefined,
	): Promise<ToolResult> {
		if (!state.healthy || !state.client) {
			try { await reconnectWithBackoff(state); }
			catch (err) {
				return {
					content: [{ type: "text", text: `MCP server '${state.name}' unavailable: ${(err as Error).message}` }],
					details: { error: true, server: state.name },
					isError: true,
				};
			}
		}
		try {
			const abortListener = () => { state.client?.close().catch(() => {}); };
			signal?.addEventListener("abort", abortListener, { once: true });
			const result = await withTimeout(
				state.client!.callTool({ name: toolName, arguments: args }),
				CALL_TIMEOUT_MS,
				`call mcp__${state.name}__${toolName}`,
			);
			signal?.removeEventListener("abort", abortListener);
			const content = Array.isArray(result.content) ? result.content : [];
			return {
				content: content.map((c: { type: string; text?: string }) =>
					c.type === "text" && typeof c.text === "string"
						? { type: "text" as const, text: c.text }
						: { type: "text" as const, text: JSON.stringify(c) },
				),
				details: { server: state.name, tool: toolName },
				isError: Boolean(result.isError),
			};
		} catch (err) {
			state.healthy = false;
			return {
				content: [{ type: "text", text: `MCP call failed: ${(err as Error).message}` }],
				details: { error: true, server: state.name, tool: toolName },
				isError: true,
			};
		}
	}

	const directNames = (state: ServerState) => state.tools.map((t) => `mcp__${state.name}__${t.name}`);
	const gatewayName = (state: ServerState) => `mcp__${state.name}`;

	function registerDirectTools(state: ServerState): void {
		if (state.registeredDirect) return;
		state.registeredDirect = true;
		for (const tool of state.tools) {
			const toolName = `mcp__${state.name}__${tool.name}`;
			const rawSchema = (tool.inputSchema && typeof tool.inputSchema === "object")
				? (tool.inputSchema as Record<string, unknown>)
				: { type: "object", properties: {} };
			const schema: Record<string, unknown> = { ...rawSchema };
			if (schema.type !== "object") {
				schema.type = "object";
				if (!("properties" in schema)) schema.properties = {};
			}
			const parameters = Type.Unsafe<Record<string, unknown>>(schema as object);

			pi.registerTool({
				name: toolName,
				label: `${state.name}/${tool.name}`,
				description: truncateDescription(tool.description, descLimit),
				parameters,
				async execute(_toolCallId, params, signal) {
					return invokeServerTool(state, tool.name, (params as Record<string, unknown>) ?? {}, signal);
				},
			});
		}
	}

	// Router mode: one gateway tool for the whole server. The tool list and
	// schemas stay out of the system prompt and load on demand.
	function registerRouterTool(state: ServerState): void {
		if (state.registeredRouter) return;
		state.registeredRouter = true;
		const sample = state.tools.slice(0, 6).map((t) => t.name.replace(/^crow_/, "")).join(", ");
		pi.registerTool({
			name: `mcp__${state.name}`,
			label: `${state.name} (gateway)`,
			description:
				`Gateway to the '${state.name}' MCP server (${state.tools.length} tools, e.g. ${sample}). ` +
				`Use action="list" to see every tool with a short description, ` +
				`action="describe" with tool=<name> to get its full input schema, ` +
				`action="call" with tool=<name> and args={...} to invoke it.`,
			parameters: Type.Object({
				action: Type.Union([Type.Literal("list"), Type.Literal("describe"), Type.Literal("call")], {
					description: "list = enumerate tools; describe = full schema for one tool; call = invoke a tool",
				}),
				tool: Type.Optional(Type.String({ description: "Tool name (required for describe/call)" })),
				args: Type.Optional(Type.Unsafe<Record<string, unknown>>({
					type: "object",
					description: "Arguments object for action=\"call\" (see describe for the schema)",
				})),
			}),
			async execute(_toolCallId, params, signal) {
				const p = params as { action: string; tool?: string; args?: Record<string, unknown> };
				const fail = (text: string): ToolResult => ({
					content: [{ type: "text", text }],
					details: { server: state.name, router: true },
					isError: true,
				});
				if (p.action === "list") {
					const lines = state.tools.map((t) => `${t.name} — ${truncateDescription(t.description, 120)}`);
					return {
						content: [{ type: "text", text: lines.join("\n") || "(no tools)" }],
						details: { server: state.name, router: true, count: state.tools.length },
						isError: false,
					};
				}
				const def = p.tool ? state.tools.find((t) => t.name === p.tool) : undefined;
				if (!def) {
					return fail(
						`Unknown or missing tool '${p.tool ?? ""}'. Valid tools: ${state.tools.map((t) => t.name).join(", ")}`,
					);
				}
				if (p.action === "describe") {
					const text = `${def.name}: ${def.description ?? "(no description)"}\n\nInput schema:\n${JSON.stringify(def.inputSchema ?? { type: "object", properties: {} }, null, 1)}`;
					return {
						content: [{ type: "text", text }],
						details: { server: state.name, router: true, tool: def.name },
						isError: false,
					};
				}
				if (p.action === "call") {
					return invokeServerTool(state, def.name, p.args ?? {}, signal);
				}
				return fail(`Unknown action '${p.action}' — use list, describe, or call.`);
			},
		});
	}

	for (const state of states.values()) {
		if (!state.healthy) continue;
		if ((state.config as { router?: boolean }).router === true) registerRouterTool(state);
		else registerDirectTools(state);
	}

	// Cross-extension bridge: invoke an MCP tool extension-side ("pi-lab:mcp-call").
	// Synchronous emit + mutable payload (same pattern as background-tasks' pi-lab:bg-list):
	// the caller emits {server, tool, args, timeoutMs?} and then checks payload.promise —
	// unset means the server is missing/unhealthy/not allowlisted (caller fails open).
	// NOT an escalation channel: bus emitters are in-process extension code only (the
	// PWA "MCP servers" card — synchronous bus fills, same pattern as
	// pi-lab:agent-models-get. Status recomputes the merged config fresh so
	// pending (next-session) state shows immediately after an edit.
	pi.events.on("pi-lab:mcp-status", (payload: unknown) => {
		const q = payload as {
			cwd?: string;
			servers?: Array<McpServerMeta & { loadedNow: boolean; healthy: boolean; toolCount: number }>;
		};
		const fresh = loadMcpConfigDetailed();
		q.cwd = process.cwd();
		const liveActive = new Set(pi.getActiveTools());
		q.servers = fresh.meta.map((m) => {
			const st = states.get(m.name);
			const names = st ? [...st.tools.map((t) => `mcp__${m.name}__${t.name}`), `mcp__${m.name}`] : [];
			return {
				...m,
				loadedNow: Boolean(st?.client),
				healthy: Boolean(st?.healthy),
				toolCount: st?.tools.length ?? 0,
				liveTools: names.filter((n) => liveActive.has(n)).length,
			};
		});
	});

	// Live apply — connect/disconnect a server and swap the ACTIVE tool set in
	// the running session (pi has no unregisterTool, so disable = deactivate).
	// Async work rides a promise on the payload (same pattern as pi-lab:mcp-call).
	// Refused during plan mode: plan-mode snapshots+restores the active set and
	// would silently clobber the change at Execute.
	// plan-mode:get triggers a plan-mode:state broadcast — track it (same
	// pattern as tournament.ts).
	let planState = { enabled: false, executing: false };
	pi.events.on("plan-mode:state", (d: unknown) => {
		const s = d as { enabled?: boolean; executing?: boolean };
		planState = { enabled: Boolean(s.enabled), executing: Boolean(s.executing) };
	});
	pi.events.on("pi-lab:mcp-apply", (payload: unknown) => {
		const p = payload as {
			server?: string;
			action?: "enable" | "disable" | "router-on" | "router-off";
			promise?: Promise<{ ok: boolean; error?: string }>;
		};
		p.promise = (async () => {
			const name = (p.server ?? "").trim();
			pi.events.emit("plan-mode:get", {});
			if (planState.enabled || planState.executing) {
				return { ok: false, error: "plan mode active — saved to .mcp.json, applies after plan mode / next session" };
			}
			let state = states.get(name);
			const activeSet = new Set(pi.getActiveTools());

			// Disable needs no definition (the file write may have just removed
			// it from the merged config) — close the client, deactivate tools.
			if (p.action === "disable") {
				if (state) {
					try { await state.client?.close(); } catch { /* already down */ }
					state.client = null;
					state.healthy = false;
					for (const t of [...directNames(state), gatewayName(state)]) activeSet.delete(t);
					pi.setActiveTools([...activeSet]);
				}
				return { ok: true };
			}

			const fresh = loadMcpConfigDetailed();
			const def = fresh.defs[name];
			if (!def) return { ok: false, error: `no definition for server: ${name}` };
			const routed = (def as { router?: boolean }).router === true;

			// enable / router toggles all need a connected server
			if (!state) {
				state = { name, config: def, client: null, tools: [], reconnectAttempts: 0, healthy: false };
				states.set(name, state);
			}
			if (!state.healthy || !state.client) {
				state.config = def;
				state.reconnectAttempts = 0;
				try { await connectServer(state); } catch (err) {
					return { ok: false, error: `connect failed: ${(err as Error).message} (saved for next session)` };
				}
			}
			const wantRouter = p.action === "router-on" ? true : p.action === "router-off" ? false : routed;
			if (wantRouter) registerRouterTool(state);
			else registerDirectTools(state);
			for (const t of directNames(state)) { if (wantRouter) activeSet.delete(t); else activeSet.add(t); }
			if (wantRouter) activeSet.add(gatewayName(state));
			else activeSet.delete(gatewayName(state));
			pi.setActiveTools([...activeSet]);
			return { ok: true };
		})();
	});

	// Write a FLAG-ONLY entry ({enabled|disabled|router}) into <cwd>/.mcp.json.
	// Server definitions (command/url) are never created or modified here, so
	// this cannot be used to point a name at a new binary — it only toggles
	// servers the global config already defines. patch values: true/false set
	// the flag, null deletes it; an entry left empty is removed.
	pi.events.on("pi-lab:mcp-project-set", (payload: unknown) => {
		const q = payload as {
			server?: string;
			patch?: Record<string, boolean | null>;
			ok?: boolean;
			error?: string;
		};
		try {
			const name = (q.server ?? "").trim();
			const known = loadMcpConfigDetailed().meta.find((m) => m.name === name);
			if (!name || !known) { q.error = `unknown server: ${name}`; return; }
			if (known.projectDefined) { q.error = `${name} is fully defined in a project .mcp.json — edit that file directly`; return; }
			const patch = q.patch ?? {};
			const allowedKeys = ["enabled", "disabled", "router"];
			for (const [k, v] of Object.entries(patch)) {
				if (!allowedKeys.includes(k) || (v !== null && typeof v !== "boolean")) {
					q.error = `invalid patch key/value: ${k}`;
					return;
				}
			}
			const filePath = join(process.cwd(), ".mcp.json");
			let cfg: { mcpServers?: Record<string, Record<string, unknown> | null> } = {};
			if (existsSync(filePath)) cfg = JSON.parse(readFileSync(filePath, "utf8"));
			cfg.mcpServers ??= {};
			const existing = cfg.mcpServers[name];
			if (existing && (("command" in existing) || ("url" in existing))) {
				q.error = `${name} has a full definition in ${filePath} — edit it directly`;
				return;
			}
			const entry: Record<string, unknown> = { ...(existing ?? {}) };
			for (const [k, v] of Object.entries(patch)) {
				if (v === null) delete entry[k];
				else entry[k] = v;
			}
			if (Object.keys(entry).length === 0) delete cfg.mcpServers[name];
			else cfg.mcpServers[name] = entry;
			const tmp = `${filePath}.tmp-${process.pid}`;
			writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
			renameSync(tmp, filePath);
			q.ok = true;
		} catch (err) {
			q.error = (err as Error).message;
		}
	});

	// model, hooks, and the web prompt route cannot emit arbitrary bus events). Still,
	// defense-in-depth: only allowlisted servers are callable (settings.mcp.bridgeServers,
	// default ["crow-memory"]), and every bridge call logs one stderr line.
	pi.events.on("pi-lab:mcp-call", (payload: unknown) => {
		const p = payload as {
			server: string;
			tool: string;
			args?: Record<string, unknown>;
			timeoutMs?: number;
			promise?: Promise<{ isError: boolean; text: string }>;
		};
		let allowed = ["crow-memory"];
		try {
			const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
			const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { mcp?: { bridgeServers?: string[] } };
			if (Array.isArray(raw.mcp?.bridgeServers)) allowed = raw.mcp.bridgeServers;
		} catch {
			// keep default allowlist
		}
		if (!allowed.includes(p.server)) return;
		const state = states.get(p.server);
		if (!state?.healthy || !state.client) return;
		process.stderr.write(`[mcp-client] bridge call: ${p.server}/${p.tool}\n`);
		p.promise = withTimeout(
			state.client.callTool({ name: p.tool, arguments: p.args ?? {} }),
			Math.min(p.timeoutMs ?? CALL_TIMEOUT_MS, CALL_TIMEOUT_MS),
			`bridge call ${p.server}/${p.tool}`,
		).then((result) => {
			const content = Array.isArray(result.content) ? result.content : [];
			const text = content
				.map((c: { type?: string; text?: string }) =>
					c?.type === "text" && typeof c.text === "string" ? c.text : JSON.stringify(c),
				)
				.join("\n");
			return { isError: Boolean(result.isError), text };
		});
	});

	// Close all MCP connections on session end so pi exits cleanly.
	pi.on("session_shutdown", async () => {
		await Promise.allSettled(Array.from(states.values()).map(async (s) => {
			try { await s.client?.close(); } catch { /* ignore */ }
		}));
	});
}
