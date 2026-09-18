/**
 * Discord transport.
 *
 * Composition: single-instance lock → REST identity check → gateway → Envelope.
 *
 * The lock is mandatory here. Discord closes the older gateway session when the
 * same bot token connects twice, so two pi processes would silently steal
 * messages from each other.
 */

import { join } from "node:path";
import { acquireLock, describeHolder, type LockHandle } from "../../lock.js";
import type {
	Envelope,
	EnvelopeHandler,
	Logger,
	OutboundMessage,
	SendReceipt,
	Transport,
	TransportCapabilities,
} from "../../core/types.js";
import { DiscordGateway, systemScheduler, type GatewayScheduler, type SocketFactory } from "./gateway.js";
import { DISCORD_DEFAULT_INTENTS, DISCORD_TRANSPORT_ID, normalizeDiscordMessage } from "./normalize.js";
import { DiscordRest, type DiscordApi } from "./rest.js";

/** Discord's real limits, as of API v10. */
export const DISCORD_CAPABILITIES: TransportCapabilities = {
	threads: false,
	edit: true,
	reactions: false,
	attachments: true,
	maxMessageLength: 2000,
	lengthUnit: "chars",
	markdown: "markdown",
	channels: true,
};

export interface DiscordTransportOptions {
	readonly token: string;
	/** Directory holding the per-bot single-instance lock file. */
	readonly lockDir: string;
	readonly logger: Logger;
	readonly intents?: number;
	readonly rest?: DiscordApi;
	readonly createSocket?: SocketFactory;
	readonly scheduler?: GatewayScheduler;
	readonly lockStaleMs?: number;
}

export class DiscordTransport implements Transport {
	readonly id = DISCORD_TRANSPORT_ID;
	readonly capabilities = DISCORD_CAPABILITIES;

	private readonly options: DiscordTransportOptions;
	private readonly rest: DiscordApi;
	private readonly scheduler: GatewayScheduler;

	private handler: EnvelopeHandler | null = null;
	private gateway: DiscordGateway | null = null;
	private lock: LockHandle | null = null;
	private botId: string | null = null;
	private botUsername: string | null = null;
	private lastSkipReason: string | null = null;
	private received = 0;
	/** Serializes inbound messages so they reach the bridge in order. */
	private queue: Promise<void> = Promise.resolve();

	constructor(options: DiscordTransportOptions) {
		this.options = options;
		this.rest = options.rest ?? new DiscordRest({ token: options.token });
		this.scheduler = options.scheduler ?? systemScheduler;
	}

	async start(handler: EnvelopeHandler): Promise<void> {
		if (this.handler !== null) throw new Error("Discord transport is already started");

		// One REST call up front: it validates the token and gives us the bot id,
		// which is what keeps the lock path from depending on the token itself.
		const me = await this.rest.getBotIdentity();
		if (me.id.length === 0) throw new Error("Discord returned an empty bot id");
		this.botId = me.id;
		this.botUsername = me.username;

		const acquired = await acquireLock({
			path: join(this.options.lockDir, `discord-${me.id}.lock`),
			logger: this.options.logger,
			...(this.options.lockStaleMs === undefined ? {} : { staleMs: this.options.lockStaleMs }),
		});
		if (!acquired.ok) {
			throw new Error(
				`another pi process already holds this Discord bot (${describeHolder(acquired.holder)}); Discord allows only one gateway session per bot token`,
			);
		}
		this.lock = acquired.lock;

		this.handler = handler;
		this.gateway = new DiscordGateway({
			token: this.options.token,
			intents: this.options.intents ?? DISCORD_DEFAULT_INTENTS,
			resolveGatewayUrl: () => this.rest.resolveGatewayUrl(),
			createSocket: this.createSocket(),
			scheduler: this.scheduler,
			hooks: {
				onDispatch: (type, data) => this.onDispatch(type, data),
				log: this.options.logger,
			},
		});

		try {
			await this.gateway.start();
			this.options.logger.info("discord transport ready", { botId: me.id, username: me.username });
		} catch (error) {
			// Never keep a lock we did not earn: this transport is not running.
			this.handler = null;
			this.gateway = null;
			await this.lock?.release();
			this.lock = null;
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.handler = null;
		this.gateway?.stop();
		this.gateway = null;
		await this.queue;
		await this.lock?.release();
		this.lock = null;
	}

	async send(message: OutboundMessage): Promise<SendReceipt> {
		if (this.handler === null) throw new Error("Discord transport is not started");

		if (message.editKey !== undefined) {
			await this.rest.editMessage(message.conversationId, message.editKey, message.text);
			return { messageId: message.editKey, editKey: message.editKey };
		}

		const created = await this.rest.createMessage(message.conversationId, message.text);
		return { messageId: created.id, editKey: created.id };
	}

	/** Health detail for `/connect doctor`. Never contains the token. */
	diagnose(): string {
		const botId = this.botId;
		const parts: string[] = [];
		parts.push(botId === null ? "not identified" : `bot ${this.botUsername ?? "?"} (${botId})`);
		parts.push(this.gateway?.describe() ?? (this.handler === null ? "not started" : "no gateway"));
		parts.push(this.lock === null ? "lock not held" : "lock held");
		parts.push(`received ${this.received} message(s)`);
		if (this.lastSkipReason !== null) parts.push(`last skip: ${this.lastSkipReason}`);
		return parts.join(", ");
	}

	// --- internals -----------------------------------------------------------

	private createSocket(): SocketFactory {
		const injected = this.options.createSocket;
		if (injected !== undefined) return injected;
		return (url) => {
			const socket = new WebSocket(url);
			return {
				send: (data) => socket.send(data),
				close: (code, reason) => socket.close(code, reason),
				onOpen: (handler) => socket.addEventListener("open", () => handler()),
				onMessage: (handler) => {
					socket.addEventListener("message", (event) => {
						if (typeof event.data === "string") handler(event.data);
					});
				},
				onClose: (handler) => {
					socket.addEventListener("close", (event) => handler(event.code, event.reason));
				},
				onError: (handler) => {
					socket.addEventListener("error", () => handler(new Error("discord gateway socket error")));
				},
			};
		};
	}

	private onDispatch(type: string, data: unknown): void {
		if (type !== "MESSAGE_CREATE") return;

		const botId = this.botId;
		if (botId === null) return;

		const result = normalizeDiscordMessage(data, { botId });
		if (result.kind === "skip") {
			this.lastSkipReason = result.reason;
			this.options.logger.debug("discord message skipped", { reason: result.reason });
			return;
		}

		this.received++;
		const envelope: Envelope = result.envelope;
		this.queue = this.queue.then(() => this.deliver(envelope));
	}

	private async deliver(envelope: Envelope): Promise<void> {
		const handler = this.handler;
		if (handler === null) return;
		try {
			await handler(envelope);
		} catch (error) {
			this.options.logger.error("discord message handler failed", { error: String(error) });
		}
	}
}
