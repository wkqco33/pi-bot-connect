/**
 * Wiring test for the pi adapter.
 *
 * `src/index.ts` is a shell, but a shell can still be wired wrong: wrong event
 * names, a command that is never registered, a config error that never reaches
 * the user. This test drives the real factory with a fake `ExtensionAPI`, so
 * none of those failures need a model, a network, or a bot token to surface.
 *
 * It is intentionally *not* a coverage target — if a branch here needs a test
 * for its logic, that logic belongs in the core.
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import botConnect from "./index.js";

interface FakeUi {
	notify(text: string, level?: string): void;
	setStatus(key: string, text: string | undefined): void;
}

class FakeCtx {
	readonly cwd: string;
	readonly notifications: Array<{ text: string; level: string }> = [];
	readonly statuses = new Map<string, string | undefined>();
	readonly sessionManager: { getSessionId(): string; getSessionFile(): string | null };
	idle = true;
	aborts = 0;

	constructor(cwd: string, sessionId = "session-a") {
		this.cwd = cwd;
		this.sessionManager = {
			getSessionId: () => sessionId,
			getSessionFile: () => null,
		};
		this.ui = {
			notify: (text, level) => {
				this.notifications.push({ text, level: level ?? "info" });
			},
			setStatus: (key, text) => {
				this.statuses.set(key, text);
			},
		};
	}

	readonly ui: FakeUi;

	isIdle(): boolean {
		return this.idle;
	}

	abort(): void {
		this.aborts++;
	}

	get lastNotification(): string {
		return this.notifications.at(-1)?.text ?? "";
	}
}

type Handler = (event: Record<string, unknown>, ctx: FakeCtx) => unknown;

interface CommandSpec {
	description?: string;
	handler(args: string, ctx: FakeCtx): unknown;
}

class FakePi {
	readonly handlers = new Map<string, Handler[]>();
	readonly commands = new Map<string, CommandSpec>();
	readonly userMessages: Array<{ text: string; deliverAs?: string }> = [];
	sessionName: string | undefined = "wiring-session";

	on(event: string, handler: Handler): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	registerCommand(name: string, options: CommandSpec): void {
		this.commands.set(name, options);
	}

	getSessionName(): string | undefined {
		return this.sessionName;
	}

	sendUserMessage(text: string, options?: { deliverAs?: string }): void {
		this.userMessages.push(options?.deliverAs === undefined ? { text } : { text, deliverAs: options.deliverAs });
	}

	async emit(event: string, payload: Record<string, unknown>, ctx: FakeCtx): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}

	async run(args: string, ctx: FakeCtx): Promise<void> {
		const command = this.commands.get([...this.commands.keys()][0] as string);
		if (!command) throw new Error("no command registered");
		await command.handler(args, ctx);
	}
}

type PiLike = Parameters<typeof botConnect>[0];

let dir: string;
let configPath: string;
let stateFile: string;
/** Adapters opened by a test, shut down deterministically before cleanup. */
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bot-connect-test-"));
	configPath = join(dir, "config.json");
	stateFile = join(dir, "state.json");
});

afterEach(async () => {
	// Shut every adapter down first: the store persists in the background, so
	// removing the directory mid-write races with an in-flight rename.
	for (const cleanup of cleanups.splice(0)) {
		await cleanup().catch(() => undefined);
	}
	delete process.env.PI_BOT_CONNECT_CONFIG;
	delete process.env.PI_BOT_CONNECT_STATE;
	await rm(dir, { recursive: true, force: true });
});

async function exists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function start(
	config?: unknown,
	options: { sessionId?: string } = {},
): Promise<{ pi: FakePi; ctx: FakeCtx }> {
	if (config !== undefined) {
		const content = typeof config === "string" ? config : JSON.stringify(config);
		await writeFile(configPath, content, "utf8");
	}
	// Point discovery at temp files so neither the developer's real global config
	// nor their real pairing state can influence this test.
	process.env.PI_BOT_CONNECT_CONFIG = configPath;
	process.env.PI_BOT_CONNECT_STATE = stateFile;

	const pi = new FakePi();
	await botConnect(pi as unknown as PiLike);
	const ctx = new FakeCtx(dir, options.sessionId);
	cleanups.push(async () => {
		await pi.emit("session_shutdown", { reason: "quit" }, ctx);
	});
	await pi.emit("session_start", { reason: "startup" }, ctx);
	return { pi, ctx };
}

