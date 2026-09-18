import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../../core/types.js";
import { acquireLock } from "../../lock.js";
import {
	FakeRest,
	FakeScheduler,
	type FakeSocket,
	dispatchFrame,
	flush,
	helloFrame,
	messagePayload,
	readyFrame,
	silentLogger,
	socketFactory,
} from "./doubles.js";
import { DiscordTransport, type DiscordTransportOptions } from "./index.js";

let dir: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bot-connect-discord-"));
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup().catch(() => undefined);
	}
	await rm(dir, { recursive: true, force: true });
});

interface Harness {
	transport: DiscordTransport;
	rest: FakeRest;
	sockets: FakeSocket[];
	scheduler: FakeScheduler;
	received: Envelope[];
}

function setup(overrides: Partial<DiscordTransportOptions> = {}): Harness {
	const rest = new FakeRest();
	const sockets: FakeSocket[] = [];
	const scheduler = new FakeScheduler();
	const received: Envelope[] = [];

	const transport = new DiscordTransport({
		token: "test-token",
		lockDir: dir,
		logger: silentLogger,
		rest,
		createSocket: socketFactory(sockets),
		scheduler,
		...overrides,
	});
	cleanups.push(() => transport.stop());

	return { transport, rest, sockets, scheduler, received };
}

async function lockFiles(): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((entry) => entry.endsWith(".lock")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/**
 * Waits until the transport has opened its gateway socket.
 *
 * Startup does real filesystem work (lock acquisition) on the libuv threadpool,
 * so this polls against a wall-clock deadline rather than counting ticks: under
 * a loaded full-suite run a tick-counting loop can spin out before the I/O lands.
 */
async function waitForSocket(h: Harness, getFailure: () => unknown = () => null): Promise<FakeSocket> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const socket = h.sockets[0];
		if (socket) return socket;
		const failure = getFailure();
		if (failure !== null && failure !== undefined) {
			throw new Error(`transport start failed before opening a socket: ${String(failure)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("the transport never opened a socket");
}

async function startReady(h: Harness, handler?: (envelope: Envelope) => void | Promise<void>): Promise<void> {
	const onEnvelope = handler ?? ((envelope: Envelope): void => void h.received.push(envelope));

	let failure: unknown = null;
	const started = h.transport.start(onEnvelope);
	// Handled here so a startup failure surfaces as a readable assertion error
	// instead of an unhandled rejection.
	started.catch((error: unknown) => {
		failure = error;
	});

	const socket = await waitForSocket(h, () => failure);
	socket.emit(helloFrame());
	socket.emit(readyFrame({ botId: "bot-1" }));
	await started;
}

describe("DiscordTransport — capabilities", () => {
	it("advertises Discord's real limits", () => {
		const { transport } = setup();
		expect(transport.id).toBe("discord");
		expect(transport.capabilities).toEqual({
			threads: false,
			edit: true,
			reactions: false,
			attachments: true,
			maxMessageLength: 2000,
			lengthUnit: "chars",
			markdown: "markdown",
			channels: true,
		});
	});
});

describe("DiscordTransport — startup", () => {
	it("validates the bot token before opening a socket", async () => {
		const h = setup();
		h.rest.identityError = new Error("Discord GET /users/@me failed with status 401 (401: Unauthorized).");

		await expect(h.transport.start(() => {})).rejects.toThrow(/401/);
		expect(h.sockets).toHaveLength(0);
		expect(await lockFiles()).toEqual([]);
	});

	it("acquires a lock named after the bot id, not the token", async () => {
		const h = setup();
		await startReady(h);
		expect(await lockFiles()).toEqual(["discord-bot-1.lock"]);
	});

	it("refuses to start when another live process holds the lock", async () => {
		const held = await acquireLock({ path: join(dir, "discord-bot-1.lock"), pid: process.pid });
		expect(held.ok).toBe(true);

		const h = setup();
		await expect(h.transport.start(() => {})).rejects.toThrow(/another pi process already holds/);
		expect(h.sockets).toHaveLength(0);
	});

	it("releases the lock when the gateway never becomes ready", async () => {
		const h = setup();
		const started = h.transport.start(() => {});
		started.catch(() => undefined);
		const socket = await waitForSocket(h);
		socket.emitClose(4004, "Authentication failed.");

		await expect(started).rejects.toThrow(/4004/);
		expect(await lockFiles()).toEqual([]);
	});

	it("rejects a second start", async () => {
		const h = setup();
		await startReady(h);
		await expect(h.transport.start(() => {})).rejects.toThrow(/already started/);
	});

	it("releases the lock on stop and can be stopped twice", async () => {
		const h = setup();
		await startReady(h);

		await h.transport.stop();
		await h.transport.stop();

		expect(await lockFiles()).toEqual([]);
		expect(h.sockets[0]?.closed).toEqual({ code: 1000, reason: "client closing" });
	});
});

describe("DiscordTransport — inbound", () => {
	it("forwards MESSAGE_CREATE as an envelope", async () => {
		const h = setup();
		await startReady(h);
		h.sockets[0]?.emit(dispatchFrame(2, "MESSAGE_CREATE", messagePayload({ content: "run the tests" })));
		await flush();

		expect(h.received).toHaveLength(1);
		expect(h.received[0]).toMatchObject({
			transport: "discord",
			conversationId: "chan-1",
			userId: "user-9",
			isDirect: true,
			addressed: true,
			text: "run the tests",
		});
	});

	it("ignores other dispatch types", async () => {
		const h = setup();
		await startReady(h);
		h.sockets[0]?.emit(dispatchFrame(2, "MESSAGE_UPDATE", messagePayload()));
		await flush();
		expect(h.received).toEqual([]);
	});

	it("ignores its own message and reports why in doctor output", async () => {
		const h = setup();
		await startReady(h);
		h.sockets[0]?.emit(dispatchFrame(2, "MESSAGE_CREATE", messagePayload({ author: { id: "bot-1", bot: true } })));
		await flush();

		expect(h.received).toEqual([]);
		expect(h.transport.diagnose()).toContain("last skip: self");
	});

	it("keeps inbound messages in order", async () => {
		const h = setup();
		await startReady(h);
		const socket = h.sockets[0];
		socket?.emit(dispatchFrame(2, "MESSAGE_CREATE", messagePayload({ id: "m1", content: "first" })));
		socket?.emit(dispatchFrame(3, "MESSAGE_CREATE", messagePayload({ id: "m2", content: "second" })));
		await flush();
		await flush();

		expect(h.received.map((envelope) => envelope.text)).toEqual(["first", "second"]);
	});

	it("keeps processing after a handler failure", async () => {
		const h = setup();
		let calls = 0;
		await startReady(h, () => {
			calls++;
			if (calls === 1) throw new Error("boom");
		});

		const socket = h.sockets[0];
		socket?.emit(dispatchFrame(2, "MESSAGE_CREATE", messagePayload({ id: "m1" })));
		socket?.emit(dispatchFrame(3, "MESSAGE_CREATE", messagePayload({ id: "m2" })));
		await flush();
		await flush();

		expect(calls).toBe(2);
	});
});

describe("DiscordTransport — outbound", () => {
	it("refuses to send before it is started", async () => {
		const { transport } = setup();
		await expect(transport.send({ conversationId: "chan-1", kind: "reply", text: "hi" })).rejects.toThrow(
			/not started/,
		);
	});

	it("posts a message and returns an edit handle", async () => {
		const h = setup();
		await startReady(h);

		const receipt = await h.transport.send({ conversationId: "chan-1", kind: "reply", text: "hello" });

		expect(h.rest.created).toEqual([{ channelId: "chan-1", content: "hello" }]);
		expect(receipt).toEqual({ messageId: "msg-1", editKey: "msg-1" });
	});

	it("edits instead of posting when an edit handle is present", async () => {
		const h = setup();
		await startReady(h);

		const receipt = await h.transport.send({
			conversationId: "chan-1",
			kind: "progress",
			text: "still working",
			editKey: "msg-9",
		});

		expect(h.rest.created).toEqual([]);
		expect(h.rest.edited).toEqual([{ channelId: "chan-1", messageId: "msg-9", content: "still working" }]);
		expect(receipt.editKey).toBe("msg-9");
	});
});

describe("DiscordTransport — diagnostics", () => {
	it("never renders the token", async () => {
		const h = setup();
		await startReady(h);
		const report = h.transport.diagnose();
		expect(report).toContain("bot pi-bot (bot-1)");
		expect(report).toContain("lock held");
		expect(report).not.toContain("test-token");
	});

	it("reports an unstarted transport", () => {
		const { transport } = setup();
		expect(transport.diagnose()).toContain("not identified");
		expect(transport.diagnose()).toContain("not started");
	});
});

describe("DiscordTransport — attachment download", () => {
	const PNG_ATTACHMENT = { kind: "image", mediaType: "image/png", ref: "https://cdn.example/a1" } as const;
	const bytes = new Uint8Array([1, 2, 3, 4]);

	function imageResponse(
		body: Uint8Array,
		init: { status?: number; contentLength?: number | null } = {},
	): Response {
		const headers: Record<string, string> = { "content-type": "image/png" };
		if (init.contentLength !== undefined && init.contentLength !== null) {
			headers["content-length"] = String(init.contentLength);
		}
		return new Response(body, { status: init.status ?? 200, headers });
	}

	it("downloads an attachment and returns base64", async () => {
		const h = setup({ fetchImpl: () => Promise.resolve(imageResponse(bytes)) });
		const fetched = await h.transport.fetchAttachment(PNG_ATTACHMENT);
		expect(fetched).toEqual({ mediaType: "image/png", data: Buffer.from(bytes).toString("base64") });
	});

	it("rejects a non-ok response", async () => {
		const h = setup({ fetchImpl: () => Promise.resolve(imageResponse(bytes, { status: 403 })) });
		await expect(h.transport.fetchAttachment(PNG_ATTACHMENT)).rejects.toThrow(/status 403/);
	});

	it("rejects an attachment whose declared size is over the cap", async () => {
		const h = setup({
			maxAttachmentBytes: 10,
			fetchImpl: () => Promise.resolve(imageResponse(bytes, { contentLength: 500 })),
		});
		await expect(h.transport.fetchAttachment(PNG_ATTACHMENT)).rejects.toThrow(/over the 10 byte limit/);
	});

	it("rejects an attachment that only turns out too large after download", async () => {
		const h = setup({
			maxAttachmentBytes: 10,
			fetchImpl: () => Promise.resolve(imageResponse(new Uint8Array(20))),
		});
		await expect(h.transport.fetchAttachment(PNG_ATTACHMENT)).rejects.toThrow(/over the 10 byte limit/);
	});

	it("rejects when the attachment host cannot be reached", async () => {
		const h = setup({ fetchImpl: () => Promise.reject(new Error("ENOTFOUND")) });
		await expect(h.transport.fetchAttachment(PNG_ATTACHMENT)).rejects.toThrow(/could not reach/);
	});
});
