/**
 * RoboClaw gRPC transport implementation.
 *
 * Exposes a gRPC server running RoboMessenger (proto/messenger.proto),
 * allowing clients like robo_claw_talk to connect directly over the internal network.
 */

import { join } from "node:path";
import type {
	Envelope,
	EnvelopeHandler,
	Logger,
	OutboundMessage,
	SendReceipt,
	Transport,
	TransportCapabilities,
} from "../../core/types.js";
import { acquireLock, LockHeldError, type LockHandle } from "../../lock.js";
import {
	extractAuthToken,
	normalizeInbound,
	normalizeOutbound,
	ROBO_CLAW_TRANSPORT_ID,
	type RoboClawChatMessage,
} from "./normalize.js";
import {
	DefaultGrpcServerAdapter,
	type GrpcServerAdapter,
	type GrpcStreamCall,
} from "./server.js";

export const DEFAULT_ROBO_CLAW_PORT = 50052;
export const DEFAULT_ROBO_CLAW_HOST = "0.0.0.0";

export interface RoboClawTransportOptions {
	readonly port?: number;
	readonly host?: string;
	readonly token?: string;
	readonly lockDir: string;
	readonly lockStaleMs?: number;
	readonly logger: Logger;
	readonly serverAdapter?: GrpcServerAdapter;
	readonly selfSenderId?: string;
}

export class RoboClawTransport implements Transport {
	readonly id = ROBO_CLAW_TRANSPORT_ID;

	readonly capabilities: TransportCapabilities = {
		threads: false,
		edit: false,
		reactions: false,
		attachments: true,
		maxMessageLength: 4000,
		lengthUnit: "chars",
		markdown: "markdown",
		channels: false,
	};

	private readonly port: number;
	private readonly host: string;
	private readonly token?: string;
	private readonly lockDir: string;
	private readonly lockStaleMs?: number;
	private readonly logger: Logger;
	private readonly serverAdapter: GrpcServerAdapter;
	private readonly selfSenderId: string;

	private lock: LockHandle | null = null;
	private handler: EnvelopeHandler | null = null;
	private started = false;
	private stopped = false;
	private messageCounter = 0;

	private readonly activeStreams = new Map<GrpcStreamCall, Set<string>>();
	private pendingOutbound: Array<{ conversationId: string; message: RoboClawChatMessage }> = [];

	constructor(options: RoboClawTransportOptions) {
		this.port = options.port ?? DEFAULT_ROBO_CLAW_PORT;
		this.host = options.host ?? DEFAULT_ROBO_CLAW_HOST;
		this.token = options.token && options.token.trim().length > 0 ? options.token.trim() : undefined;
		this.lockDir = options.lockDir;
		this.lockStaleMs = options.lockStaleMs;
		this.logger = options.logger;
		this.serverAdapter = options.serverAdapter ?? new DefaultGrpcServerAdapter();
		this.selfSenderId = options.selfSenderId ?? "robot";
	}

