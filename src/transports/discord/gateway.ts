/**
 * Minimal Discord gateway (v10) client.
 *
 * Deliberately not `discord.js`: the whole surface we need is HELLO, IDENTIFY,
 * RESUME, heartbeat and DISPATCH, and keeping it here means no third-party
 * runtime dependency to audit.
 *
 * Both the socket and the timer are injected, so the handshake, heartbeat and
 * reconnect state machine is fully covered by tests against a fake socket.
 */

import { DISCORD_API_VERSION } from "./normalize.js";
import type { Logger } from "../../core/types.js";

export interface GatewaySocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onOpen(handler: () => void): void;
	onMessage(handler: (data: string) => void): void;
	onClose(handler: (code: number, reason: string) => void): void;
	onError(handler: (error: Error) => void): void;
}

export type SocketFactory = (url: string) => GatewaySocket;

/**
 * Opaque timer handle. The scheduler that created it is the only thing allowed
 * to interpret it, which is why it is a number rather than a platform object.
 */
export type TimerHandle = number;

export interface GatewayScheduler {
	setInterval(callback: () => void, ms: number): TimerHandle;
	clearInterval(handle: TimerHandle): void;
	setTimeout(callback: () => void, ms: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
}

function createSystemScheduler(): GatewayScheduler {
	let nextHandle = 1;
	const timers = new Map<TimerHandle, ReturnType<typeof setTimeout>>();

	const clear = (handle: TimerHandle): boolean => {
		const timer = timers.get(handle);
		if (timer === undefined) return false;
		timers.delete(handle);
		clearTimeout(timer);
		return true;
	};

	return {
		setInterval(callback, ms) {
			const handle = nextHandle++;
			timers.set(
				handle,
				setInterval(() => callback(), ms),
			);
			return handle;
		},
		clearInterval(handle) {
			clear(handle);
		},
		setTimeout(callback, ms) {
			const handle = nextHandle++;
			timers.set(
				handle,
				setTimeout(() => {
					timers.delete(handle);
					callback();
				}, ms),
			);
			return handle;
		},
		clearTimeout(handle) {
			clear(handle);
		},
	};
}

export const systemScheduler: GatewayScheduler = createSystemScheduler();

/** Gateway opcodes we act on. */
export const OP = {
	DISPATCH: 0,
	HEARTBEAT: 1,
	IDENTIFY: 2,
	RESUME: 6,
	RECONNECT: 7,
	INVALID_SESSION: 9,
	HELLO: 10,
	HEARTBEAT_ACK: 11,
} as const;

/** Close codes that mean "do not retry": the credentials or intents are wrong. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000] as const;
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_HEARTBEAT_MS = 45_000;

export type GatewayState = "idle" | "connecting" | "reconnecting" | "ready" | "error" | "stopped";

export interface GatewayHooks {
	readonly onDispatch: (type: string, data: unknown) => void;
	readonly log: Logger;
}

export interface DiscordGatewayOptions {
	readonly token: string;
	readonly intents: number;
	readonly resolveGatewayUrl: () => Promise<string>;
	readonly createSocket: SocketFactory;
	readonly scheduler: GatewayScheduler;
	readonly hooks: GatewayHooks;
	readonly readyTimeoutMs?: number;
	readonly backoffMs?: readonly number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

export class DiscordGateway {
	private readonly options: DiscordGatewayOptions;

	private socket: GatewaySocket | null = null;
	private heartbeatTimer: TimerHandle | null = null;
	private reconnectTimer: TimerHandle | null = null;
	private readyTimer: TimerHandle | null = null;

	private sequence: number | null = null;
	private sessionId: string | null = null;
	private resumeUrl: string | null = null;
	private botUserId: string | null = null;

	private acked = true;
	private attempts = 0;
	private stopped = false;
	private currentState: GatewayState = "idle";
	private lastError: string | null = null;

	private resolveReady: (() => void) | null = null;
	private rejectReady: ((error: Error) => void) | null = null;

	constructor(options: DiscordGatewayOptions) {
		this.options = options;
	}

	get state(): GatewayState {
		return this.currentState;
	}

	get botId(): string | null {
		return this.botUserId;
	}

	/** One-line health summary for `/connect doctor`. Never contains the token. */
	describe(): string {
		if (this.currentState === "error") return `error: ${this.lastError ?? "unknown"}`;
		const identity = this.botUserId === null ? "" : ` as bot ${this.botUserId}`;
		const session = this.sessionId === null ? "" : " (resumable)";
		return `${this.currentState}${identity}${session}`;
	}

