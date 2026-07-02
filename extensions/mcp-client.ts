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
 */

import { readFileSync, existsSync } from "node:fs";
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
}

interface HttpServerConfig {
	url: string;
	headers?: Record<string, string>;
	transport?: "streamable" | "sse";
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
}

const MAX_RECONNECT = 5;
const CALL_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 10_000;
const DESCRIPTION_LIMIT_QWEN = 200;

function loadMcpConfig(): Record<string, McpServerConfig> {
	const paths: string[] = [];
	paths.push(join(homedir(), ".pi", "agent", "mcp.json"));
	let dir = process.cwd();
	while (true) {
		paths.push(join(dir, ".mcp.json"));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const merged: Record<string, McpServerConfig> = {};
	for (const p of paths.reverse()) {
		if (!existsSync(p)) continue;
		try {
			const parsed = JSON.parse(readFileSync(p, "utf8")) as { mcpServers?: Record<string, McpServerConfig> };
			if (parsed.mcpServers) Object.assign(merged, parsed.mcpServers);
		} catch { /* skip malformed */ }
	}
	return merged;
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
	for (const state of states.values()) {
		if (!state.healthy) continue;
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
					if (!state.healthy || !state.client) {
						try { await reconnectWithBackoff(state); }
						catch (err) {
							return {
								content: [{ type: "text" as const, text: `MCP server '${state.name}' unavailable: ${(err as Error).message}` }],
								details: { error: true, server: state.name },
								isError: true,
							};
						}
					}
					try {
						const abortListener = () => { state.client?.close().catch(() => {}); };
						signal?.addEventListener("abort", abortListener, { once: true });
						const result = await withTimeout(
							state.client!.callTool({ name: tool.name, arguments: (params as Record<string, unknown>) ?? {} }),
							CALL_TIMEOUT_MS,
							`call ${toolName}`,
						);
						signal?.removeEventListener("abort", abortListener);
						const content = Array.isArray(result.content) ? result.content : [];
						return {
							content: content.map((c: { type: string; text?: string }) =>
								c.type === "text" && typeof c.text === "string"
									? { type: "text" as const, text: c.text }
									: { type: "text" as const, text: JSON.stringify(c) },
							),
							details: { server: state.name, tool: tool.name },
							isError: Boolean(result.isError),
						};
					} catch (err) {
						state.healthy = false;
						return {
							content: [{ type: "text" as const, text: `MCP call failed: ${(err as Error).message}` }],
							details: { error: true, server: state.name, tool: tool.name },
							isError: true,
						};
					}
				},
			});
		}
	}

	// Cross-extension bridge: invoke an MCP tool extension-side ("pi-lab:mcp-call").
	// Synchronous emit + mutable payload (same pattern as background-tasks' pi-lab:bg-list):
	// the caller emits {server, tool, args, timeoutMs?} and then checks payload.promise —
	// unset means the server is missing/unhealthy/not allowlisted (caller fails open).
	// NOT an escalation channel: bus emitters are in-process extension code only (the
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
