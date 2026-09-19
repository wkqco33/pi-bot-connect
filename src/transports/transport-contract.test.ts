/**
 * Transport conformance kit.
 *
 * The adapter contract in `docs/architecture.md` §5 is only worth something if a
 * new messenger can be held to it mechanically. This suite runs the same
 * assertions against every transport. Adding a messenger means adding a harness
 * here and registering it in `src/transports/index.ts`.
 *
 * It is a test file, so it is excluded from coverage; the assertions themselves
 * are the artifact.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EnvelopeHandler, Transport } from "../core/types.js";
import { DiscordTransport } from "./discord/index.js";
import {
	FakeRest,
	FakeScheduler,
	type FakeSocket,
	helloFrame,
	readyFrame,
	silentLogger,
	socketFactory,
} from "./discord/doubles.js";
import { FakeTransport } from "./fake.js";
import { TelegramTransport } from "./telegram/index.js";
import { FakeTelegramRest } from "./telegram/doubles.js";
import { RoboClawTransport } from "./robo_claw/index.js";
import { FakeGrpcServerAdapter, type FakeGrpcCall } from "./robo_claw/doubles.js";

export interface TransportContractTarget {
	readonly transport: Transport;
	/** Start the transport and wait until it is genuinely receiving. */
	start(handler: EnvelopeHandler): Promise<void>;
	stop(): Promise<void>;
	/** Forget previously posted/edited messages. */
	reset(): void;
	readonly posted: readonly string[];
	readonly edited: readonly string[];
	/** Make the next send/edit reject, simulating a platform failure. */
	setFailSend(fail: boolean): void;
}

export function describeTransportContract(
	name: string,
	createTarget: () => Promise<TransportContractTarget>,
): void {
	describe(`${name} — transport contract`, () => {
		let target: TransportContractTarget;
		let started = false;
		let stopped = false;

		beforeEach(async () => {
			target = await createTarget();
			started = false;
			stopped = false;
		});

		afterEach(async () => {
			if (started && !stopped) await target.stop().catch(() => undefined);
		});

		it("throws a clear error when send() is called before start()", async () => {
			await expect(
				target.transport.send({ conversationId: "c1", kind: "reply", text: "hi" }),
			).rejects.toThrow();
		});

		it("is safe to stop twice", async () => {
			await target.start(() => {});
			started = true;
			await target.stop();
			stopped = true;
			await expect(target.stop()).resolves.toBeUndefined();
		});

		it("posts a new message and returns a non-empty receipt", async () => {
			await target.start(() => {});
			started = true;

			const receipt = await target.transport.send({ conversationId: "c1", kind: "reply", text: "hello" });

			expect(receipt.messageId.length).toBeGreaterThan(0);
			expect(target.posted).toContain("hello");
		});

		it("surfaces a send failure instead of swallowing it", async () => {
			await target.start(() => {});
			started = true;
			target.setFailSend(true);

			await expect(
				target.transport.send({ conversationId: "c1", kind: "reply", text: "hello" }),
			).rejects.toThrow();
		});

		it("edits in place when editKey is given and editing is supported", async () => {
			await target.start(() => {});
			started = true;
			const first = await target.transport.send({ conversationId: "c1", kind: "reply", text: "first" });
			target.reset();

			if (target.transport.capabilities.edit && first.editKey !== undefined) {
				await target.transport.send({
					conversationId: "c1",
					kind: "progress",
					text: "second",
					editKey: first.editKey,
				});
				expect(target.edited).toContain("second");
				expect(target.posted).toEqual([]);
				return;
			}

			// A non-editing transport must still accept the update as a new message.
			await target.transport.send({ conversationId: "c1", kind: "progress", text: "second" });
			expect(target.posted).toContain("second");
		});

		it("accepts a threadId even when threads are unsupported", async () => {
			await target.start(() => {});
			started = true;

			await expect(
				target.transport.send({ conversationId: "c1", threadId: "t1", kind: "reply", text: "hi" }),
			).resolves.toBeTruthy();
		});

		it("exposes a diagnose() that never contains a credential", async () => {
			await target.start(() => {});
			started = true;

			const report = target.transport.diagnose?.();
			if (report !== undefined) expect(report).not.toContain("test-token");
		});
	});
}

// --- harnesses -------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

