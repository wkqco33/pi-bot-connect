/**
 * pi extension entry point.
 *
 * This is the only file that knows about pi. It is a thin shell:
 *
 *   pi events  ──► Bridge (transport-agnostic core)  ──► Transports
 *   pi API     ◄── BridgeHost                          ◄── Envelope
 *
 * Everything testable lives in `src/core/` and `src/bridge.ts`. Keep this file
 * free of decisions — if you are about to add an `if` that encodes policy,
 * that policy belongs in the core with a test.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Bridge, type BridgeHost } from "./bridge.js";
import { parseConfigFile } from "./config.js";
import { formatDuration } from "./core/commands.js";
import { buildWorkDigest } from "./core/digest.js";
import { extractAssistantText, summarize } from "./core/message.js";
import { formatChallengeCode } from "./core/pairing.js";
import { resolveConfig, type BridgeConfig, type Logger } from "./core/types.js";
import { createTransports, listTransportFactories } from "./transports/index.js";

const COMMAND_KEY = "bot-connect";
const DEBUG = process.env.PI_BOT_CONNECT_DEBUG === "1" || process.env.PI_BOT_CONNECT_DEBUG === "true";

const logger: Logger = {
	debug: (message, meta) => {
		if (DEBUG) console.debug(`[${COMMAND_KEY}] ${message}`, meta ?? "");
	},
	info: (message, meta) => {
		if (DEBUG) console.info(`[${COMMAND_KEY}] ${message}`, meta ?? "");
	},
	warn: (message, meta) => console.warn(`[${COMMAND_KEY}] ${message}`, meta ?? ""),
	error: (message, meta) => console.error(`[${COMMAND_KEY}] ${message}`, meta ?? ""),
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

interface LoadedConfig {
	readonly config: BridgeConfig;
	readonly transports: Readonly<Record<string, unknown>>;
	readonly notes: readonly string[];
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		try {
			return JSON.parse(raw) as unknown;
		} catch {
			return { __parseError: `invalid JSON in ${path}` };
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function configPaths(cwd: string): { global: string; project: string } {
	return {
		global: join(homedir(), CONFIG_DIR_NAME, "agent", `${COMMAND_KEY}.json`),
		project: join(cwd, CONFIG_DIR_NAME, `${COMMAND_KEY}.json`),
	};
}

/** Global config first, project config second (project wins). */
async function loadBridgeConfig(cwd: string): Promise<LoadedConfig> {
	const paths = configPaths(cwd);
	const notes: string[] = [];
	let merged: Partial<BridgeConfig> = {};
	let transports: Record<string, unknown> = {};

	for (const [scope, path] of [
		["global", paths.global],
		["project", paths.project],
	] as const) {
		const raw = await readJsonFile(path);
		if (raw === undefined) continue;
		const parsed = parseConfigFile(raw);
		for (const error of parsed.errors) notes.push(`${scope} config: ${error}`);
		for (const warning of parsed.warnings) notes.push(`${scope} config: ${warning}`);
		merged = { ...merged, ...parsed.config };
		transports = { ...transports, ...parsed.transports };
	}

	return { config: resolveConfig(merged), transports, notes };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default async function botConnect(pi: ExtensionAPI): Promise<void> {
	const loadTime = await loadBridgeConfig(process.cwd());
	const localCommand = loadTime.config.localCommand;

	let bridge: Bridge | null = null;
	let sessionCtx: ExtensionContext | null = null;
	let runningTool: string | undefined;
	let lastAssistantText = "";
	let lastUserPrompt = "";
	let progressSent = false;

	const host: BridgeHost = {
		sendPrompt(text, options) {
			try {
				if (options?.deliverAs) {
					pi.sendUserMessage(text, { deliverAs: options.deliverAs });
					return;
				}
				// Race guard: the agent may have become busy since routing.
				if (sessionCtx && !sessionCtx.isIdle()) {
					pi.sendUserMessage(text, { deliverAs: "followUp" });
					return;
				}
				pi.sendUserMessage(text);
			} catch (error) {
				logger.error("failed to inject remote prompt", { error: String(error) });
				sessionCtx?.ui.notify(`[${COMMAND_KEY}] failed to inject prompt: ${String(error)}`, "error");
			}
		},
		abort() {
			sessionCtx?.abort();
		},
		isIdle() {
			return sessionCtx ? sessionCtx.isIdle() : true;
		},
		notify(text, level) {
			sessionCtx?.ui.notify(`[${COMMAND_KEY}] ${text}`, level ?? "info");
		},
		get cwd() {
			return sessionCtx?.cwd ?? process.cwd();
		},
		get sessionName() {
			return pi.getSessionName();
		},
		now: () => Date.now(),
		random: () => Math.random(),
		logger,
	};

	function statusLabel(): string {
		if (!bridge) return `${COMMAND_KEY}: off`;
		const ids = bridge.transportIds;
		return ids.length > 0 ? `${COMMAND_KEY}: ${ids.join(",")}` : `${COMMAND_KEY}: no transports`;
	}

	function renderStatus(): string {
		if (!bridge) return `${COMMAND_KEY}: no active session.`;
		const snapshot = bridge.snapshot();
		const lines = [
			`${COMMAND_KEY} status`,
			`- transports: ${snapshot.transports.length > 0 ? snapshot.transports.join(", ") : "(none configured)"}`,
			`- paired chats: ${snapshot.trusted.length}`,
			`- conversations: ${snapshot.conversations}`,
			`- paused: ${snapshot.paused.length > 0 ? snapshot.paused.join(", ") : "none"}`,
			`- pending codes: ${snapshot.pending.length}`,
		];
		const factories = listTransportFactories();
		if (factories.length === 0) {
			lines.push("", "No transports are implemented yet. See docs/architecture.md.");
		}
		lines.push("", `Local commands: /${localCommand} status|pair|digest|pause|resume|disconnect|config`);
		return lines.join("\n");
	}

	async function buildDigest(ctx: ExtensionContext): Promise<string> {
		const active = bridge;
		return buildWorkDigest(
			{
				cwd: ctx.cwd,
				agentState: ctx.isIdle() ? "idle" : "busy",
				sessionName: pi.getSessionName(),
				runningTool,
				lastUserPrompt: lastUserPrompt.length > 0 ? lastUserPrompt : undefined,
				lastAssistantSummary: lastAssistantText.length > 0 ? summarize(lastAssistantText, 300) : undefined,
			},
			{ maxLength: active?.config.digest.maxLength },
		);
	}

	async function handleLocalCommand(args: string, ctx: ExtensionContext): Promise<void> {
		const sub = args.trim().split(/\s+/)[0] ?? "";
		const active = bridge;

		if (sub === "" || sub === "help") {
			ctx.ui.notify(renderStatus(), "info");
			return;
		}

		if (sub === "status") {
			ctx.ui.notify(renderStatus(), "info");
			return;
		}

		if (!active) {
			ctx.ui.notify(`${COMMAND_KEY}: no active session.`, "warning");
			return;
		}

		if (sub === "pair") {
			const snapshot = active.snapshot();
			if (snapshot.pending.length === 0) {
				ctx.ui.notify("No pending pairing. Have the remote user send any message; the code appears here.", "info");
				return;
			}
			const now = Date.now();
			const lines = snapshot.pending.map(
				(entry) =>
					`- ${entry.key}: ${formatChallengeCode(entry.code)} (expires in ${formatDuration(entry.expiresAt - now)})`,
			);
			ctx.ui.notify(`Pending pairing codes:\n${lines.join("\n")}`, "info");
			return;
		}

		if (sub === "digest") {
			const digest = await buildDigest(ctx);
			const delivered = await active.publish("digest", digest);
			ctx.ui.notify(
				delivered > 0 ? `Digest sent to ${delivered} conversation(s).` : "No paired conversation to send a digest to.",
				delivered > 0 ? "info" : "warning",
			);
			return;
		}

		if (sub === "pause" || sub === "resume") {
			const paused = sub === "pause";
			const targets = active.store.listConversations();
			for (const target of targets) {
				active.store.setPaused(`${target.transport}:${target.conversationId}`, paused);
			}
			ctx.ui.notify(`${paused ? "Paused" : "Resumed"} ${targets.length} conversation(s).`, "info");
			return;
		}

		if (sub === "disconnect") {
			const trusted = active.store.listTrusted();
			for (const identity of trusted) active.store.revoke(identity);
			ctx.ui.notify(`Revoked ${trusted.length} pairing(s).`, "info");
			return;
		}

		if (sub === "config") {
			ctx.ui.notify(`${COMMAND_KEY} config:\n${JSON.stringify(active.config, null, 2)}`, "info");
			return;
		}

		ctx.ui.notify(`Unknown subcommand '${sub}'. Try /${localCommand} help.`, "warning");
	}

	// --- local command surface ------------------------------------------------

	pi.registerCommand(localCommand, {
		description: "Local control for the messenger bridge (status, pair, digest, pause, resume, disconnect)",
		handler: async (args, ctx) => {
			await handleLocalCommand(args, ctx);
		},
	});

	// --- lifecycle ------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		const loaded = await loadBridgeConfig(ctx.cwd);
		const created = createTransports(loaded.transports, logger);

		bridge = new Bridge({ host, config: loaded.config });
		for (const transport of created.transports) {
			await bridge.register(transport);
		}

		ctx.ui.setStatus(COMMAND_KEY, statusLabel());

		const notes = [...loaded.notes];
		if (created.skipped.length > 0) notes.push(`disabled transports: ${created.skipped.join(", ")}`);
		if (notes.length > 0) ctx.ui.notify(`[${COMMAND_KEY}]\n${notes.join("\n")}`, "warning");
	});

	pi.on("session_shutdown", async () => {
		await bridge?.stop();
		bridge = null;
		sessionCtx = null;
		runningTool = undefined;
		lastAssistantText = "";
		lastUserPrompt = "";
		progressSent = false;
	});

	// --- session tracking for digest + progress -------------------------------

	pi.on("before_agent_start", async (event, ctx) => {
		sessionCtx = ctx;
		lastUserPrompt = event.prompt;
	});

	pi.on("agent_start", async (_event, ctx) => {
		sessionCtx = ctx;
		progressSent = false;
		lastAssistantText = "";
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		sessionCtx = ctx;
		runningTool = event.toolName;
		// One coalesced progress ping per turn. Tool arguments are never sent:
		// they routinely contain paths, tokens and file contents.
		if (!bridge || progressSent) return;
		progressSent = true;
		await bridge.publish("progress", `▶ ${event.toolName}`);
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		sessionCtx = ctx;
		runningTool = undefined;
	});

	pi.on("message_end", async (event, ctx) => {
		sessionCtx = ctx;
		if (event.message.role !== "assistant") return;
		const text = extractAssistantText(event.message.content);
		if (text.length > 0) lastAssistantText = text;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		sessionCtx = ctx;
		runningTool = undefined;
		ctx.ui.setStatus(COMMAND_KEY, statusLabel());
		if (!bridge || lastAssistantText.length === 0) return;
		const summary = summarize(lastAssistantText, 1200);
		lastAssistantText = "";
		await bridge.publish("reply", summary);
	});
}
