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
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Bridge, MemoryBridgeStore, type BridgeHost, type BridgeStore } from "./bridge.js";
import { parseConfigFile } from "./config.js";
import { formatDuration } from "./core/commands.js";
import { buildWorkDigest } from "./core/digest.js";
import type { DigestFileChange } from "./core/digest.js";
import type { DigestTodo } from "./core/digest.js";
import { extractAssistantText, extractToolText, summarize } from "./core/message.js";
import { formatChallengeCode } from "./core/pairing.js";
import { formatVersionReport, parsePackageMeta, VERSION_UNAVAILABLE_NOTICE, type PackageMeta } from "./core/version.js";
import { toolEndLabel, toolStartLabel } from "./core/progress.js";
import { extractMarkdownTodos } from "./core/todo.js";
import {
	decideRemoteToolAccess,
	remoteToolApprovalPrompt,
	remoteToolBlockReason,
	remoteToolDeclinedReason,
	type RemoteToolPolicy,
} from "./core/tool-policy.js";
import { resolveConfig, type BridgeConfig, type Logger, type PromptImage } from "./core/types.js";
import { parseGitBranch, parseGitNumstat, summarizeTestRun } from "./core/work.js";
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
 * Installed extension directory. pi exposes no version getter, so the manifest
 * next to `src/` is the source of truth. It resolves inside the installed
 * package because the published tarball keeps `src/` and `package.json` together.
 */
function packagePath(): string {
	return fileURLToPath(new URL("../package.json", import.meta.url));
}

async function loadPackageMeta(): Promise<PackageMeta | null> {
	const raw = await readJsonFile(packagePath());
	if (raw === undefined || !raw.ok) return null;
	return parsePackageMeta(raw.value);
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

/**
 * Builds the content pi expects. A text-only prompt stays a plain string so that
 * skill and template expansion keep working for remote commands.
 *
 * NOTE: pi's `ImageContent` is flat (`{ type, data, mimeType }`). The nested
 * `source: { type: "base64", mediaType, data }` shape in `docs/extensions.md`
 * is stale; the compiler is authoritative here.
 */
function buildPromptContent(
	text: string,
	images: readonly PromptImage[] | undefined,
): string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
	if (images === undefined || images.length === 0) return text;
	return [
		{ type: "text", text },
		...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mediaType })),
	];
}

