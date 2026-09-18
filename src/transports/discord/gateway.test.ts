import { describe, expect, it } from "vitest";
import { noopLogger } from "../../core/types.js";
import {
	FakeScheduler,
	FakeSocket,
	dispatchFrame,
	flush,
	readyFrame,
	socketFactory,
} from "./doubles.js";
import { DiscordGateway, type DiscordGatewayOptions } from "./gateway.js";
import { DISCORD_DEFAULT_INTENTS } from "./normalize.js";

interface Harness {
	gateway: DiscordGateway;
	sockets: FakeSocket[];
	scheduler: FakeScheduler;
	dispatches: Array<{ type: string; data: unknown }>;
}

function setup(overrides: Partial<DiscordGatewayOptions> = {}): Harness {
	const sockets: FakeSocket[] = [];
	const scheduler = new FakeScheduler();
	const dispatches: Array<{ type: string; data: unknown }> = [];

	const gateway = new DiscordGateway({
		token: "test-token",
		intents: DISCORD_DEFAULT_INTENTS,
		resolveGatewayUrl: () => Promise.resolve("wss://gateway.example"),
		createSocket: socketFactory(sockets),
		scheduler,
		hooks: {
			onDispatch: (type, data) => {
				dispatches.push({ type, data });
			},
			log: noopLogger,
		},
		...overrides,
	});

	return { gateway, sockets, scheduler, dispatches };
}

describe("DiscordGateway — handshake", () => {
	it("appends the api version and encoding to the gateway url", async () => {
		const { gateway, sockets } = setup();
		void gateway.start();
		await flush();
		expect(sockets[0]?.url).toBe("wss://gateway.example?v=10&encoding=json");
	});

	it("identifies after HELLO with the requested intents", async () => {
		const { gateway, sockets, scheduler } = setup();
		void gateway.start();
		await flush();
		sockets[0]?.emit({ op: 10, d: { heartbeat_interval: 40_000 } });

		expect(sockets[0]?.frames[0]).toMatchObject({ op: 2, d: { token: "test-token", intents: DISCORD_DEFAULT_INTENTS } });
		expect(scheduler.intervalMs).toBe(40_000);
	});

	it("resolves start() on READY and records the bot identity", async () => {
		const { gateway, sockets } = setup();
		const started = gateway.start();
		await flush();
		sockets[0]?.emit(readyFrame({ botId: "bot-42" }));
		await started;

		expect(gateway.state).toBe("ready");
		expect(gateway.botId).toBe("bot-42");
		expect(gateway.describe()).toContain("ready as bot bot-42");
	});

	it("rejects a second start", async () => {
		const { gateway } = setup();
		void gateway.start();
		await expect(gateway.start()).rejects.toThrow(/already connecting/);
	});

	it("ignores malformed JSON instead of crashing", async () => {
		const { gateway, sockets } = setup();
		void gateway.start();
		await flush();
		sockets[0]?.emitRaw("{ this is not json");
		expect(gateway.state).toBe("connecting");
	});

	it("forwards MESSAGE_CREATE dispatches to the hook", async () => {
		const { gateway, sockets, dispatches } = setup();
		void gateway.start();
		await flush();
		sockets[0]?.emit(readyFrame());
		sockets[0]?.emit(dispatchFrame(2, "MESSAGE_CREATE", { id: "m1", content: "hi" }));
		expect(dispatches).toEqual([{ type: "MESSAGE_CREATE", data: { id: "m1", content: "hi" } }]);
	});
});