async function fakeTarget(): Promise<TransportContractTarget> {
	const transport = new FakeTransport({ capabilities: { edit: true } });
	return {
		transport,
		start: (handler) => transport.start(handler),
		stop: () => transport.stop(),
		reset: () => {
			transport.sent.length = 0;
			transport.edits.length = 0;
		},
		get posted() {
			return transport.sent.map((message) => message.text);
		},
		get edited() {
			return transport.edits.map((message) => message.text);
		},
		setFailSend: (fail) => {
			transport.failSends = fail;
		},
	};
}

async function discordTarget(): Promise<TransportContractTarget> {
	const dir = await mkdtemp(join(tmpdir(), "bot-connect-contract-"));
	const rest = new FakeRest();
	const sockets: FakeSocket[] = [];
	const scheduler = new FakeScheduler();
	const transport = new DiscordTransport({
		token: "test-token",
		lockDir: dir,
		logger: silentLogger,
		rest,
		createSocket: socketFactory(sockets),
		scheduler,
	});
	cleanups.push(async () => {
		await transport.stop().catch(() => undefined);
		await rm(dir, { recursive: true, force: true });
	});

	return {
		transport,
		async start(handler) {
			const started = transport.start(handler);
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline && sockets[0] === undefined) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			const socket = sockets[0];
			if (socket === undefined) throw new Error("discord contract harness: the transport never opened a socket");
			socket.emit(helloFrame());
			socket.emit(readyFrame({ botId: "bot-1" }));
			await started;
		},
		async stop() {
			await transport.stop();
		},
		reset: () => {
			rest.created.length = 0;
			rest.edited.length = 0;
		},
		get posted() {
			return rest.created.map((message) => message.content);
		},
		get edited() {
			return rest.edited.map((message) => message.content);
		},
		setFailSend: (fail) => {
			rest.sendError = fail ? new Error("discord rejected the send") : null;
		},
	};
}


async function telegramTarget(): Promise<TransportContractTarget> {
	const dir = await mkdtemp(join(tmpdir(), "bot-connect-contract-tg-"));
	const rest = new FakeTelegramRest();
	const transport = new TelegramTransport({
		token: "test-token",
		lockDir: dir,
		logger: silentLogger,
		rest,
		delayImpl: () => Promise.resolve(),
	});
	cleanups.push(async () => {
		await transport.stop().catch(() => undefined);
		await rm(dir, { recursive: true, force: true });
	});

	return {
		transport,
		start: (handler) => transport.start(handler),
		stop: () => transport.stop(),
		reset: () => {
			rest.sent.length = 0;
			rest.edited.length = 0;
		},
		get posted() {
			return rest.sent.map((message) => message.text);
		},
		get edited() {
			return rest.edited.map((message) => message.text);
		},
		setFailSend: (fail) => {
			rest.sendError = fail ? new Error("telegram rejected the send") : null;
		},
	};
}

async function roboClawTarget(): Promise<TransportContractTarget> {
	const dir = await mkdtemp(join(tmpdir(), "bot-connect-contract-rc-"));
	const serverAdapter = new FakeGrpcServerAdapter();
	const transport = new RoboClawTransport({
		port: 50052,
		lockDir: dir,
		logger: silentLogger,
		serverAdapter,
	});
	let activeCall: FakeGrpcCall | null = null;
	cleanups.push(async () => {
		await transport.stop().catch(() => undefined);
		await rm(dir, { recursive: true, force: true });
	});

	return {
		transport,
		start: async (handler) => {
			await transport.start(handler);
			activeCall = serverAdapter.simulateClientConnect();
		},
		stop: () => transport.stop(),
		reset: () => {
			if (activeCall) activeCall.written.length = 0;
		},
		get posted() {
			return activeCall ? activeCall.written.map((m) => m.content ?? "") : [];
		},
		get edited() {
			return [];
		},
		setFailSend: (fail) => {
			if (activeCall) {
				if (fail) {
					activeCall.write = () => {
						throw new Error("gRPC stream write error");
					};
				} else {
					activeCall.write = (msg) => {
						activeCall!.written.push(msg);
						return true;
					};
				}
			}
		},
	};
}

describeTransportContract("FakeTransport", fakeTarget);
describeTransportContract("DiscordTransport", discordTarget);
describeTransportContract("TelegramTransport", telegramTarget);
describeTransportContract("RoboClawTransport", roboClawTarget);

