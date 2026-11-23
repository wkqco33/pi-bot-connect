import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../../core/types.js";
import { acquireLock, LockHeldError } from "../../lock.js";
import { FakeGrpcServerAdapter, silentLogger } from "./doubles.js";
import { RoboClawTransport } from "./index.js";

describe("RoboClawTransport", () => {
	let lockDir: string;
	let serverAdapter: FakeGrpcServerAdapter;
	let transport: RoboClawTransport;

	beforeEach(async () => {
		lockDir = await mkdtemp(join(tmpdir(), "robo-claw-test-"));
		serverAdapter = new FakeGrpcServerAdapter();
		transport = new RoboClawTransport({
			port: 50052,
			host: "127.0.0.1",
			lockDir,
			logger: silentLogger,
			serverAdapter,
		});
	});

	afterEach(async () => {
		await transport.stop().catch(() => undefined);
		await rm(lockDir, { recursive: true, force: true });
	});

	it("throws error when send() is called before start()", async () => {
		await expect(
			transport.send({
				conversationId: "c1",
				kind: "reply",
				text: "hello",
			}),
		).rejects.toThrow(/start/i);
	});

	it("acquires lock on port and starts server", async () => {
		await transport.start(() => {});
		expect(serverAdapter.started).toBe(true);
		expect(serverAdapter.boundPort).toBe(50052);
		expect(serverAdapter.boundHost).toBe("127.0.0.1");
	});

	it("releases lock on stop and is safe to stop twice", async () => {
		await transport.start(() => {});
		await transport.stop();
		expect(serverAdapter.stopped).toBe(true);

		// Stopping twice should be a no-op
		await expect(transport.stop()).resolves.toBeUndefined();

		// A new instance should now be able to acquire the lock
		const second = new RoboClawTransport({
			port: 50052,
			host: "127.0.0.1",
			lockDir,
			logger: silentLogger,
			serverAdapter: new FakeGrpcServerAdapter(),
		});
		await expect(second.start(() => {})).resolves.toBeUndefined();
		await second.stop();
	});

	it("cleans up lock if server start fails", async () => {
		serverAdapter.failNextStart = new Error("EADDRINUSE");

		await expect(transport.start(() => {})).rejects.toThrow("EADDRINUSE");

		// Lock must have been released, so another process can acquire it
		const lockResult = await acquireLock({
			path: join(lockDir, "robo_claw-50052.lock"),
		});
		expect(lockResult.ok).toBe(true);
		if (lockResult.ok) {
			await lockResult.lock.release();
		}
	});

	it("fails to start when port lock is held by another process", async () => {
		const existingLock = await acquireLock({
			path: join(lockDir, "robo_claw-50052.lock"),
		});
		expect(existingLock.ok).toBe(true);

		const failure = await transport.start(() => {}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(LockHeldError);

		if (existingLock.ok) {
			await existingLock.lock.release();
		}
	});

	it("dispatches received ChatMessage to EnvelopeHandler", async () => {
		const envelopes: Envelope[] = [];
		await transport.start((env) => {
			envelopes.push(env);
		});

		const call = serverAdapter.simulateClientConnect();
		call.emitInbound({
			sender_id: "user-alice",
			content: "run test",
			timestamp: 1700000000000,
			metadata: { room_id: "room-1" },
		});

		expect(envelopes.length).toBe(1);
		expect(envelopes[0]?.userId).toBe("user-alice");
		expect(envelopes[0]?.text).toBe("run test");
		expect(envelopes[0]?.conversationId).toBe("room-1");
	});

	it("ignores robot echo messages", async () => {
		const envelopes: Envelope[] = [];
		await transport.start((env) => {
			envelopes.push(env);
		});

		const call = serverAdapter.simulateClientConnect();
		call.emitInbound({
			sender_id: "robot",
			content: "robot reply",
			timestamp: 1700000000000,
			metadata: {},
		});

		expect(envelopes.length).toBe(0);
	});

	it("sends OutboundMessage to active connected streams", async () => {
		await transport.start(() => {});
		const call = serverAdapter.simulateClientConnect();
		call.emitInbound({ sender_id: "alice", content: "hello", metadata: { room_id: "room-1" } });

		const receipt = await transport.send({
			conversationId: "room-1",
			kind: "reply",
			text: "Task completed successfully",
		});

		expect(receipt.messageId).toBeTruthy();
		expect(call.written.length).toBe(1);
		expect(call.written[0]?.content).toBe("Task completed successfully");
		expect(call.written[0]?.sender_id).toBe("robot");
	});

	it("keeps the default single chat when the client omits a room id", async () => {
		await transport.start(() => {});
		const call = serverAdapter.simulateClientConnect();
		call.emitInbound({ sender_id: "alice", content: "hello" });
		await transport.send({ conversationId: "default", kind: "reply", text: "Default answer" });
		expect(call.written.map((message) => message.content)).toEqual(["Default answer"]);
	});

	it("does not deliver a room's messages to a stream from another room", async () => {
		await transport.start(() => {});
		const first = serverAdapter.simulateClientConnect();
		const second = serverAdapter.simulateClientConnect();
		first.emitInbound({ sender_id: "alice", content: "hello", metadata: { room_id: "room-1" } });
		second.emitInbound({ sender_id: "bob", content: "hello", metadata: { room_id: "room-2" } });
		await transport.send({ conversationId: "room-1", kind: "reply", text: "Room 1 only" });
		expect(first.written.map((message) => message.content)).toEqual(["Room 1 only"]);
		expect(second.written).toEqual([]);
	});

	it("cancels a disconnected room's buffered messages and preserves other rooms", async () => {
		await transport.start(() => {});
		await transport.send({ conversationId: "room-1", kind: "reply", text: "Old answer" });
		await transport.send({ conversationId: "room-2", kind: "reply", text: "Current answer" });
		transport.cancelPendingConversation("room-1");
		const first = serverAdapter.simulateClientConnect();
		const second = serverAdapter.simulateClientConnect();
		first.emitInbound({ sender_id: "alice", content: "hello", metadata: { room_id: "room-1" } });
		second.emitInbound({ sender_id: "bob", content: "hello", metadata: { room_id: "room-2" } });
		await Promise.resolve();
		expect(first.written).toEqual([]);
		expect(second.written.map((message) => message.content)).toEqual(["Current answer"]);
	});

	it("buffers outbound messages until a client announces the destination room", async () => {
		await transport.start(() => {});

		// Send before client connects
		const receipt = await transport.send({
			conversationId: "room-1",
			kind: "reply",
			text: "Pending message",
		});
		expect(receipt.messageId).toBeTruthy();

		// Client connects later
		const call = serverAdapter.simulateClientConnect();
		expect(call.written).toEqual([]);
		call.emitInbound({ sender_id: "alice", content: "hello", metadata: { room_id: "room-1" } });
		await Promise.resolve();

		expect(call.written.length).toBe(1);
		expect(call.written[0]?.content).toBe("Pending message");
	});

	it("accepts valid token when token is configured", async () => {
		const authTransport = new RoboClawTransport({
			port: 50052,
			token: "my-secret-token",
			lockDir,
			logger: silentLogger,
			serverAdapter,
		});

		const envelopes: Envelope[] = [];
		await authTransport.start((env) => {
			envelopes.push(env);
		});

		// Client sends with matching auth_token in metadata
		const call = serverAdapter.simulateClientConnect();
		call.emitInbound({
			sender_id: "user-1",
			content: "authenticated hello",
			metadata: { auth_token: "my-secret-token" },
		});

		expect(envelopes.length).toBe(1);
		expect(envelopes[0]?.text).toBe("authenticated hello");

		await authTransport.stop();
	});

	it("rejects client with invalid token when token is configured", async () => {
		const authTransport = new RoboClawTransport({
			port: 50052,
			token: "my-secret-token",
			lockDir,
			logger: silentLogger,
			serverAdapter,
		});

		const envelopes: Envelope[] = [];
		await authTransport.start((env) => {
			envelopes.push(env);
		});

		// Client sends with WRONG auth_token in metadata
		const call = serverAdapter.simulateClientConnect();
		call.emitInbound({
			sender_id: "user-1",
			content: "unauthenticated hello",
			metadata: { auth_token: "wrong-token" },
		});

		expect(envelopes.length).toBe(0);
		expect(call.destroyedWith).toBeTruthy();

		await authTransport.stop();
	});

	it("diagnose() returns status without leaking token (I18)", async () => {
		const authTransport = new RoboClawTransport({
			port: 50052,
			token: "super-secret-password-1234",
			lockDir,
			logger: silentLogger,
			serverAdapter,
		});
		await authTransport.start(() => {});

		const report = authTransport.diagnose();
		expect(report).toContain("50052");
		expect(report).toContain("token: protected");
		expect(report).not.toContain("super-secret-password-1234");

		await authTransport.stop();
	});
});
