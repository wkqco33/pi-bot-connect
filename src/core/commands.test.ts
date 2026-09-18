import { describe, expect, it } from "vitest";
import {
	executeRemoteCommand,
	findRemoteCommand,
	formatDuration,
	parseRemoteCommand,
	remoteCommandNames,
	remoteHelpText,
	resolveRemoteCommandName,
	type RemoteCommandContext,
} from "./commands.js";
import { resolveConfig } from "./types.js";

const PARSE_OPTIONS = {
	prefixes: ["/", "connect ", "bot "],
	botUsername: "piBot",
	knownCommands: remoteCommandNames(),
};

function context(overrides: Partial<RemoteCommandContext> = {}): RemoteCommandContext {
	return {
		transport: "fake",
		identity: "fake:u1",
		conversationId: "c1",
		config: resolveConfig(),
		sessionName: "refactor-bridge",
		cwd: "/work",
		busy: false,
		paused: false,
		now: 600_000,
		pairedAt: 300_000,
		...overrides,
	};
}

describe("formatDuration", () => {
	it("scales from seconds to days", () => {
		expect(formatDuration(5_000)).toBe("5s");
		expect(formatDuration(90_000)).toBe("1m");
		expect(formatDuration(3 * 3_600_000)).toBe("3h");
		expect(formatDuration(50 * 3_600_000)).toBe("2d");
	});

	it("clamps negative durations to zero", () => {
		expect(formatDuration(-1)).toBe("0s");
	});
});

describe("resolveRemoteCommandName", () => {
	it("resolves canonical names case-insensitively and strips a leading slash", () => {
		expect(resolveRemoteCommandName("STATUS")).toBe("status");
		expect(resolveRemoteCommandName("/help")).toBe("help");
	});

	it("resolves aliases", () => {
		expect(resolveRemoteCommandName("?")).toBe("help");
		expect(resolveRemoteCommandName("stop")).toBe("abort");
		expect(resolveRemoteCommandName("unpair")).toBe("disconnect");
	});

	it("returns null for unknown names and empty input", () => {
		expect(resolveRemoteCommandName("deploy")).toBeNull();
		expect(resolveRemoteCommandName("   ")).toBeNull();
	});
});

describe("parseRemoteCommand", () => {
	it("parses a slash command with no arguments", () => {
		expect(parseRemoteCommand("/status", PARSE_OPTIONS)).toEqual({
			name: "status",
			args: "",
			raw: "/status",
		});
	});

	it("keeps the argument tail verbatim", () => {
		expect(parseRemoteCommand("/status  verbose now ", PARSE_OPTIONS)?.args).toBe("verbose now");
	});

	it("treats a bare prefix as a help request", () => {
		expect(parseRemoteCommand("/", PARSE_OPTIONS)?.name).toBe("help");
		expect(parseRemoteCommand("@piBot", PARSE_OPTIONS)?.name).toBe("help");
	});

	it("parses word prefixes used by Discord and Slack", () => {
		expect(parseRemoteCommand("bot status", PARSE_OPTIONS)?.name).toBe("status");
		expect(parseRemoteCommand("connect status", PARSE_OPTIONS)?.name).toBe("status");
	});

	it("parses an @mention followed by a command", () => {
		expect(parseRemoteCommand("@piBot status", PARSE_OPTIONS)?.name).toBe("status");
		expect(parseRemoteCommand("@pibot pause", PARSE_OPTIONS)?.name).toBe("pause");
	});

	it("does not treat ordinary prose after a mention as a command", () => {
		expect(parseRemoteCommand("@piBot fix the failing test", PARSE_OPTIONS)).toBeNull();
	});

	it("does not treat an unknown slash word as a bridge command", () => {
		expect(parseRemoteCommand("/deploy prod", PARSE_OPTIONS)).toBeNull();
	});

	it("returns null for plain text", () => {
		expect(parseRemoteCommand("hello there", PARSE_OPTIONS)).toBeNull();
		expect(parseRemoteCommand("", PARSE_OPTIONS)).toBeNull();
	});

	it("is case-insensitive for prefixes", () => {
		expect(parseRemoteCommand("BOT STATUS", PARSE_OPTIONS)?.name).toBe("status");
	});
});

describe("executeRemoteCommand", () => {
	it("returns null for an unknown command", () => {
		expect(executeRemoteCommand("deploy", "", context())).toBeNull();
	});

	it("describes bridge and agent state in status", () => {
		const result = executeRemoteCommand("status", "", context({ busy: true, paused: true }));
		expect(result?.text).toContain("fake:u1");
		expect(result?.text).toContain("refactor-bridge");
		expect(result?.text).toContain("- agent: busy");
		expect(result?.text).toContain("- delivery: paused");
		expect(result?.text).toContain("- paired: 5m ago");
	});

	it("omits the paired line when the pairing time is unknown", () => {
		const result = executeRemoteCommand("status", "", context({ pairedAt: undefined }));
		expect(result?.text).not.toContain("- paired:");
	});

	it("reports effects instead of doing I/O", () => {
		expect(executeRemoteCommand("pause", "", context())?.effect).toEqual({ type: "pause" });
		expect(executeRemoteCommand("resume", "", context())?.effect).toEqual({ type: "resume" });
		expect(executeRemoteCommand("abort", "", context())?.effect).toEqual({ type: "abort" });
		expect(executeRemoteCommand("disconnect", "", context())?.effect).toEqual({ type: "disconnect" });
	});

	it("returns no effect for read-only commands", () => {
		expect(executeRemoteCommand("status", "", context())?.effect).toBeUndefined();
		expect(executeRemoteCommand("help", "", context())?.effect).toBeUndefined();
	});
});

describe("command metadata", () => {
	it("finds a command by alias", () => {
		expect(findRemoteCommand("?")?.name).toBe("help");
	});

	it("lists every command in help output", () => {
		const help = remoteHelpText();
		for (const command of ["help", "status", "pause", "resume", "abort", "whoami", "disconnect"]) {
			expect(help).toContain(`/${command}`);
		}
	});

	it("exposes aliases as parseable names", () => {
		const names = remoteCommandNames();
		expect(names).toContain("?");
		expect(names).toContain("stop");
		expect(names).toContain("status");
	});
});
