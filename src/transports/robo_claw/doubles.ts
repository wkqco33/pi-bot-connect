/**
 * Test doubles for the RoboClaw gRPC transport.
 *
 * Excluded from coverage.
 */

import type { Logger } from "../../core/types.js";
import type { RoboClawChatMessage } from "./normalize.js";
import type { GrpcServerAdapter, GrpcStreamCall, RoboMessengerHandlers } from "./server.js";

export const silentLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

export class FakeGrpcCall implements GrpcStreamCall {
	readonly written: RoboClawChatMessage[] = [];
	destroyedWith: Error | null = null;
	ended = false;

	private readonly dataListeners: Array<(msg: RoboClawChatMessage) => void> = [];
	private readonly endListeners: Array<() => void> = [];
	private readonly errorListeners: Array<(err: Error) => void> = [];

	constructor(readonly metadata: Readonly<Record<string, string | string[]>> = {}) {}

	on(event: "data", listener: (msg: RoboClawChatMessage) => void): this;
	on(event: "end", listener: () => void): this;
	on(event: "error", listener: (err: Error) => void): this;
	on(
		event: "data" | "end" | "error",
		listener: ((msg: RoboClawChatMessage) => void) | (() => void) | ((err: Error) => void),
	): this {
		if (event === "data") this.dataListeners.push(listener as (msg: RoboClawChatMessage) => void);
		if (event === "end") this.endListeners.push(listener as () => void);
		if (event === "error") this.errorListeners.push(listener as (err: Error) => void);
		return this;
	}

	write(msg: RoboClawChatMessage): boolean {
		if (this.ended || this.destroyedWith) {
			throw new Error("Cannot write to closed gRPC call");
		}
		this.written.push(msg);
		return true;
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		for (const listener of this.endListeners) listener();
	}

	destroy(error?: Error): void {
		if (this.destroyedWith) return;
		this.destroyedWith = error ?? new Error("Call destroyed");
		for (const listener of this.errorListeners) listener(this.destroyedWith);
	}

	/** Test helper to simulate client sending a message to server. */
	emitInbound(msg: RoboClawChatMessage): void {
		for (const listener of this.dataListeners) listener(msg);
	}
}

export class FakeGrpcServerAdapter implements GrpcServerAdapter {
	started = false;
	stopped = false;
	boundHost = "";
	boundPort = 0;
	handlers: RoboMessengerHandlers | null = null;
	activeCalls: FakeGrpcCall[] = [];
	failNextStart: Error | null = null;
	failNextSend = false;

	async start(host: string, port: number, handlers: RoboMessengerHandlers): Promise<number> {
		if (this.failNextStart) {
			const err = this.failNextStart;
			this.failNextStart = null;
			throw err;
		}
		this.started = true;
		this.stopped = false;
		this.boundHost = host;
		this.boundPort = port;
		this.handlers = handlers;
		return port;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.started = false;
		for (const call of this.activeCalls) {
			call.end();
		}
		this.activeCalls = [];
	}

	/** Test helper: simulate a client connecting to ChatStream. */
	simulateClientConnect(metadata: Record<string, string | string[]> = {}): FakeGrpcCall {
		if (!this.handlers) {
			throw new Error("Cannot connect client: server handlers not registered");
		}
		const call = new FakeGrpcCall(metadata);
		this.activeCalls.push(call);
		this.handlers.chatStream(call);
		return call;
	}
}