describe("DiscordGateway — heartbeat", () => {
	async function ready(h: Harness): Promise<FakeSocket> {
		const started = h.gateway.start();
		await flush();
		const socket = h.sockets[0] as FakeSocket;
		socket.emit({ op: 10, d: { heartbeat_interval: 40_000 } });
		socket.emit(readyFrame());
		await started;
		return socket;
	}

	it("sends a heartbeat on the interval", async () => {
		const h = setup();
		const socket = await ready(h);
		h.scheduler.fireIntervals();
		expect(socket.ops.filter((op) => op === 1)).toHaveLength(1);
		expect(socket.lastFrame).toEqual({ op: 1, d: 1 });
	});

	it("keeps beating after an acknowledgement", async () => {
		const h = setup();
		const socket = await ready(h);
		h.scheduler.fireIntervals();
		socket.emit({ op: 11 });
		h.scheduler.fireIntervals();
		expect(socket.ops.filter((op) => op === 1)).toHaveLength(2);
		expect(h.gateway.state).toBe("ready");
	});

	it("reconnects when a heartbeat is not acknowledged", async () => {
		const h = setup();
		const socket = await ready(h);
		h.scheduler.fireIntervals();
		h.scheduler.fireIntervals();

		expect(h.gateway.state).toBe("reconnecting");
		expect(h.scheduler.pendingTimeouts).toBe(1);
		expect(socket.closed).not.toBeNull();
	});

	it("responds to a server-initiated heartbeat", async () => {
		const h = setup();
		const socket = await ready(h);
		socket.emit({ op: 1, d: null });
		expect(socket.ops.filter((op) => op === 1)).toHaveLength(1);
	});
});

describe("DiscordGateway — resume and reconnect", () => {
	it("resumes with the session id and sequence after a reconnect", async () => {
		const h = setup();
		const started = h.gateway.start();
		await flush();
		h.sockets[0]?.emit({ op: 10, d: { heartbeat_interval: 40_000 } });
		h.sockets[0]?.emit(readyFrame({ sessionId: "sess-9", resumeUrl: "wss://resume.example" }));
		await started;

		h.sockets[0]?.emitClose(1006, "abnormal closure");
		h.scheduler.fireTimeouts();
		await flush();

		const second = h.sockets[1] as FakeSocket;
		expect(second.url).toBe("wss://resume.example?v=10&encoding=json");
		second.emit({ op: 10, d: { heartbeat_interval: 40_000 } });
		expect(second.frames[0]).toEqual({ op: 6, d: { token: "test-token", session_id: "sess-9", seq: 1 } });
	});

	it("re-identifies when the session is not resumable", async () => {
		const h = setup();
		const started = h.gateway.start();
		await flush();
		h.sockets[0]?.emit({ op: 10, d: { heartbeat_interval: 40_000 } });
		h.sockets[0]?.emit(readyFrame({ sessionId: "sess-9" }));
		await started;

		h.sockets[0]?.emit({ op: 9, d: false });
		h.scheduler.fireTimeouts();
		await flush();

		const second = h.sockets[1] as FakeSocket;
		second.emit({ op: 10, d: { heartbeat_interval: 40_000 } });
		expect(second.frames[0]?.op).toBe(2);
	});

	it("reconnects when the server requests it", async () => {
		const h = setup();
		const started = h.gateway.start();
		await flush();
		h.sockets[0]?.emit({ op: 10, d: { heartbeat_interval: 40_000 } });
		h.sockets[0]?.emit(readyFrame());
		await started;

		h.sockets[0]?.emit({ op: 7, d: null });
		expect(h.gateway.state).toBe("reconnecting");
	});

	it("gives up after exhausting the reconnect budget", async () => {
		const h = setup({ backoffMs: [10] });
		const started = h.gateway.start();
		await flush();

		h.sockets[0]?.emitClose(1006, "abnormal closure");
		expect(h.scheduler.timeoutDelays).toContain(10);
		// Fire only the reconnect timer; the 20s ready timeout is still pending.
		h.scheduler.fireTimeouts(10);
		await flush();
		h.sockets[1]?.emitClose(1006, "abnormal closure");

		await expect(started).rejects.toThrow(/kept failing/);
		expect(h.gateway.state).toBe("error");
	});

	it("re-arms the ready deadline after a reconnect", async () => {
		const h = setup({ backoffMs: [10, 20], readyTimeoutMs: 5_000 });
		const started = h.gateway.start();
		await flush();
		h.sockets[0]?.emit({ op: 10, d: { heartbeat_interval: 40_000 } });
		h.sockets[0]?.emit(readyFrame());
		await started;

		h.sockets[0]?.emitClose(1006, "abnormal closure");
		h.scheduler.fireTimeouts(10);
		await flush();

		// The reconnected socket never sends HELLO. Without a fresh deadline the
		// gateway would sit in "reconnecting" forever.
		expect(h.scheduler.timeoutDelays).toContain(5_000);
		h.scheduler.fireTimeouts(5_000);
		expect(h.gateway.state).toBe("reconnecting");
		expect(h.scheduler.timeoutDelays).toContain(20);
	});

	it("returns to ready when the server resumes the session", async () => {
		const h = setup({ backoffMs: [10, 20] });
		const started = h.gateway.start();
		await flush();
		h.sockets[0]?.emit({ op: 10, d: { heartbeat_interval: 40_000 } });
		h.sockets[0]?.emit(readyFrame({ sessionId: "sess-9", resumeUrl: "wss://resume.example" }));
		await started;

		h.sockets[0]?.emitClose(1006, "abnormal closure");
		h.scheduler.fireTimeouts(10);
		await flush();

		const second = h.sockets[1] as FakeSocket;
		second.emit({ op: 10, d: { heartbeat_interval: 40_000 } });
		second.emit(dispatchFrame(9, "RESUMED", {}));

		expect(h.gateway.state).toBe("ready");
		expect(h.gateway.describe()).toContain("ready");
	});

	it("resets the reconnect budget after a successful resume", async () => {
		const h = setup({ backoffMs: [10, 20], readyTimeoutMs: 5_000 });
		const started = h.gateway.start();
		await flush();
		h.sockets[0]?.emit({ op: 10, d: { heartbeat_interval: 40_000 } });
		h.sockets[0]?.emit(readyFrame({ sessionId: "sess-9", resumeUrl: "wss://resume.example" }));
		await started;

		h.sockets[0]?.emitClose(1006, "abnormal closure");
		h.scheduler.fireTimeouts(10);
		await flush();
		const second = h.sockets[1] as FakeSocket;
		second.emit({ op: 10, d: { heartbeat_interval: 40_000 } });
		second.emit(dispatchFrame(9, "RESUMED", {}));

		second.emitClose(1006, "abnormal closure");
		expect(h.scheduler.timeoutDelays).toContain(10);
	});
});

