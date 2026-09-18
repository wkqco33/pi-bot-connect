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
	FetchedAttachment,
	InboundAttachment,
	Logger,
	OutboundMessage,
	SendReceipt,
	Transport,
	TransportCapabilities,
} from "../../core/types.js";
import { DiscordGateway, systemScheduler, type GatewayScheduler, type SocketFactory } from "./gateway.js";
import { DISCORD_DEFAULT_INTENTS, DISCORD_TRANSPORT_ID, normalizeDiscordMessage } from "./normalize.js";
import { DiscordRest, type DiscordApi } from "./rest.js";

/** Discord's own CDN limit for a bot upload; used as the default download cap. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Per-download deadline. A signed CDN URL that stalls must not stall a turn. */
export const DEFAULT_ATTACHMENT_TIMEOUT_MS = 20_000;

/**
 * How often one channel may be told "typing". Discord expires the indicator
 * after ~10 seconds and rate-limits the endpoint, so hints are throttled below
 * that window rather than fired on every progress update.
 */
export const DEFAULT_TYPING_MIN_INTERVAL_MS = 8_000;

/** Discord's real limits, as of API v10. */
export const DISCORD_CAPABILITIES: TransportCapabilities = {
	threads: false,
	edit: true,
	reactions: false,
	attachments: true,
	maxMessageLength: 2000,
	// Discord counts UTF-16 code units, so an emoji (a surrogate pair) costs two
	// of the 2000 units.
	lengthUnit: "utf16",
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
	/** Cap for a downloaded attachment. Discord's own CDN limit is 25 MB. */
	readonly maxAttachmentBytes?: number;
	/** Per-download deadline; aborts a CDN request that never completes. */
	readonly attachmentTimeoutMs?: number;
	readonly fetchImpl?: typeof fetch;
	/** Minimum gap between typing hints for the same channel. */
	readonly typingMinIntervalMs?: number;
	/** Injected for deterministic typing-throttle tests. */
	readonly now?: () => number;
}

export class DiscordTransport implements Transport {
	readonly id = DISCORD_TRANSPORT_ID;
	readonly capabilities = DISCORD_CAPABILITIES;

	private readonly options: DiscordTransportOptions;
	private readonly rest: DiscordApi;
	private readonly scheduler: GatewayScheduler;
	private readonly fetchImpl: typeof fetch;
	private readonly maxAttachmentBytes: number;
	private readonly attachmentTimeoutMs: number;
	private readonly typingMinIntervalMs: number;
	private readonly now: () => number;
	/** Last time each channel was told "typing", keyed by channel id. */
	private readonly typingAt = new Map<string, number>();

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
		this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
		this.maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
		this.attachmentTimeoutMs = options.attachmentTimeoutMs ?? DEFAULT_ATTACHMENT_TIMEOUT_MS;
		this.typingMinIntervalMs = options.typingMinIntervalMs ?? DEFAULT_TYPING_MIN_INTERVAL_MS;
		this.now = options.now ?? Date.now;
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

	/**
	 * Downloads an attachment from the Discord CDN.
	 *
	 * Discord CDN URLs are signed and need no Authorization header, so this does
	 * not send the bot token to a second host.
	 */
	async fetchAttachment(attachment: InboundAttachment): Promise<FetchedAttachment> {
		let response: Response;
		try {
			response = await this.fetchImpl(attachment.ref, { signal: AbortSignal.timeout(this.attachmentTimeoutMs) });
		} catch (error) {
			throw new Error(`could not reach the attachment host: ${String(error)}`);
		}

		if (!response.ok) {
			throw new Error(`attachment download failed with status ${response.status}`);
		}

		// Trust the declared size only as an early out; the real check is after read.
		const declared = Number(response.headers.get("content-length") ?? Number.NaN);
		if (Number.isFinite(declared) && declared > this.maxAttachmentBytes) {
			throw new Error(`attachment is ${declared} bytes, over the ${this.maxAttachmentBytes} byte limit`);
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.byteLength > this.maxAttachmentBytes) {
			throw new Error(`attachment is ${buffer.byteLength} bytes, over the ${this.maxAttachmentBytes} byte limit`);
		}

		// The declared type came from the sender and is only a hint; the response
		// header describes what was actually served.
		const header = response.headers.get("content-type");
		const served = header === null ? "" : (header.split(";")[0] ?? "").trim().toLowerCase();
		return { mediaType: served.length > 0 ? served : attachment.mediaType, data: buffer.toString("base64") };
	}

	/**
	 * Shows Discord's typing indicator while the agent works. Best-effort: the
	 * bridge swallows failures, and repeated hints for one channel are throttled
	 * locally so a busy turn cannot hammer the endpoint.
	 */
	async typing(conversationId: string): Promise<void> {
		if (this.handler === null) return;
		const now = this.now();
		const last = this.typingAt.get(conversationId);
		if (last !== undefined && now - last < this.typingMinIntervalMs) return;
		this.typingAt.set(conversationId, now);
		await this.rest.triggerTyping(conversationId);
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
