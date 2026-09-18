/**
 * Test doubles for the Discord transport.
 *
 * This is not a product module. It lives in `src/` only so the gateway and
 * transport tests share one implementation of the fake socket, scheduler and
 * REST surface. It is excluded from coverage in `vitest.config.ts`.
 */

import type { Logger } from "../../core/types.js";
import type { GatewayScheduler, GatewaySocket, SocketFactory, TimerHandle } from "./gateway.js";
import type { DiscordApi, DiscordBotIdentity } from "./rest.js";

/** Lets a promise chain settle without touching real timers. */
export function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

export class FakeScheduler implements GatewayScheduler {
	private next = 1;
	private readonly intervals = new Map<TimerHandle, { callback: () => void; ms: number }>();
	private readonly timeouts = new Map<TimerHandle, { callback: () => void; ms: number }>();

	setInterval(callback: () => void, ms: number): TimerHandle {
		const handle = this.next++;
		this.intervals.set(handle, { callback, ms });
		return handle;
	}

	clearInterval(handle: TimerHandle): void {
		this.intervals.delete(handle);
	}

	setTimeout(callback: () => void, ms: number): TimerHandle {
		const handle = this.next++;
		this.timeouts.set(handle, { callback, ms });
		return handle;
	}

	clearTimeout(handle: TimerHandle): void {
		this.timeouts.delete(handle);
	}

	fireIntervals(): number {
		const pending = [...this.intervals.values()];
		for (const timer of pending) timer.callback();
		return pending.length;
	}

	/** When `ms` is given, only timers with that exact delay fire. */
	fireTimeouts(ms?: number): number {
		const due = [...this.timeouts.entries()].filter(([, timer]) => ms === undefined || timer.ms === ms);
		for (const [handle, timer] of due) {
			this.timeouts.delete(handle);
			timer.callback();
		}
		return due.length;
	}

	get intervalMs(): number | undefined {
		return [...this.intervals.values()][0]?.ms;
	}

	get pendingTimeouts(): number {
		return this.timeouts.size;
	}

	get timeoutDelays(): number[] {
		return [...this.timeouts.values()].map((timer) => timer.ms);
	}
}

export class FakeSocket implements GatewaySocket {
	readonly frames: Array<Record<string, unknown>> = [];
	closed: { code?: number; reason?: string } | null = null;

	private readonly openHandlers: Array<() => void> = [];
	private readonly messageHandlers: Array<(data: string) => void> = [];
	private readonly closeHandlers: Array<(code: number, reason: string) => void> = [];
	private readonly errorHandlers: Array<(error: Error) => void> = [];

	constructor(readonly url: string) {}

	send(data: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(data) as unknown;
		} catch (error) {
			throw new Error(`FakeSocket received non-JSON: ${String(error)}`);
		}
		this.frames.push(parsed as Record<string, unknown>);
	}

	close(code?: number, reason?: string): void {
		this.closed = { code, reason };
	}

	onOpen(handler: () => void): void {
		this.openHandlers.push(handler);
	}

	onMessage(handler: (data: string) => void): void {
		this.messageHandlers.push(handler);
	}

	onClose(handler: (code: number, reason: string) => void): void {
		this.closeHandlers.push(handler);
	}

	onError(handler: (error: Error) => void): void {
		this.errorHandlers.push(handler);
	}

	emitOpen(): void {
		for (const handler of this.openHandlers) handler();
	}

	emit(frame: unknown): void {
		this.emitRaw(JSON.stringify(frame));
	}

	emitRaw(data: string): void {
		for (const handler of this.messageHandlers) handler(data);
	}

	emitClose(code: number, reason = ""): void {
		for (const handler of this.closeHandlers) handler(code, reason);
	}

	emitError(message: string): void {
		for (const handler of this.errorHandlers) handler(new Error(message));
	}

	get ops(): number[] {
		return this.frames.map((frame) => frame.op as number);
	}

	get lastFrame(): Record<string, unknown> | undefined {
		return this.frames.at(-1);
	}
}

/** Collects every socket the gateway opens, in order. */
export function socketFactory(sockets: FakeSocket[]): SocketFactory {
	return (url) => {
		const socket = new FakeSocket(url);
		sockets.push(socket);
		return socket;
	};
}

export function helloFrame(heartbeatIntervalMs = 45_000): Record<string, unknown> {
	return { op: 10, d: { heartbeat_interval: heartbeatIntervalMs } };
}

export function dispatchFrame(sequence: number, type: string, data: unknown): Record<string, unknown> {
	return { op: 0, s: sequence, t: type, d: data };
}

export function readyFrame(
	options: { sessionId?: string; resumeUrl?: string; botId?: string } = {},
): Record<string, unknown> {
	return dispatchFrame(1, "READY", {
		session_id: options.sessionId ?? "session-1",
		...(options.resumeUrl === undefined ? {} : { resume_gateway_url: options.resumeUrl }),
		user: { id: options.botId ?? "bot-1" },
	});
}

/** Minimal Discord message payload for MESSAGE_CREATE. */
export function messagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "m1",
		channel_id: "chan-1",
		content: "hello",
		type: 0,
		author: { id: "user-9", username: "someone" },
		timestamp: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

export class FakeRest implements DiscordApi {
	identity: DiscordBotIdentity = { id: "bot-1", username: "pi-bot" };
	gatewayUrl = "wss://gateway.example";
	identityError: Error | null = null;
	readonly created: Array<{ channelId: string; content: string }> = [];
	readonly edited: Array<{ channelId: string; messageId: string; content: string }> = [];
	identityCalls = 0;

	getBotIdentity(): Promise<DiscordBotIdentity> {
		this.identityCalls++;
		if (this.identityError !== null) return Promise.reject(this.identityError);
		return Promise.resolve(this.identity);
	}

	resolveGatewayUrl(): Promise<string> {
		return Promise.resolve(this.gatewayUrl);
	}

	createMessage(channelId: string, content: string): Promise<{ id: string }> {
		this.created.push({ channelId, content });
		return Promise.resolve({ id: `msg-${this.created.length}` });
	}

	editMessage(channelId: string, messageId: string, content: string): Promise<void> {
		this.edited.push({ channelId, messageId, content });
		return Promise.resolve();
	}
}

/** Silences the transport during tests without hiding real failures. */
export const silentLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};
