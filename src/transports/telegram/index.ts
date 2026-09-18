/**
 * Telegram transport.
 *
 * Composition: single-instance lock → getMe identity check → long-poll loop →
 * Envelope. Telegram allows exactly one `getUpdates` consumer per bot token
 * (a second one gets 409), so the lock is mandatory, exactly as for Discord.
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
import { normalizeTelegramUpdate, TELEGRAM_TRANSPORT_ID, type TelegramUpdate } from "./normalize.js";
import { TelegramRest, type TelegramApi } from "./rest.js";

/** Telegram's bot upload/download ceiling. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Telegram expires the typing action after ~5 seconds; throttled below that. */
export const DEFAULT_TYPING_MIN_INTERVAL_MS = 4_000;

/** Telegram Bot API limits, as documented. */
export const TELEGRAM_CAPABILITIES: TransportCapabilities = {
	threads: true,
	edit: true,
	reactions: false,
	attachments: true,
	maxMessageLength: 4096,
	// Telegram measures message length in UTF-8 bytes.
	lengthUnit: "bytes",
	markdown: "html",
	channels: true,
};

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000] as const;

export interface TelegramTransportOptions {
	readonly token: string;
	readonly lockDir: string;
	readonly logger: Logger;
	readonly rest?: TelegramApi;
	readonly fetchImpl?: typeof fetch;
	readonly delayImpl?: (ms: number) => Promise<void>;
	readonly lockStaleMs?: number;
	/** Long-poll timeout, in seconds. */
	readonly pollTimeoutSeconds?: number;
	readonly maxAttachmentBytes?: number;
	readonly attachmentTimeoutMs?: number;
	readonly typingMinIntervalMs?: number;
	readonly now?: () => number;
}

export class TelegramTransport implements Transport {
	readonly id = TELEGRAM_TRANSPORT_ID;
	readonly capabilities = TELEGRAM_CAPABILITIES;

	private readonly options: TelegramTransportOptions;
	private readonly rest: TelegramApi;
	private readonly fetchImpl: typeof fetch;
	private readonly delayImpl: (ms: number) => Promise<void>;
	private readonly pollTimeoutSeconds: number;
	private readonly maxAttachmentBytes: number;
	private readonly attachmentTimeoutMs: number;
	private readonly typingMinIntervalMs: number;
	private readonly now: () => number;
	private readonly typingAt = new Map<string, number>();

	private handler: EnvelopeHandler | null = null;
	private lock: LockHandle | null = null;
	private botId: string | null = null;
	private botUsername: string | null = null;
	private lastSkipReason: string | null = null;
	private received = 0;
	private stopped = false;
	private error: string | null = null;
	private offset: number | undefined;
	private loop: Promise<void> | null = null;
	/** Aborts an in-flight long poll on stop so shutdown does not wait it out. */
	private abort: AbortController | null = null;
	private queue: Promise<void> = Promise.resolve();

	constructor(options: TelegramTransportOptions) {
		this.options = options;
		this.rest = options.rest ?? new TelegramRest({ token: options.token });
		this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
		this.delayImpl = options.delayImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 25;
		this.maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
		this.attachmentTimeoutMs = options.attachmentTimeoutMs ?? 20_000;
		this.typingMinIntervalMs = options.typingMinIntervalMs ?? DEFAULT_TYPING_MIN_INTERVAL_MS;
		this.now = options.now ?? Date.now;
	}

	async start(handler: EnvelopeHandler): Promise<void> {
		if (this.handler !== null || this.loop !== null) throw new Error("Telegram transport is already started");

		// Validates the token and gives us the bot id, which keeps the lock path
		// from depending on the token itself.
		const me = await this.rest.getMe();
		if (me.id.length === 0) throw new Error("Telegram returned an empty bot id");
		this.botId = me.id;
		this.botUsername = me.username;

		const acquired = await acquireLock({
			path: join(this.options.lockDir, `telegram-${me.id}.lock`),
			logger: this.options.logger,
			...(this.options.lockStaleMs === undefined ? {} : { staleMs: this.options.lockStaleMs }),
		});
		if (!acquired.ok) {
			throw new Error(
				`another pi process already polls this Telegram bot (${describeHolder(acquired.holder)}); Telegram allows only one getUpdates consumer`,
			);
		}
		this.lock = acquired.lock;
		this.handler = handler;
		this.stopped = false;
		this.error = null;
		this.abort = new AbortController();

		try {
			// One non-blocking poll both validates connectivity and drains the
			// backlog before the long-poll loop takes over.
			const backlog = await this.rest.getUpdates(undefined, 0);
			this.consume(backlog);
			this.options.logger.info("telegram transport ready", { botId: me.id, username: me.username });
		} catch (error) {
			this.handler = null;
			this.abort = null;
			await this.lock.release();
			this.lock = null;
			throw error;
		}

		this.loop = this.runLoop();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.handler = null;
		this.abort?.abort();
		if (this.loop !== null) {
			await this.loop;
			this.loop = null;
		}
		await this.queue;
		await this.lock?.release();
		this.lock = null;
		this.abort = null;
	}