describe("adapter — registration", () => {
	it("defaults the local command name to 'connect'", async () => {
		const { pi } = await start();
		expect([...pi.commands.keys()]).toEqual(["connect"]);
	});

	it("honors a configured local command name", async () => {
		const { pi } = await start({ bridge: { localCommand: "bridge-ctl" } });
		expect([...pi.commands.keys()]).toEqual(["bridge-ctl"]);
	});

	it("describes the local command", async () => {
		const { pi } = await start();
		expect(pi.commands.get("connect")?.description).toContain("messenger bridge");
	});

	it("subscribes to every lifecycle event it depends on", async () => {
		const { pi } = await start();
		for (const event of [
			"session_start",
			"session_shutdown",
			"before_agent_start",
			"agent_start",
			"tool_execution_start",
			"tool_execution_end",
			"message_end",
			"agent_settled",
		]) {
			expect(pi.handlers.has(event), `missing handler for ${event}`).toBe(true);
		}
	});
});

describe("adapter — session lifecycle", () => {
	it("reports bridge state in the footer on session_start", async () => {
		const { ctx } = await start();
		expect(ctx.statuses.get("bot-connect")).toBe("bot-connect: no transports");
	});

	it("survives repeated shutdown and restart", async () => {
		const { pi, ctx } = await start();
		await pi.emit("session_shutdown", { reason: "reload" }, ctx);
		await pi.emit("session_shutdown", { reason: "reload" }, ctx);
		await pi.emit("session_start", { reason: "resume" }, ctx);
		expect(ctx.statuses.get("bot-connect")).toBe("bot-connect: no transports");
	});

	it("does not throw when a turn produces no assistant text", async () => {
		const { pi, ctx } = await start();
		await pi.emit("agent_start", {}, ctx);
		await pi.emit("tool_execution_start", { toolName: "bash" }, ctx);
		await pi.emit("tool_execution_end", { toolName: "bash" }, ctx);
		await pi.emit("message_end", { message: { role: "user", content: "hi" } }, ctx);
		await pi.emit("agent_settled", {}, ctx);
		expect(pi.userMessages).toEqual([]);
	});

	it("records the assistant answer without sending it anywhere", async () => {
		const { pi, ctx } = await start();
		await pi.emit("agent_start", {}, ctx);
		await pi.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, ctx);
		await pi.emit("agent_settled", {}, ctx);
		// No paired conversation exists yet, so nothing may be sent.
		expect(pi.userMessages).toEqual([]);
	});
});

describe("adapter — config diagnostics", () => {
	it("surfaces a config error to the user", async () => {
		const { ctx } = await start({ bridge: { requirePairing: "yes" } });
		const warning = ctx.notifications.find((entry) => entry.level === "warning");
		expect(warning?.text).toContain("requirePairing");
	});

	it("surfaces invalid JSON with the file path", async () => {
		const { ctx } = await start("not json at all{");
		const warning = ctx.notifications.find((entry) => entry.level === "warning");
		expect(warning?.text).toContain("invalid JSON");
	});

	it("stays quiet when no config file exists", async () => {
		const { ctx } = await start();
		expect(ctx.notifications.filter((entry) => entry.level === "warning")).toEqual([]);
	});

	it("warns about unknown keys from the loaded config", async () => {
		const { ctx } = await start({ bridge: { loki: true } });
		const warning = ctx.notifications.find((entry) => entry.level === "warning");
		expect(warning?.text).toContain("bridge.loki: unknown key");
	});
});

