/**
 * local-models — /serve: start/stop the lab's local llama.cpp model servers
 * and switch to them, from inside pi (TUI twin of the web UI's model sheet).
 *
 *   /serve                → interactive picker over managed local models
 *                           (start & switch / stop, with live ●/○ state)
 *   /serve <provider/id>  → start that server (if needed) and switch to it
 *   /serve stop <provider/id> → stop that server
 *
 * Managed servers are configured in settings.json → localModels (compose dir
 * + health URL + optional mutual-exclusion group); see lib/local-models.mjs.
 * Starting a "heavy"-group model composes the other heavies down first so
 * everything fits in RAM. Loading a big model takes minutes — progress is
 * shown via notifications.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { annotate, readLocalModels, startModel, stopModel } from "../lib/local-models.mjs";

export default function (pi: ExtensionAPI) {
	// Bots must not manage model servers.
	if (process.env["PI_BOT_PERMISSION_POLICY"]) return;
	if (Number(process.env["PIBOT_SUBAGENT_DEPTH"] ?? "0") >= 1) return;

	async function switchTo(ctx: ExtensionContext, ref: string): Promise<void> {
		const slash = ref.indexOf("/");
		const model = slash > 0 ? ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
		if (!model) {
			ctx.ui.notify(`Model not in registry: ${ref}`, "error");
			return;
		}
		if (await pi.setModel(model)) ctx.ui.notify(`Now on ${ref}`);
		else ctx.ui.notify(`Server is up but switching to ${ref} failed`, "error");
	}

	async function startAndSwitch(ctx: ExtensionContext, ref: string): Promise<void> {
		ctx.ui.notify(`Starting ${ref} — big models take a few minutes to load…`);
		try {
			await startModel(ref, {
				onProgress: (stage) => {
					if (stage.startsWith("stopping:")) ctx.ui.notify(`Freeing RAM: stopping ${stage.slice(9)}`);
				},
			});
			await switchTo(ctx, ref);
		} catch (err) {
			ctx.ui.notify(`Failed to start ${ref}: ${String((err as Error).message ?? err)}`, "error");
		}
	}

	pi.registerCommand("serve", {
		description: "Start/stop local model servers and switch: /serve [stop] [provider/id]",
		handler: async (args, ctx) => {
			const managed = readLocalModels();
			const refs = Object.keys(managed);
			if (refs.length === 0) {
				ctx.ui.notify("No managed local models (settings.json → localModels)", "warning");
				return;
			}

			const arg = (args ?? "").trim();
			if (arg.startsWith("stop ")) {
				const ref = arg.slice(5).trim();
				try {
					await stopModel(ref);
					ctx.ui.notify(`Stopped ${ref}`);
				} catch (err) {
					ctx.ui.notify(String((err as Error).message ?? err), "error");
				}
				return;
			}
			if (arg) return startAndSwitch(ctx, arg);

			if (!ctx.hasUI) return;
			const states = await annotate(refs);
			const options = states.map((s) => `${s.running ? "●" : "○"} ${s.ref}${s.running ? "  — running (pick to switch, or stop below)" : "  — stopped (pick to start & switch)"}`);
			const stopOptions = states.filter((s) => s.running).map((s) => `stop ${s.ref}`);
			const choice = await ctx.ui.select("Local model servers:", [...options, ...stopOptions]);
			if (!choice) return;
			if (choice.startsWith("stop ")) {
				try {
					await stopModel(choice.slice(5));
					ctx.ui.notify(`Stopped ${choice.slice(5)}`);
				} catch (err) {
					ctx.ui.notify(String((err as Error).message ?? err), "error");
				}
				return;
			}
			const ref = choice.slice(2).split("  —")[0].trim();
			const state = states.find((s) => s.ref === ref);
			if (state?.running) return switchTo(ctx, ref);
			return startAndSwitch(ctx, ref);
		},
	});
}