	async start(handler: EnvelopeHandler): Promise<void> {
		if (this.started) return;
		this.handler = handler;

		const lockPath = join(this.lockDir, `robo_claw-${this.port}.lock`);
		const acquired = await acquireLock({
			path: lockPath,
			logger: this.logger,
			...(this.lockStaleMs === undefined ? {} : { staleMs: this.lockStaleMs }),
		});

		if (!acquired.ok) {
			throw new LockHeldError(lockPath, acquired.holder);
		}
		this.lock = acquired.lock;

		try {
			await this.serverAdapter.start(this.host, this.port, {
				chatStream: (call) => this.handleChatStream(call),
			});
			this.started = true;
			this.stopped = false;
			this.logger.info("RoboClaw gRPC transport started", {
				port: this.port,
				host: this.host,
			});
		} catch (error) {
			await this.lock.release().catch(() => undefined);
			this.lock = null;
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.handler = null;
		if (this.stopped || !this.started) {
			// Ensure lock is cleaned up even if start failed partially
			if (this.lock) {
				await this.lock.release().catch(() => undefined);
				this.lock = null;
			}
			this.stopped = true;
			return;
		}

		this.stopped = true;
		this.started = false;

		for (const stream of this.activeStreams.keys()) {
			try {
				stream.end();
			} catch {
				// Ignore errors on stream shutdown
			}
		}
		this.activeStreams.clear();
		this.pendingOutbound.length = 0;

		await this.serverAdapter.stop().catch((err) => {
			this.logger.warn("Error stopping gRPC server", { error: String(err) });
		});

		if (this.lock) {
			await this.lock.release().catch(() => undefined);
			this.lock = null;
		}
	}

	async send(message: OutboundMessage): Promise<SendReceipt> {
		if (!this.started || this.stopped) {
			throw new Error("RoboClawTransport is not started");
		}

		const messageId = `rc_${Date.now()}_${++this.messageCounter}`;
		const chatMsg = normalizeOutbound(message, {
			senderId: this.selfSenderId,
			now: Date.now(),
		});

		const streams = [...this.activeStreams].filter(([, rooms]) => rooms.has(message.conversationId));
		if (streams.length > 0) {
			let anySuccess = false;
			let lastError: unknown = null;
			for (const [stream] of streams) {
				try {
					stream.write(chatMsg);
					anySuccess = true;
				} catch (err) {
					lastError = err;
					this.logger.warn("Failed to write to active stream", { error: String(err) });
				}
			}
			if (!anySuccess && lastError) {
				throw lastError instanceof Error ? lastError : new Error(String(lastError));
			}
		} else {
			// Buffer outbound message until a client connects
			if (this.pendingOutbound.length >= 50) {
				this.pendingOutbound.shift();
			}
			this.pendingOutbound.push({ conversationId: message.conversationId, message: chatMsg });
		}

		return { messageId };
	}

	cancelPendingConversation(conversationId: string): void {
		this.pendingOutbound = this.pendingOutbound.filter((entry) => entry.conversationId !== conversationId);
	}

	diagnose(): string {
		const tokenStatus = this.token ? "protected" : "none";
		return `robo_claw: port=${this.port}, host=${this.host}, active_streams=${this.activeStreams.size}, token: ${tokenStatus}`;
	}

	private handleChatStream(call: GrpcStreamCall): void {
		let authenticated = this.token === undefined;
		const rooms = new Set<string>();

		// Check initial call headers for peer token
		if (!authenticated && this.token) {
			const headerToken = extractAuthToken(null, call.metadata);
			if (headerToken === this.token) {
				authenticated = true;
			}
		}

		const onStreamEnd = () => {
			this.activeStreams.delete(call);
		};

		call.on("end", onStreamEnd);
		call.on("error", onStreamEnd);

		if (authenticated) {
			this.activeStreams.set(call, rooms);
		}

		call.on("data", (msg: RoboClawChatMessage) => {
			if (!authenticated && this.token) {
				const messageToken = extractAuthToken(msg, call.metadata);
				if (messageToken !== this.token) {
					this.logger.warn("RoboClaw rejected unauthenticated client message");
					call.destroy(new Error("UNAUTHENTICATED: invalid peer token"));
					return;
				}
				authenticated = true;
				this.activeStreams.set(call, rooms);
			}

			const result = normalizeInbound(msg, {
				selfSenderId: this.selfSenderId,
			});

			if (result.kind === "envelope" && this.handler) {
				rooms.add(result.envelope.conversationId);
				void this.dispatch(call, this.handler, result.envelope);
			}
		});
	}

	private async dispatch(call: GrpcStreamCall, handler: EnvelopeHandler, envelope: Envelope): Promise<void> {
		try {
			await handler(envelope);
			if (this.activeStreams.has(call)) this.flushRoom(call, envelope.conversationId);
		} catch (error) {
			this.logger.warn("RoboClaw handler failed", { error: String(error) });
		}
	}

	private flushRoom(call: GrpcStreamCall, conversationId: string): void {
		const pending = this.pendingOutbound.filter((entry) => entry.conversationId === conversationId);
		if (pending.length === 0) return;
		this.cancelPendingConversation(conversationId);
		for (const entry of pending) {
			try {
				call.write(entry.message);
			} catch (error) {
				this.logger.warn("RoboClaw buffered message failed", { error: String(error) });
			}
		}
	}
}
