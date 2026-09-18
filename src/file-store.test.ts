import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, MemoryLogSink } from "./core/logger.js";
import { FileBridgeStore, parseStoreSnapshot, STORE_VERSION } from "./file-store.js";

let dir: string;
let path: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bot-connect-store-"));
	path = join(dir, "state.json");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function readState(target: string): Promise<Record<string, unknown>> {
	let raw: string;
	try {
		raw = await readFile(target, "utf8");
	} catch (error) {
		throw new Error(`could not read ${target}: ${String(error)}`);
	}
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`state file is not JSON: ${String(error)}`);
	}
}

describe("parseStoreSnapshot", () => {
	it("rejects a non-object file", () => {
		const result = parseStoreSnapshot("nope");
		expect(result.snapshot).toEqual({ version: STORE_VERSION, sessions: {} });
		expect(result.warnings).toEqual(["store file: expected an object"]);
	});

	it("starts empty for an unsupported version", () => {
		const result = parseStoreSnapshot({ version: 99, sessions: { s1: {} } });
		expect(result.snapshot.sessions).toEqual({});
		expect(result.warnings[0]).toContain("unsupported version 99");
	});

	it("round-trips a full snapshot", () => {
		const result = parseStoreSnapshot({
			version: STORE_VERSION,
			sessions: {
				s1: {
					updatedAt: 7,
					trusted: { "discord:42": 5 },
					pending: { "discord:c1": { code: "123456", expiresAt: 9, attempts: 1 } },
					paused: ["discord:c1"],
					conversations: [{ transport: "discord", conversationId: "c1", threadId: "t1" }],
				},
			},
		});
		expect(result.warnings).toEqual([]);
		expect(result.snapshot.sessions.s1).toEqual({
			updatedAt: 7,
			trusted: { "discord:42": 5 },
			pending: { "discord:c1": { code: "123456", expiresAt: 9, attempts: 1 } },
			paused: ["discord:c1"],
			conversations: [{ transport: "discord", conversationId: "c1", threadId: "t1" }],
		});
	});

	it("drops a malformed trusted entry but keeps valid ones", () => {
		const result = parseStoreSnapshot({
			version: STORE_VERSION,
			sessions: { s1: { trusted: { "discord:42": 5, "discord:43": "soon" } } },
		});
		expect(result.snapshot.sessions.s1?.trusted).toEqual({ "discord:42": 5 });
		expect(result.warnings).toEqual(["sessions.s1.trusted.discord:43: expected a timestamp, ignored"]);
	});

	it("drops a malformed pending challenge", () => {
		const result = parseStoreSnapshot({
			version: STORE_VERSION,
			sessions: { s1: { pending: { good: { code: "1", expiresAt: 2, attempts: 0 }, bad: { code: 1 } } } },
		});
		expect(Object.keys(result.snapshot.sessions.s1?.pending ?? {})).toEqual(["good"]);
		expect(result.warnings[0]).toContain("sessions.s1.pending.bad");
	});

	it("drops a malformed conversation target", () => {
		const result = parseStoreSnapshot({
			version: STORE_VERSION,
			sessions: {
				s1: { conversations: [{ transport: "discord", conversationId: "c1" }, { transport: "discord" }, 7] },
			},
		});
		expect(result.snapshot.sessions.s1?.conversations).toEqual([{ transport: "discord", conversationId: "c1" }]);
		expect(result.warnings).toHaveLength(2);
	});

	it("drops a non-array paused list", () => {
		const result = parseStoreSnapshot({ version: STORE_VERSION, sessions: { s1: { paused: "discord:c1" } } });
		expect(result.snapshot.sessions.s1?.paused).toEqual([]);
		expect(result.warnings[0]).toContain("sessions.s1.paused");
	});

	it("drops a session that is not an object", () => {
		const result = parseStoreSnapshot({ version: STORE_VERSION, sessions: { s1: 5 } });
		expect(result.snapshot.sessions.s1).toEqual({
			trusted: {},
			pending: {},
			paused: [],
			conversations: [],
			updatedAt: 0,
		});
		expect(result.warnings[0]).toBe("sessions.s1: expected an object, ignored");
	});
});