describe("DiscordGateway — failure and shutdown", () => {
	it("treats an authentication close as fatal", async () => {
		const h = setup();
		const started = h.gateway.start();
		await flush();
		h.sockets[0]?.emitClose(4004, "Authentication failed.");

		await expect(started).rejects.toThrow(/4004/);
		expect(h.gateway.state).toBe("error");
		expect(h.gateway.describe()).toContain("Message Content intent");
		expect(h.scheduler.pendingTimeouts).toBe(0);
	});

	it("rejects start() when the ready timeout fires", async () => {
		const h = setup();
		const started = h.gateway.start();
		await flush();
		h.scheduler.fireTimeouts();

		await expect(started).rejects.toThrow(/did not become ready/);
		expect(h.gateway.state).toBe("error");
	});

	it("rejects a pending start when stopped", async () => {
		const h = setup();
		const started = h.gateway.start();
		await flush();
		h.gateway.stop();

		await expect(started).rejects.toThrow(/stopped before becoming ready/);
		expect(h.gateway.state).toBe("stopped");
	});

	it("closes the socket and stops the heartbeat on stop", async () => {
		const h = setup();
		const started = h.gateway.start();
		await flush();
		h.sockets[0]?.emit({ op: 10, d: { heartbeat_interval: 40_000 } });
		h.sockets[0]?.emit(readyFrame());
		await started;

		h.gateway.stop();

		expect(h.sockets[0]?.closed).toEqual({ code: 1000, reason: "client closing" });
		expect(h.scheduler.intervalMs).toBeUndefined();
		expect(h.gateway.state).toBe("stopped");
	});

	it("never renders the token in its health summary", () => {
		const h = setup();
		expect(h.gateway.describe()).not.toContain("test-token");
	});
});
