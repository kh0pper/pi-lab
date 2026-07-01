/**
 * session-web — session list / teleport / remote spawn, mounted on the
 * vendored web stack (extensions/web).
 *
 *   Page: /sessions        — table of on-disk sessions + running tmux pi
 *                            sessions, with resume / spawn / teleport actions
 *   API:  /api/sessions/*  — list, processes, resume, spawn
 *
 * Mounts via the event bus after "web:ready" (same pattern as the mobile UI),
 * so there is no import coupling to the server. Auth comes for free from the
 * web stack (Basic/cookie on pages, Bearer/cookie on /api/*).
 *
 * Spawned/resumed sessions run as detached tmux sessions (pi-<id>): they
 * survive this process, are attachable from any terminal, and fire extension
 * lifecycle events (notify.ts works) — unlike headless `pi -p` runs.
 *
 * Config (~/.pi/agent/settings.json):
 *   "sessionWeb": { "excludeCwdPatterns": ["/.crow-mpa/"] }   // bot workspaces hidden by default
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_EXCLUDE_CWD_PATTERNS,
	listSessions,
	listTmuxPiSessions,
	spawnSession,
	teleportCommand,
} from "../../lib/sessions.mjs";

function excludePatterns(): string[] {
	const settingsPath = resolve(homedir(), ".pi", "agent", "settings.json");
	if (!existsSync(settingsPath)) return DEFAULT_EXCLUDE_CWD_PATTERNS;
	try {
		const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			sessionWeb?: { excludeCwdPatterns?: string[] };
		};
		return raw.sessionWeb?.excludeCwdPatterns ?? DEFAULT_EXCLUDE_CWD_PATTERNS;
	} catch {
		return DEFAULT_EXCLUDE_CWD_PATTERNS;
	}
}

async function readBody(req: any): Promise<any> {
	return new Promise((resolvePromise, reject) => {
		let body = "";
		req.on("data", (c: Buffer) => {
			body += c.toString();
			if (body.length > 65536) reject(new Error("body too large"));
		});
		req.on("end", () => {
			try {
				resolvePromise(body ? JSON.parse(body) : {});
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}

function json(res: any, status: number, data: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi sessions</title>
<style>
  /* Perch design system (see extensions/web + hub) */
  :root{--sky:#eef1f3;--card:#fff;--ink:#22303a;--dim:#6b7c88;--teal:#0e6b62;--line:#dde4e8;--alive:#2fa36b}
  @media (prefers-color-scheme:dark){:root{--sky:#131a1f;--card:#1b242b;--ink:#e4ebef;--dim:#8fa0ab;--teal:#4fbdb0;--line:#2a353d}}
  body { font-family: Inter, system-ui, sans-serif; background: var(--sky); color: var(--ink); margin: 0 auto; padding: 16px; max-width: 720px; }
  h1 { font-size: 20px; letter-spacing: -0.02em; } h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--dim); margin-top: 28px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; background: var(--card); border-radius: 14px; overflow: hidden; border: 1px solid var(--line); }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); }
  tr:last-child td { border-bottom: none; }
  th { color: var(--dim); font-weight: 500; }
  code { font: 12px "JetBrains Mono", ui-monospace, monospace; color: var(--teal); }
  button { background: var(--teal); color: #fff; border: 0; border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
  button.ghost { background: transparent; color: var(--dim); border: 1px solid var(--line); }
  input, textarea { background: var(--card); color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; font-size: 13px; width: 100%; box-sizing: border-box; }
  form { display: grid; gap: 8px; max-width: 640px; margin-top: 8px; }
  .muted { color: var(--dim); } .ok { color: var(--alive); }
  #msg { margin: 10px 0; font-size: 13px; min-height: 18px; }
</style></head><body>
<h1>pi sessions</h1>
<div id="msg"></div>
<h2>Running (tmux)</h2>
<table id="procs"><thead><tr><th>tmux</th><th>cwd</th><th>attach</th></tr></thead><tbody></tbody></table>
<h2>New session</h2>
<form id="spawn">
  <input name="cwd" placeholder="working directory (e.g. /home/kh0pp/pi-lab)" required>
  <textarea name="prompt" rows="3" placeholder="initial prompt (optional)"></textarea>
  <button type="submit">Spawn in tmux</button>
</form>
<h2>On disk</h2>
<table id="sessions"><thead><tr><th>when</th><th>cwd</th><th>id</th><th>size</th><th></th><th></th></tr></thead><tbody></tbody></table>
<script>
const BASE = location.pathname.replace(/\\/sessions(\\/.*)?$/, "");
const api = (p, opts) => fetch(BASE + "/api/sessions" + p, opts).then(r => r.json());
const msg = (t, ok) => { const el = document.getElementById("msg"); el.textContent = t; el.className = ok ? "ok" : ""; };
const fmtAge = (ms) => { const m = (Date.now() - ms) / 60000; if (m < 60) return Math.round(m) + "m ago"; const h = m / 60; if (h < 48) return Math.round(h) + "h ago"; return Math.round(h / 24) + "d ago"; };
const fmtSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";
// Build rows with textContent only — cwd/session values must never hit innerHTML.
const cell = (text, cls) => { const td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; return td; };
async function load() {
  const [sessions, procs] = await Promise.all([api("/list"), api("/processes")]);
  const pb = document.querySelector("#procs tbody"); pb.textContent = "";
  for (const p of (procs.processes || [])) {
    const tr = document.createElement("tr");
    tr.appendChild(cell(p.name));
    tr.appendChild(cell(p.cwd || "", "muted"));
    const td = document.createElement("td"); const code = document.createElement("code");
    code.textContent = "tmux attach -t " + p.name; td.appendChild(code); tr.appendChild(td);
    pb.appendChild(tr);
  }
  if (!(procs.processes || []).length) { const tr = document.createElement("tr"); const td = cell("none", "muted"); td.colSpan = 3; tr.appendChild(td); pb.appendChild(tr); }
  const tb = document.querySelector("#sessions tbody"); tb.textContent = "";
  for (const s of (sessions.sessions || [])) {
    const tr = document.createElement("tr");
    tr.appendChild(cell(fmtAge(s.mtimeMs)));
    tr.appendChild(cell(s.cwd));
    tr.appendChild(cell(s.id.slice(0, 8), "muted"));
    tr.appendChild(cell(fmtSize(s.sizeBytes), "muted"));
    const copy = document.createElement("button"); copy.className = "ghost"; copy.textContent = "teleport cmd";
    copy.onclick = () => navigator.clipboard.writeText(s.teleport).then(() => msg("Copied: " + s.teleport, true));
    const res = document.createElement("button"); res.textContent = "resume in tmux";
    res.onclick = async () => { const r = await api("/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: s.file }) }); msg(r.error || ("Resumed: " + r.command), !r.error); load(); };
    const td1 = document.createElement("td"); td1.appendChild(copy); tr.appendChild(td1);
    const td2 = document.createElement("td"); td2.appendChild(res); tr.appendChild(td2);
    tb.appendChild(tr);
  }
}
document.getElementById("spawn").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await api("/spawn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: f.get("cwd"), prompt: f.get("prompt") || undefined }) });
  msg(r.error || ("Spawned: " + r.command), !r.error);
  setTimeout(load, 800);
};
load();
</script></body></html>`;

export default function (pi: ExtensionAPI) {
	if (process.env["PI_BOT_PERMISSION_POLICY"]) return;
	if (Number(process.env["PIBOT_SUBAGENT_DEPTH"] ?? "0") >= 1) return;

	pi.events.on("web:ready", () => {
		pi.events.emit("web:mount", {
			name: "sessions",
			label: "Sessions",
			description: "pi session list, resume, spawn",
			prefix: "/sessions",
			handler: async (_req: any, res: any) => {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(PAGE_HTML);
			},
		});

		pi.events.emit("web:mount-api", {
			name: "sessions-api",
			label: "Sessions API",
			prefix: "/sessions",
			handler: async (req: any, res: any, subPath: string) => {
				try {
					if (req.method === "GET" && (subPath === "/list" || subPath === "list")) {
						const sessions = listSessions({ excludeCwdPatterns: excludePatterns() }).map((s) => ({
							...s,
							teleport: teleportCommand(s),
						}));
						return json(res, 200, { sessions });
					}
					if (req.method === "GET" && (subPath === "/processes" || subPath === "processes")) {
						return json(res, 200, { processes: await listTmuxPiSessions() });
					}
					if (req.method === "POST" && (subPath === "/resume" || subPath === "resume")) {
						const body = await readBody(req);
						const sessions = listSessions({ limit: 500, excludeCwdPatterns: excludePatterns() });
						const target = sessions.find((s) => s.file === body.file);
						if (!target) return json(res, 404, { error: "unknown session file" });
						const result = await spawnSession({ cwd: target.cwd, resumeFile: target.file });
						return json(res, 200, result);
					}
					if (req.method === "POST" && (subPath === "/spawn" || subPath === "spawn")) {
						const body = await readBody(req);
						if (!body.cwd) return json(res, 400, { error: "cwd required" });
						const result = await spawnSession({ cwd: body.cwd, prompt: body.prompt, model: body.model });
						return json(res, 200, result);
					}
					return json(res, 404, { error: "not found" });
				} catch (err) {
					return json(res, 500, { error: String((err as Error).message ?? err) });
				}
			},
		});
	});
}
