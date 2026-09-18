import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../../core/types.js";
import { acquireLock } from "../../lock.js";
import { TelegramTransport, type TelegramTransportOptions } from "./index.js";
import { FakeTelegramRest } from "./doubles.js";
import type { TelegramUpdate } from "./normalize.js";

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

const BOT_TOKEN = "123456:telegram-test-token";

let dir: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bot-connect-telegram-"));
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
	await rm(dir, { recursive: true, force: true });
});

interface Harness {
	transport: TelegramTransport;
	rest: FakeTelegramRest;
	received: Envelope[];
}

function setup(overrides: Partial<TelegramTransportOptions> = {}): Harness {
	const rest = new FakeTelegramRest();
	const received: Envelope[] = [];
	const transport = new TelegramTransport({
		token: BOT_TOKEN,
		lockDir: dir,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		rest,
		delayImpl: () => Promise.resolve(),
		...overrides,
	});
	cleanups.push(() => transport.stop());
	return { transport, rest, received };
}

async function startReady(h: Harness): Promise<void> {
	await h.transport.start((envelope) => {
		h.received.push(envelope);
	});
}

async function lockFiles(): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((entry) => entry.endsWith(".lock")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function privateMessage(text: string, id = 5): TelegramUpdate {
	return {
		update_id: id,
		message: {
			message_id: id,
			date: 1_700_000_000,
			chat: { id: -100, type: "private" },
			from: { id: 42, is_bot: false, username: "alice" },
			text,
		},
	};
}

describe("TelegramTransport — startup", () => {
	it("validates the token before acquiring the lock", async () => {
		const h = setup();
		h.rest.identityError = new Error("Telegram getMe failed: Unauthorized");

		await expect(h.transport.start(() => {})).rejects.toThrow(/Unauthorized/);
		expect(await lockFiles()).toEqual([]);
	});

	it("acquires a lock named after the bot id, not the token", async () => {
		const h = setup();
		await startReady(h);
		expect(await lockFiles()).toEqual(["telegram-999.lock"]);
	});

	it("refuses to start when another live process holds the lock", async () => {
		const held = await acquireLock({ path: join(dir, "telegram-999.lock"), pid: process.pid });
		expect(held.ok).toBe(true);

		const h = setup();
		await expect(h.transport.start(() => {})).rejects.toThrow(/already polls this Telegram bot/);
	});

	it("releases the lock when the initial poll fails", async () => {
		const h = setup();
		h.rest.getUpdates = () => Promise.reject(new Error("getUpdates failed"));
		await expect(h.transport.start(() => {})).rejects.toThrow(/getUpdates failed/);
		expect(await lockFiles()).toEqual([]);
	});

	it("throws when send() is called before start()", async () => {
		const h = setup();
		await expect(h.transport.send({ conversationId: "1", kind: "reply", text: "hi" })).rejects.toThrow();
	});
});

describe("TelegramTransport — polling", () => {
	it("delivers a normalized private message to the handler", async () => {
		const h = setup();
		await startReady(h);

		h.rest.emitUpdates([privateMessage("hello")]);
		await flush();

		expect(h.received).toHaveLength(1);
		expect(h.received[0]).toMatchObject({ transport: "telegram", conversationId: "-100", userId: "42", text: "hello" });
	});

	it("advances the offset so an update is not delivered twice", async () => {
		const h = setup();
		await startReady(h);
		h.rest.emitUpdates([privateMessage("first", 7)]);
		await flush();

		// Next long poll must ask for updates after update_id 7.
		h.rest.emitUpdates([]);
		await flush();

		expect(h.rest.calls.at(-1)?.offset).toBe(8);
	});

	it("skips a bot-authored update and exposes the reason in diagnose()", async () => {
		const h = setup();
		await startReady(h);
		h.rest.emitUpdates([
			{
				update_id: 3,
				message: {
					message_id: 3,
					date: 1_700_000_000,
					chat: { id: -100, type: "private" },
					from: { id: 7, is_bot: true },
					text: "beep",
				},
			},
		]);
		await flush();

		expect(h.received).toEqual([]);
		expect(h.transport.diagnose()).toContain("last skip: bot-author");
	});
});

describe("TelegramTransport — sending", () => {
	it("posts a message and returns an editable handle", async () => {
		const h = setup();
		await startReady(h);

		const receipt = await h.transport.send({ conversationId: "-100", kind: "reply", text: "hello" });

		expect(receipt.editKey).toBe(receipt.messageId);
		expect(h.rest.sent[0]).toMatchObject({ chatId: "-100", text: "hello" });
	});

	it("passes a topic thread id through", async () => {
		const h = setup();
		await startReady(h);
		await h.transport.send({ conversationId: "-100", threadId: "77", kind: "reply", text: "hello" });
		expect(h.rest.sent[0]?.threadId).toBe("77");
	});

	it("edits instead of posting when an editKey is given", async () => {
		const h = setup();
		await startReady(h);

		await h.transport.send({ conversationId: "-100", kind: "progress", text: "second", editKey: "tg-1" });

		expect(h.rest.edited).toEqual([{ chatId: "-100", messageId: "tg-1", text: "second" }]);
		expect(h.rest.sent).toEqual([]);
	});

	it("surfaces a send failure", async () => {
		const h = setup();
		await startReady(h);
		h.rest.sendError = new Error("Telegram sendMessage failed: chat not found");
		await expect(h.transport.send({ conversationId: "-100", kind: "reply", text: "hi" })).rejects.toThrow(/chat not found/);
	});

	it("never renders the token in its health summary", async () => {
		const h = setup();
		await startReady(h);
		expect(h.transport.diagnose()).not.toContain(BOT_TOKEN);
	});
});

describe("TelegramTransport — typing and attachments", () => {
	it("throttles the typing action per chat", async () => {
		let clock = 1_000;
		const h = setup({ typingMinIntervalMs: 4_000, now: () => clock });
		await startReady(h);

		await h.transport.typing("-100");
		await h.transport.typing("-100");
		expect(h.rest.actions).toEqual(["-100:typing"]);

		clock += 4_000;
		await h.transport.typing("-100");
		expect(h.rest.actions).toHaveLength(2);
	});

	it("downloads an attachment and returns base64", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		const h = setup({
			fetchImpl: () => Promise.resolve(new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } })),
		});
		await startReady(h);
		h.rest.files.set("file-1", "photos/a.jpg");

		const fetched = await h.transport.fetchAttachment({ kind: "image", mediaType: "image/jpeg", ref: "file-1" });

		expect(fetched).toEqual({ mediaType: "image/jpeg", data: Buffer.from(bytes).toString("base64") });
	});

	it("rejects an attachment whose declared size is over the cap before downloading", async () => {
		const h = setup({ maxAttachmentBytes: 10, fetchImpl: () => Promise.reject(new Error("should not download")) });
		await startReady(h);
		h.rest.files.set("file-1", "photos/a.jpg");

		await expect(
			h.transport.fetchAttachment({ kind: "image", mediaType: "image/jpeg", ref: "file-1", sizeBytes: 500 }),
		).rejects.toThrow(/over the 10 byte limit/);
	});
});

describe("TelegramTransport — shutdown", () => {
	it("aborts an in-flight long poll and releases the lock", async () => {
		const h = setup();
		await startReady(h);

		await h.transport.stop();

		expect(await lockFiles()).toEqual([]);
		expect(h.transport.diagnose()).toContain("stopped");
	});

	it("is safe to stop twice", async () => {
		const h = setup();
		await startReady(h);
		await h.transport.stop();
		await expect(h.transport.stop()).resolves.toBeUndefined();
	});
});