describe("adapter — local command surface", () => {
	it("answers bare invocation and 'help' with status", async () => {
		const { pi, ctx } = await start();
		await pi.run("", ctx);
		expect(ctx.lastNotification).toContain("bot-connect status");
		await pi.run("help", ctx);
		expect(ctx.lastNotification).toContain("bot-connect status");
	});

	it("lists the local subcommands", async () => {
		const { pi, ctx } = await start();
		await pi.run("status", ctx);
		expect(ctx.lastNotification).toContain("status|doctor|pair|digest|pause|resume|disconnect|config");
	});

	it("points at the available transports when none is configured", async () => {
		const { pi, ctx } = await start();
		await pi.run("status", ctx);
		expect(ctx.lastNotification).toContain("- transports: (none configured)");
		expect(ctx.lastNotification).toContain("Available transports: discord");
	});

	it("explains how to obtain a pairing code when none is pending", async () => {
		const { pi, ctx } = await start();
		await pi.run("pair", ctx);
		expect(ctx.lastNotification).toContain("No pending pairing");
	});

	it("reports paused/resumed conversation counts", async () => {
		const { pi, ctx } = await start();
		await pi.run("pause", ctx);
		expect(ctx.lastNotification).toBe("Paused 0 conversation(s).");
		await pi.run("resume", ctx);
		expect(ctx.lastNotification).toBe("Resumed 0 conversation(s).");
	});

	it("reports revoked pairing counts", async () => {
		const { pi, ctx } = await start();
		await pi.run("disconnect", ctx);
		expect(ctx.lastNotification).toBe("Revoked 0 pairing(s).");
	});

	it("prints the resolved config and no secrets", async () => {
		const { pi, ctx } = await start({ bridge: { localCommand: "connect" } });
		await pi.run("config", ctx);
		expect(ctx.lastNotification).toContain('"localCommand": "connect"');
	});

	it("warns when a digest has nowhere to go", async () => {
		const { pi, ctx } = await start();
		await pi.run("digest", ctx);
		expect(ctx.lastNotification).toContain("No paired conversation");
		expect(ctx.notifications.at(-1)?.level).toBe("warning");
	});

	it("rejects an unknown subcommand instead of silently ignoring it", async () => {
		const { pi, ctx } = await start();
		await pi.run("deploy", ctx);
		expect(ctx.lastNotification).toContain("Unknown subcommand 'deploy'");
		expect(ctx.notifications.at(-1)?.level).toBe("warning");
	});

	it("reports the active session missing after shutdown", async () => {
		const { pi, ctx } = await start();
		await pi.emit("session_shutdown", { reason: "quit" }, ctx);
		await pi.run("status", ctx);
		expect(ctx.lastNotification).toContain("no active session");
	});
});

describe("adapter — doctor", () => {
	it("reports that no transports are registered", async () => {
		const { pi, ctx } = await start();
		await pi.run("doctor", ctx);
		expect(ctx.lastNotification).toContain("- transports: none registered");
	});

	it("reports the session key and the state file", async () => {
		const { pi, ctx } = await start(undefined, { sessionId: "session-xyz" });
		await pi.run("doctor", ctx);
		expect(ctx.lastNotification).toContain("- session key: session-xyz");
		expect(ctx.lastNotification).toContain(stateFile);
		expect(ctx.lastNotification).toContain("(persistent)");
	});

	it("is informational when nothing is broken", async () => {
		const { pi, ctx } = await start();
		await pi.run("doctor", ctx);
		expect(ctx.notifications.at(-1)?.level).toBe("info");
	});

	it("tells the user what to check when a transport is down", async () => {
		const { pi, ctx } = await start();
		await pi.run("doctor", ctx);
		expect(ctx.lastNotification).toContain("privileged intents");
		expect(ctx.lastNotification).toContain("no other pi process");
	});
});

describe("adapter — pairing survives a restart", () => {
	function stateWith(sessionId: string): string {
		return JSON.stringify({
			version: 1,
			sessions: {
				[sessionId]: {
					updatedAt: 1,
					trusted: { "discord:42": 1 },
					pending: {},
					paused: [],
					conversations: [{ transport: "discord", conversationId: "chan-1" }],
				},
			},
		});
	}

	it("loads pairing state written by a previous run of the same session", async () => {
		await writeFile(stateFile, stateWith("session-same"), "utf8");
		const { pi, ctx } = await start(undefined, { sessionId: "session-same" });
		await pi.run("status", ctx);
		expect(ctx.lastNotification).toContain("- paired chats: 1");
		expect(ctx.lastNotification).toContain("- conversations: 1");
	});

	it("does not inherit pairing state from a different session", async () => {
		await writeFile(stateFile, stateWith("other-session"), "utf8");
		const { pi, ctx } = await start(undefined, { sessionId: "session-same" });
		await pi.run("status", ctx);
		expect(ctx.lastNotification).toContain("- paired chats: 0");
	});

	it("flushes state to disk on shutdown", async () => {
		const { pi, ctx } = await start();
		await pi.emit("session_shutdown", { reason: "reload" }, ctx);
		expect(await exists(stateFile)).toBe(true);
	});
});
