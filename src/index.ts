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
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Bridge, MemoryBridgeStore, type BridgeHost, type BridgeStore } from "./bridge.js";
import { parseConfigFile } from "./config.js";
import { formatDuration } from "./core/commands.js";
import { buildWorkDigest } from "./core/digest.js";
import { extractAssistantText, summarize } from "./core/message.js";
import { formatChallengeCode } from "./core/pairing.js";
import { resolveConfig, type BridgeConfig, type Logger } from "./core/types.js";
import { FileBridgeStore } from "./file-store.js";
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

type JsonReadResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: string };

async function readJsonFile(path: string): Promise<JsonReadResult | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return { ok: false, error: `cannot read ${path}: ${String(error)}` };
	}
	try {
		return { ok: true, value: JSON.parse(raw) as unknown };
	} catch (error) {
		return { ok: false, error: `invalid JSON in ${path}: ${String(error)}` };
	}
}

function configPaths(cwd: string): { global: string; project: string } {
	return {
		global: join(homedir(), CONFIG_DIR_NAME, "agent", `${COMMAND_KEY}.json`),
		project: join(cwd, CONFIG_DIR_NAME, `${COMMAND_KEY}.json`),
	};
}

/**
 * `PI_BOT_CONNECT_CONFIG` replaces config discovery entirely. It exists so tests
 * and CI can run without depending on a developer's real global config.
 */
function configSources(cwd: string): ReadonlyArray<readonly [string, string]> {
	const override = process.env.PI_BOT_CONNECT_CONFIG;
	if (override !== undefined && override.length > 0) {
		return [["override", override]];
	}
	const paths = configPaths(cwd);
	return [
		["global", paths.global],
		["project", paths.project],
	];
}

/** Global config first, project config second (project wins). */
async function loadBridgeConfig(cwd: string): Promise<LoadedConfig> {
	const notes: string[] = [];
	let merged: Partial<BridgeConfig> = {};
	let transports: Record<string, unknown> = {};

	for (const [scope, path] of configSources(cwd)) {
		const raw = await readJsonFile(path);
		if (raw === undefined) continue;
		if (!raw.ok) {
			notes.push(`${scope} config: ${raw.error}`);
			continue;
		}
		const parsed = parseConfigFile(raw.value);
		for (const error of parsed.errors) notes.push(`${scope} config: ${error}`);
		for (const warning of parsed.warnings) notes.push(`${scope} config: ${warning}`);
		merged = { ...merged, ...parsed.config };
		transports = { ...transports, ...parsed.transports };
	}

	return { config: resolveConfig(merged), transports, notes };
}

/**
 * Directory for durable bridge state and lock files.
 * `PI_BOT_CONNECT_STATE` overrides the state file location (used by tests).
 */