	async send(message: OutboundMessage): Promise<SendReceipt> {
		if (this.handler === null) throw new Error("Telegram transport is not started");

		if (message.editKey !== undefined) {
			await this.rest.editMessageText(message.conversationId, message.editKey, message.text);
			return { messageId: message.editKey, editKey: message.editKey };
		}

		const created = await this.rest.sendMessage(message.conversationId, message.text, message.threadId);
		return { messageId: created.messageId, editKey: created.messageId };
	}

	/**
	 * Downloads an attachment by `file_id`. Telegram serves files from a URL that
	 * embeds the token, so this never sends the token to a third host.
	 */
	async fetchAttachment(attachment: InboundAttachment): Promise<FetchedAttachment> {
		if (attachment.sizeBytes !== undefined && attachment.sizeBytes > this.maxAttachmentBytes) {
			throw new Error(`attachment is ${attachment.sizeBytes} bytes, over the ${this.maxAttachmentBytes} byte limit`);
		}

		const file = await this.rest.getFile(attachment.ref);
		const url = this.downloadUrl(file.file_path);

		let response: Response;
		try {
			response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.attachmentTimeoutMs) });
		} catch (error) {
			throw new Error(`could not reach the attachment host: ${String(error)}`);
		}
		if (!response.ok) throw new Error(`attachment download failed with status ${response.status}`);

		const declared = Number(response.headers.get("content-length") ?? Number.NaN);
		if (Number.isFinite(declared) && declared > this.maxAttachmentBytes) {
			throw new Error(`attachment is ${declared} bytes, over the ${this.maxAttachmentBytes} byte limit`);
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.byteLength > this.maxAttachmentBytes) {
			throw new Error(`attachment is ${buffer.byteLength} bytes, over the ${this.maxAttachmentBytes} byte limit`);
		}

		const header = response.headers.get("content-type");
		const served = header === null ? "" : (header.split(";")[0] ?? "").trim().toLowerCase();
		return { mediaType: served.length > 0 ? served : attachment.mediaType, data: buffer.toString("base64") };
	}

	async typing(conversationId: string): Promise<void> {
		if (this.handler === null) return;
		const now = this.now();
		const last = this.typingAt.get(conversationId);
		if (last !== undefined && now - last < this.typingMinIntervalMs) return;
		this.typingAt.set(conversationId, now);
		await this.rest.sendChatAction(conversationId, "typing");
	}

	diagnose(): string {
		const parts: string[] = [];
		if (this.botId === null) parts.push("not identified");
		else parts.push(`bot ${this.botUsername ?? "?"} (${this.botId})`);
		parts.push(this.error !== null ? `error: ${this.error}` : this.stopped ? "stopped" : "polling");
		parts.push(this.lock === null ? "lock not held" : "lock held");
		parts.push(`received ${this.received} message(s)`);
		if (this.lastSkipReason !== null) parts.push(`last skip: ${this.lastSkipReason}`);
		return parts.join(", ");
	}

	// --- internals -----------------------------------------------------------

	/** Only used when the transport creates its own REST client. */
	private downloadUrl(filePath: string): string {
		const withDownload = this.rest as Partial<{ downloadUrl(path: string): string }>;
		if (typeof withDownload.downloadUrl === "function") return withDownload.downloadUrl(filePath);
		return `https://api.telegram.org/file/bot${this.options.token}/${filePath}`;
	}

	private async runLoop(): Promise<void> {
		const backoff = DEFAULT_BACKOFF_MS;
		let attempt = 0;

		while (!this.stopped) {
			try {
				const updates = await this.rest.getUpdates(this.offset, this.pollTimeoutSeconds, this.abort?.signal);
				attempt = 0;
				this.consume(updates);
			} catch (error) {
				if (this.stopped) break;
				const message = error instanceof Error ? error.message : String(error);
				this.error = message;
				this.options.logger.warn("telegram poll failed", { error: message });
				const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 20_000;
				attempt++;
				await this.delayImpl(delay);
			}
		}
	}

	private consume(updates: readonly TelegramUpdate[]): void {
		for (const update of updates) {
			if (typeof update.update_id === "number") this.offset = update.update_id + 1;
			this.onUpdate(update);
		}
	}

	private onUpdate(update: TelegramUpdate): void {
		const botId = this.botId;
		if (botId === null) return;

		const result = normalizeTelegramUpdate(update, {
			botId,
			...(this.botUsername === null ? {} : { botUsername: this.botUsername }),
		});
		if (result.kind === "skip") {
			this.lastSkipReason = result.reason;
			this.options.logger.debug("telegram update skipped", { reason: result.reason });
			return;
		}

		this.received++;
		this.error = null;
		const envelope: Envelope = result.envelope;
		this.queue = this.queue.then(() => this.deliver(envelope));
	}

	private async deliver(envelope: Envelope): Promise<void> {
		const handler = this.handler;
		if (handler === null) return;
		try {
			await handler(envelope);
		} catch (error) {
			this.options.logger.error("telegram message handler failed", { error: String(error) });
		}
	}
}