/** The last shell command the agent ran, used for the digest's test line. */
interface LastShellRun {
	readonly command: string;
	readonly failed: boolean;
	readonly output: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default async function botConnect(pi: ExtensionAPI): Promise<void> {
	const loadTime = await loadBridgeConfig(process.cwd());
	const localCommand = loadTime.config.localCommand;
	const extensionMeta = await loadPackageMeta();

	let bridge: Bridge | null = null;
	let store: FileBridgeStore | null = null;
	let currentSessionKey = "ephemeral";
	let sessionCtx: ExtensionContext | null = null;
	let runningTool: string | undefined;
	/** True for the duration of a turn that a messenger started (G1). */
	let remoteTurn = false;
	let lastAssistantText = "";
	let lastUserPrompt = "";
	/** Latest assistant checklist, kept across turns for the digest's TODO section. */
	let lastTodos: DigestTodo[] = [];
	let lastShell: LastShellRun | null = null;
	/** Keyed by tool call id so parallel bash calls cannot overwrite each other. */
	const shellCommands = new Map<string, string>();

	const host: BridgeHost = {
		sendPrompt(text, options) {
			const content = buildPromptContent(text, options?.images);
			try {
				if (options?.deliverAs) {
					pi.sendUserMessage(content, { deliverAs: options.deliverAs });
					return;
				}
				// Race guard: the agent may have become busy since routing.
				if (sessionCtx && !sessionCtx.isIdle()) {
					pi.sendUserMessage(content, { deliverAs: "followUp" });
					return;
				}
				pi.sendUserMessage(content);
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
		// The host can hand base64 image content to the model. Whether a specific
		// transport can produce the bytes is decided per message by the bridge.
		acceptsAttachments: true,
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

	function versionLine(): string {
		return extensionMeta === null
			? "- extension: version unknown"
			: `- extension: ${extensionMeta.name} ${extensionMeta.version}`;
	}

	function renderVersion(): string {
		if (extensionMeta === null) return VERSION_UNAVAILABLE_NOTICE;
		return formatVersionReport({
			name: extensionMeta.name,
			version: extensionMeta.version,
			node: process.version,
			location: dirname(packagePath()),
		});
	}

	function renderStatus(): string {
		if (!bridge) return `${COMMAND_KEY}: no active session.`;
		const snapshot = bridge.snapshot();
		const lines = [
			`${COMMAND_KEY} status`,
			versionLine(),
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
		lines.push("", `Local commands: /${localCommand} status|doctor|version|pair|digest|pause|resume|disconnect|config`);
		return lines.join("\n");
	}

	function renderDoctor(): { text: string; healthy: boolean } {
		const lines = [`${COMMAND_KEY} doctor`, versionLine()];
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
		const work = await collectWorkContext(ctx.cwd);
		const testSummary = lastShell === null ? undefined : summarizeTestRun(lastShell);

		return buildWorkDigest(
			{
				cwd: ctx.cwd,
				agentState: ctx.isIdle() ? "idle" : "busy",
				sessionName: pi.getSessionName(),
				runningTool,
				lastUserPrompt: lastUserPrompt.length > 0 ? lastUserPrompt : undefined,
				lastAssistantSummary: lastAssistantText.length > 0 ? summarize(lastAssistantText, 300) : undefined,
				...(lastTodos.length > 0 ? { todos: lastTodos } : {}),
				...work,
				testSummary,
			},
			{ maxLength: active?.config.digest.maxLength },
		);
	}

	/**
	 * Gathers git state for the digest. Every failure is soft: a project that is
	 * not a git repository simply produces a digest without branch information.
	 */
	async function collectWorkContext(
		cwd: string,
	): Promise<{ branch?: string; changes?: DigestFileChange[] }> {
		const branchOutput = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
		const numstatOutput = await runGit(cwd, ["diff", "--numstat", "HEAD"]);

		const branch = branchOutput === null ? undefined : parseGitBranch(branchOutput);
		const changes = numstatOutput === null ? undefined : parseGitNumstat(numstatOutput, { max: 50 });

		return {
			...(branch === undefined ? {} : { branch }),
			...(changes === undefined ? {} : { changes }),
		};
	}

	async function runGit(cwd: string, args: readonly string[]): Promise<string | null> {
		try {
			// `-C` rather than a cwd option: the session cwd is not necessarily the
			// process cwd.
			const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: 5_000 });
			return result.code === 0 ? result.stdout : null;
		} catch (error) {
			logger.debug("git command failed", { args: args.join(" "), error: String(error) });
			return null;
		}
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

		if (sub === "version" || sub === "--version" || sub === "-v") {
			ctx.ui.notify(renderVersion(), extensionMeta === null ? "warning" : "info");
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
			if (delivered > 0) {
				ctx.ui.notify(`Digest sent to ${delivered} conversation(s).`, "info");
				return;
			}
			// Nothing is paired yet, so show the card locally instead of dropping it.
			ctx.ui.notify(`No paired conversation to send a digest to. Preview:\n\n${digest}`, "warning");
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
		description:
			"Local control for the messenger bridge (status, doctor, version, pair, digest, pause, resume, disconnect)",
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
		remoteTurn = false;
		lastTodos = [];
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
		remoteTurn = false;
		lastAssistantText = "";
		lastUserPrompt = "";
		lastTodos = [];
	});

	// --- session tracking for digest + progress -------------------------------

	pi.on("before_agent_start", async (event, ctx) => {
		sessionCtx = ctx;
		lastUserPrompt = event.prompt;
	});

	// A turn injected by the bridge (or any extension) is untrusted input. The
	// policy only ever applies to those turns; locally typed work is untouched.
	pi.on("input", async (event) => {
		remoteTurn = event.source === "extension";
	});

	pi.on("agent_start", async (_event, ctx) => {
		sessionCtx = ctx;
		lastAssistantText = "";
		// A new turn gets a new progress card instead of editing the last one, and
		// the card says what is happening while the model reasons (no tool events).
		bridge?.beginTurn();
		await bridge?.publishTurnStart();
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		sessionCtx = ctx;
		runningTool = event.toolName;
		if (event.toolName === "bash" && isRecord(event.args) && typeof event.args.command === "string") {
			shellCommands.set(event.toolCallId, event.args.command);
		}
		// Only the tool *name* is ever sent: arguments routinely carry paths, tokens
		// and file contents. The bridge throttles and edits one card per turn.
		await bridge?.publishProgress(toolStartLabel(event.toolName));
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		sessionCtx = ctx;
		runningTool = undefined;

		if (event.toolName === "bash") {
			const command = shellCommands.get(event.toolCallId);
			shellCommands.delete(event.toolCallId);
			if (command !== undefined) {
				lastShell = { command, failed: event.isError === true, output: extractToolText(event.result) };
			}
		}

		await bridge?.publishProgress(toolEndLabel(event.toolName, event.isError !== true));
	});

	pi.on("message_end", async (event, ctx) => {
		sessionCtx = ctx;
		if (event.message.role !== "assistant") return;
		const text = extractAssistantText(event.message.content);
		if (text.length > 0) lastAssistantText = text;
		const todos = extractMarkdownTodos(text);
		if (todos.length > 0) lastTodos = todos;
	});

	// Blocks a tool call on a messenger-originated turn per the configured policy,
	// and optionally asks the local operator to approve it. The decisions are pure
	// (`core/tool-policy.ts`); this handler only adapts them to pi.
	pi.on("tool_call", async (event, ctx) => {
		if (!remoteTurn) return undefined;
		const policy: RemoteToolPolicy = bridge?.config.remoteToolPolicy ?? "unrestricted";
		if (decideRemoteToolAccess(policy, event.toolName) === "block") {
			logger.warn("blocked a tool on a remote turn", { tool: event.toolName, policy });
			return { block: true, reason: remoteToolBlockReason(policy, event.toolName) };
		}
		if ((bridge?.config.remoteToolApproval ?? "off") !== "each") return undefined;

		const prompt = remoteToolApprovalPrompt(event.toolName);
		let approved = false;
		try {
			approved = await ctx.ui.confirm(prompt.title, prompt.message);
		} catch (error) {
			logger.warn("tool approval prompt failed", { error: String(error) });
		}
		if (approved) return undefined;
		logger.warn("operator declined a remote tool", { tool: event.toolName });
		return { block: true, reason: remoteToolDeclinedReason(event.toolName) };
	});

	pi.on("agent_settled", async (_event, ctx) => {
		sessionCtx = ctx;
		runningTool = undefined;
		remoteTurn = false;
		ctx.ui.setStatus(COMMAND_KEY, statusLabel());
		const text = lastAssistantText;
		lastAssistantText = "";
		if (!bridge || text.length === 0) return;
		// The bridge redacts, renders and splits to the transport's limit, so the
		// full answer goes out instead of a summary truncated to fit one message.
		await bridge.publish("reply", text);
	});
}