function stateDir(): string {
	const override = process.env.PI_BOT_CONNECT_STATE;
	if (override !== undefined && override.length > 0 && dirname(override) !== ".") return dirname(override);
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Durable bridge state (trust, pending codes, broadcast targets). */
function statePath(): string {
	const override = process.env.PI_BOT_CONNECT_STATE;
	if (override !== undefined && override.length > 0) return override;
	return join(stateDir(), `${COMMAND_KEY}-state.json`);
}

/** Lock files live next to the state file; one per bot credential. */
function lockDir(): string {
	return join(stateDir(), "locks");
}

/**
 * Stable across `pi --continue` and `/reload`, new for `/new`. That is exactly
 * the key we want for scoping trust and broadcast targets.
 */
function sessionKey(ctx: ExtensionContext): string {
	try {
		const id = ctx.sessionManager.getSessionId();
		if (typeof id === "string" && id.length > 0) return id;
	} catch (error) {
		logger.debug("session id unavailable, falling back to the session file", { error: String(error) });
	}
	try {
		const file = ctx.sessionManager.getSessionFile();
		if (typeof file === "string" && file.length > 0) return file;
	} catch (error) {
		logger.debug("session file unavailable, using an ephemeral key", { error: String(error) });
	}
	return "ephemeral";
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default async function botConnect(pi: ExtensionAPI): Promise<void> {
	const loadTime = await loadBridgeConfig(process.cwd());
	const localCommand = loadTime.config.localCommand;

	let bridge: Bridge | null = null;
	let store: FileBridgeStore | null = null;
	let currentSessionKey = "ephemeral";
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
		// The host cannot hand attachment bytes to the model yet, so the router
		// rejects them instead of inventing a prompt about a missing image.
		acceptsAttachments: false,
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
		if (snapshot.transports.length === 0 && factories.length > 0) {
			const available = factories.map((factory) => factory.id).join(", ");
			lines.push("", `Available transports: ${available}. Configure one under "transports" in the config file.`);
		}
		lines.push("", `Local commands: /${localCommand} status|doctor|pair|digest|pause|resume|disconnect|config`);
		return lines.join("\n");
	}

	function renderDoctor(): { text: string; healthy: boolean } {
		const lines = [`${COMMAND_KEY} doctor`];
		if (!bridge) return { text: `${COMMAND_KEY}: no active session.`, healthy: false };

		const diagnostics = bridge.diagnostics();
		if (diagnostics.length === 0) lines.push("- transports: none registered");
		for (const entry of diagnostics) {
			lines.push(`- ${entry.id}: ${entry.status}${entry.detail === undefined ? "" : ` — ${entry.detail}`}`);
		}

		lines.push(`- session key: ${currentSessionKey}`);
		lines.push(`- state file: ${statePath()} (${store ? "persistent" : "in-memory"})`);

		const snapshot = bridge.snapshot();
		lines.push(`- paired chats: ${snapshot.trusted.length}`);
		lines.push(`- broadcast targets: ${snapshot.conversations}`);
		lines.push(`- pending codes: ${snapshot.pending.length}`);

		lines.push(
			"",
			"If a transport is not working, check in this order:",
			"1. credential present in the environment (never in the config file)",
			"2. bot invited/installed where you are talking to it",
			"3. privileged intents or message scopes enabled in the platform app settings",
			"4. no other pi process holds the same bot credential",
		);

		return { text: lines.join("\n"), healthy: !diagnostics.some((entry) => entry.status === "error") };
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

		if (sub === "doctor") {
			const report = renderDoctor();
			ctx.ui.notify(report.text, report.healthy ? "info" : "warning");
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
		description: "Local control for the messenger bridge (status, doctor, pair, digest, pause, resume, disconnect)",
		handler: async (args, ctx) => {
			await handleLocalCommand(args, ctx);
		},
	});

	// --- lifecycle ------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		const loaded = await loadBridgeConfig(ctx.cwd);
		const created = createTransports({
			transportConfig: loaded.transports,
			lockDir: lockDir(),
			logger,
		});

		currentSessionKey = sessionKey(ctx);
		const notes = [...loaded.notes, ...created.errors];
		let bridgeStore: BridgeStore;
		try {
			store = await FileBridgeStore.open({ path: statePath(), sessionId: currentSessionKey, logger });
			bridgeStore = store;
		} catch (error) {
			store = null;
			bridgeStore = new MemoryBridgeStore();
			logger.error("failed to open persistent store", { error: String(error) });
			notes.push(`could not open ${statePath()}: ${String(error)}. Pairing will not survive a restart.`);
		}

		bridge = new Bridge({ host, config: loaded.config, store: bridgeStore });
		for (const transport of created.transports) {
			await bridge.register(transport);
		}

		ctx.ui.setStatus(COMMAND_KEY, statusLabel());

		if (created.skipped.length > 0) notes.push(`disabled transports: ${created.skipped.join(", ")}`);
		if (notes.length > 0) ctx.ui.notify(`[${COMMAND_KEY}]\n${notes.join("\n")}`, "warning");
	});

	pi.on("session_shutdown", async () => {
		await bridge?.stop();
		bridge = null;
		// Persist before the session runtime goes away, so a reload or restart
		// does not force the user to pair again.
		if (store) {
			await store.flush();
			store = null;
		}
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