	/** Resolves once READY arrives. Rejects on a fatal close or ready timeout. */
	start(): Promise<void> {
		if (this.currentState !== "idle") {
			return Promise.reject(new Error(`Discord gateway is already ${this.currentState}`));
		}
		this.stopped = false;

		const ready = new Promise<void>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		// `stop()` may reject this before anyone awaits it.
		ready.catch(() => undefined);

		void this.open().catch((error: unknown) => this.fail(toError(error)));
		return ready;
	}

	stop(): void {
		this.stopped = true;
		this.stopHeartbeat();
		this.clearReadyTimer();
		if (this.reconnectTimer !== null) {
			this.options.scheduler.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.closeSocket();
		this.currentState = "stopped";

		const reject = this.rejectReady;
		this.resolveReady = null;
		this.rejectReady = null;
		reject?.(new Error("Discord gateway stopped before becoming ready"));
	}

	// --- connection ----------------------------------------------------------

	private open(): Promise<void> {
		if (this.resolveReady !== null && this.readyTimer === null) {
			const timeout = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
			this.readyTimer = this.options.scheduler.setTimeout(() => {
				this.fail(new Error(`Discord gateway did not become ready within ${timeout}ms`));
			}, timeout);
		}

		this.currentState = this.sessionId === null ? "connecting" : "reconnecting";

		const base = this.resumeUrl;
		const resolveUrl = base === null ? this.options.resolveGatewayUrl() : Promise.resolve(base);
		return resolveUrl.then((url) => {
			if (this.stopped) return;
			const separator = url.includes("?") ? "&" : "?";
			const socket = this.options.createSocket(`${url}${separator}v=${DISCORD_API_VERSION}&encoding=json`);
			this.socket = socket;
			socket.onOpen(() => this.options.hooks.log.debug("discord gateway socket open"));
			socket.onMessage((data) => this.handleMessage(data));
			socket.onError((error) => this.options.hooks.log.warn("discord gateway socket error", { error: error.message }));
			socket.onClose((code, reason) => this.handleClose(code, reason));
		});
	}

	private closeSocket(): void {
		const socket = this.socket;
		this.socket = null;
		if (!socket) return;
		try {
			socket.close(1000, "client closing");
		} catch (error) {
			this.options.hooks.log.debug("discord gateway close failed", { error: String(error) });
		}
	}

	private send(frame: unknown): void {
		const socket = this.socket;
		if (!socket) return;
		try {
			socket.send(JSON.stringify(frame));
		} catch (error) {
			this.options.hooks.log.warn("discord gateway send failed", { error: String(error) });
		}
	}

	private fail(error: Error): void {
		if (this.currentState === "error") return;
		this.stopHeartbeat();
		this.clearReadyTimer();
		if (this.reconnectTimer !== null) {
			this.options.scheduler.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.closeSocket();
		this.currentState = "error";
		this.lastError = error.message;

		const reject = this.rejectReady;
		this.resolveReady = null;
		this.rejectReady = null;
		if (reject) reject(error);
		else this.options.hooks.log.error("discord gateway failed", { error: error.message });
	}

	private clearReadyTimer(): void {
		if (this.readyTimer === null) return;
		this.options.scheduler.clearTimeout(this.readyTimer);
		this.readyTimer = null;
	}

	// --- frames --------------------------------------------------------------

	private handleMessage(data: string): void {
		let payload: unknown;
		try {
			payload = JSON.parse(data) as unknown;
		} catch (error) {
			this.options.hooks.log.warn("discord gateway sent malformed JSON", { error: String(error) });
			return;
		}
		if (!isRecord(payload)) return;

		const op = typeof payload.op === "number" ? payload.op : -1;
		if (op === OP.HELLO) this.handleHello(payload.d);
		else if (op === OP.HEARTBEAT_ACK) this.acked = true;
		else if (op === OP.HEARTBEAT) this.sendHeartbeat();
		else if (op === OP.RECONNECT) this.reconnect("server requested a reconnect");
		else if (op === OP.INVALID_SESSION) this.handleInvalidSession(payload.d);
		else if (op === OP.DISPATCH) this.handleDispatch(payload);
	}

	private handleHello(raw: unknown): void {
		const interval = isRecord(raw) && typeof raw.heartbeat_interval === "number" ? raw.heartbeat_interval : DEFAULT_HEARTBEAT_MS;
		this.startHeartbeat(interval);

		if (this.sessionId !== null && this.sequence !== null) {
			this.send({ op: OP.RESUME, d: { token: this.options.token, session_id: this.sessionId, seq: this.sequence } });
			this.options.hooks.log.info("discord gateway resuming");
			return;
		}

		this.send({
			op: OP.IDENTIFY,
			d: {
				token: this.options.token,
				intents: this.options.intents,
				properties: { os: process.platform, browser: "pi-bot-connect", device: "pi-bot-connect" },
			},
		});
		this.options.hooks.log.info("discord gateway identifying", { intents: this.options.intents });
	}

	private handleDispatch(frame: Record<string, unknown>): void {
		if (typeof frame.s === "number") this.sequence = frame.s;
		const type = typeof frame.t === "string" ? frame.t : null;
		if (type === null) return;
		if (type === "READY") {
			this.handleReady(frame.d);
			return;
		}
		this.options.hooks.onDispatch(type, frame.d);
	}

	private handleReady(raw: unknown): void {
		if (!isRecord(raw)) return;
		if (typeof raw.session_id === "string") this.sessionId = raw.session_id;
		if (typeof raw.resume_gateway_url === "string") this.resumeUrl = raw.resume_gateway_url;
		if (isRecord(raw.user) && typeof raw.user.id === "string") this.botUserId = raw.user.id;

		this.attempts = 0;
		this.clearReadyTimer();
		this.currentState = "ready";

		const resolve = this.resolveReady;
		this.resolveReady = null;
		this.rejectReady = null;
		resolve?.();
	}

	private handleClose(code: number, reason: string): void {
		this.stopHeartbeat();
		this.socket = null;
		if (this.stopped) return;

		this.options.hooks.log.warn("discord gateway closed", { code, reason });
		if (FATAL_CLOSE_CODES.has(code)) {
			const suffix = reason.length > 0 ? ` (${reason})` : "";
			this.fail(
				new Error(
					`Discord closed the gateway with code ${code}${suffix}. Check the bot token and that the Message Content intent is enabled.`,
				),
			);
			return;
		}

		// These two codes mean the session is gone, so a RESUME would fail.
		if (code === 4007 || code === 4009) {
			this.sessionId = null;
			this.sequence = null;
		}
		this.reconnect(`close ${code}`);
	}

	private handleInvalidSession(raw: unknown): void {
		const resumable = raw === true;
		if (!resumable) {
			this.sessionId = null;
			this.sequence = null;
		}
		this.reconnect(resumable ? "session invalidated" : "session invalidated and not resumable");
	}

	// --- heartbeat -----------------------------------------------------------

	private startHeartbeat(intervalMs: number): void {
		this.stopHeartbeat();
		this.acked = true;
		this.heartbeatTimer = this.options.scheduler.setInterval(() => this.sendHeartbeat(), intervalMs);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer === null) return;
		this.options.scheduler.clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
	}

	private sendHeartbeat(): void {
		if (this.stopped) return;
		// A missed ack means the connection is a zombie: reconnect rather than
		// keep sending into a dead socket.
		if (!this.acked) {
			this.reconnect("heartbeat was not acknowledged");
			return;
		}
		this.acked = false;
		this.send({ op: OP.HEARTBEAT, d: this.sequence });
	}

	// --- reconnect -----------------------------------------------------------

	private reconnect(reason: string): void {
		if (this.stopped || this.currentState === "error") return;
		if (this.reconnectTimer !== null) return;

		this.closeSocket();
		this.stopHeartbeat();
		this.currentState = "reconnecting";

		const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF_MS;
		if (this.attempts >= backoff.length) {
			this.fail(new Error(`Discord gateway kept failing (${reason}) after ${this.attempts} attempts`));
			return;
		}

		const delay = backoff[this.attempts] ?? backoff[backoff.length - 1] ?? 30_000;
		this.attempts++;
		this.options.hooks.log.info("discord gateway reconnecting", { delay, attempt: this.attempts, reason });

		this.reconnectTimer = this.options.scheduler.setTimeout(() => {
			this.reconnectTimer = null;
			if (this.stopped) return;
			void this.open().catch((error: unknown) => this.fail(toError(error)));
		}, delay);
	}
}