describe("FileBridgeStore — durability", () => {
	it("writes the state file with owner-only permissions", async () => {
		const store = await FileBridgeStore.open({ path, sessionId: "s1" });
		await store.flush();
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("leaves no temporary file behind", async () => {
		const store = await FileBridgeStore.open({ path, sessionId: "s1" });
		store.trust("discord:42", 1);
		await store.flush();
		expect((await readdir(dirname(path))).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
	});

	it("survives a restart: a new instance on the same session sees the pairing", async () => {
		const first = await FileBridgeStore.open({ path, sessionId: "s1" });
		first.trust("discord:42", 1000);
		await first.flush();

		const second = await FileBridgeStore.open({ path, sessionId: "s1" });
		expect(second.isTrusted("discord:42")).toBe(true);
		expect(second.pairedAt("discord:42")).toBe(1000);
	});

	it("survives a restart: pending challenges and broadcast targets are kept", async () => {
		const first = await FileBridgeStore.open({ path, sessionId: "s1" });
		first.setPending("discord:c1", { code: "123456", expiresAt: 9, attempts: 1 });
		first.rememberConversation({ transport: "discord", conversationId: "c1", threadId: "t1" });
		first.setPaused("discord:c1", true);
		await first.flush();

		const second = await FileBridgeStore.open({ path, sessionId: "s1" });
		expect(second.getPending("discord:c1")).toEqual({ code: "123456", expiresAt: 9, attempts: 1 });
		expect(second.listPending()).toHaveLength(1);
		expect(second.listConversations()).toEqual([{ transport: "discord", conversationId: "c1", threadId: "t1" }]);
		expect(second.isPaused("discord:c1")).toBe(true);
	});

	it("writes a versioned file", async () => {
		const store = await FileBridgeStore.open({ path, sessionId: "s1" });
		await store.flush();
		expect((await readState(path)).version).toBe(STORE_VERSION);
	});

	it("starts empty and warns when the file is not valid JSON", async () => {
		await writeFile(path, "{ not json", "utf8");
		const sink = new MemoryLogSink();
		const store = await FileBridgeStore.open({
			path,
			sessionId: "s1",
			logger: createLogger("test", sink, "debug"),
		});
		expect(store.listTrusted()).toEqual([]);
		expect(sink.lines.join("")).toContain("not valid JSON");
	});

	it("flush resolves when there is nothing to write", async () => {
		const store = await FileBridgeStore.open({ path, sessionId: "s1" });
		await store.flush();
		await store.flush();
		expect(store.listTrusted()).toEqual([]);
	});
});

describe("FileBridgeStore — session isolation", () => {
	it("does not leak trust, targets or pause state between sessions", async () => {
		const first = await FileBridgeStore.open({ path, sessionId: "session-a" });
		first.trust("discord:42", 1);
		first.rememberConversation({ transport: "discord", conversationId: "c1" });
		first.setPaused("discord:c1", true);
		await first.flush();

		const second = await FileBridgeStore.open({ path, sessionId: "session-b" });
		expect(second.isTrusted("discord:42")).toBe(false);
		expect(second.listConversations()).toEqual([]);
		expect(second.isPaused("discord:c1")).toBe(false);
	});

	it("keeps the other session's data intact when one writes", async () => {
		const first = await FileBridgeStore.open({ path, sessionId: "session-a" });
		first.trust("discord:42", 1);
		await first.flush();

		const second = await FileBridgeStore.open({ path, sessionId: "session-b" });
		second.setPaused("discord:c2", true);
		await second.flush();

		const reopened = await FileBridgeStore.open({ path, sessionId: "session-a" });
		expect(reopened.isTrusted("discord:42")).toBe(true);
	});

	it("prunes the oldest sessions beyond maxSessions", async () => {
		let clock = 0;
		const now = () => ++clock;
		for (const sessionId of ["s1", "s2", "s3"]) {
			const store = await FileBridgeStore.open({ path, sessionId, maxSessions: 2, now });
			store.trust(`${sessionId}:u`, clock);
			await store.flush();
		}

		const sessions = (await readState(path)).sessions as Record<string, unknown>;
		expect(Object.keys(sessions).sort()).toEqual(["s2", "s3"]);
	});
});

describe("FileBridgeStore — BridgeStore behaviour", () => {
	it("tracks trust and revocation", async () => {
		const store = await FileBridgeStore.open({ path, sessionId: "s1" });
		expect(store.isTrusted("discord:42")).toBe(false);
		store.trust("discord:42", 5);
		expect(store.listTrusted()).toEqual(["discord:42"]);
		store.revoke("discord:42");
		expect(store.isTrusted("discord:42")).toBe(false);
		expect(store.pairedAt("discord:42")).toBeUndefined();
	});

	it("clears a pending challenge", async () => {
		const store = await FileBridgeStore.open({ path, sessionId: "s1" });
		store.setPending("discord:c1", { code: "1", expiresAt: 2, attempts: 0 });
		store.setPending("discord:c1", undefined);
		expect(store.getPending("discord:c1")).toBeUndefined();
		expect(store.listPending()).toEqual([]);
	});

	it("deduplicates remembered conversations but keeps distinct threads", async () => {
		const store = await FileBridgeStore.open({ path, sessionId: "s1" });
		store.rememberConversation({ transport: "discord", conversationId: "c1" });
		store.rememberConversation({ transport: "discord", conversationId: "c1" });
		store.rememberConversation({ transport: "discord", conversationId: "c1", threadId: "t1" });
		expect(store.listConversations()).toHaveLength(2);
	});

	it("unpauses a conversation", async () => {
		const store = await FileBridgeStore.open({ path, sessionId: "s1" });
		store.setPaused("discord:c1", true);
		store.setPaused("discord:c1", false);
		expect(store.isPaused("discord:c1")).toBe(false);
	});
});
