/**
 * Thin Telegram Bot API client.
 *
 * Only the calls the bridge needs. `fetch` and the retry delay are injected, so
 * rate-limit and error handling are testable without a network, mirroring the
 * Discord REST client.
 */

import type { TelegramBotIdentity, TelegramUpdate } from "./normalize.js";

export const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Per-request deadline. Long polls need a larger one computed from `timeout`. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 5_000;

export interface TelegramApi {
	getMe(): Promise<TelegramBotIdentity>;
	/** `offset` acknowledges everything below it. `timeoutSeconds` drives long polling. */
	getUpdates(offset: number | undefined, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
	sendMessage(chatId: string, text: string, threadId?: string): Promise<{ messageId: string }>;
	editMessageText(chatId: string, messageId: string, text: string): Promise<void>;
	sendChatAction(chatId: string, action: string): Promise<void>;
	getFile(fileId: string): Promise<{ file_path: string }>;
}

export interface TelegramRestOptions {
	readonly token: string;
	readonly apiBase?: string;
	readonly fetchImpl?: typeof fetch;
	readonly delayImpl?: (ms: number) => Promise<void>;
	readonly maxRetries?: number;
	readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultDelay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TelegramRest implements TelegramApi {
	private readonly token: string;
	private readonly apiBase: string;
	private readonly fetchImpl: typeof fetch;
	private readonly delayImpl: (ms: number) => Promise<void>;
	private readonly maxRetries: number;
	private readonly timeoutMs: number;

	constructor(options: TelegramRestOptions) {
		this.token = options.token;
		this.apiBase = options.apiBase ?? TELEGRAM_API_BASE;
		this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
		this.delayImpl = options.delayImpl ?? defaultDelay;
		this.maxRetries = options.maxRetries ?? 1;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	async getMe(): Promise<TelegramBotIdentity> {
		const result = await this.request("getMe", {});
		if (!isRecord(result) || (typeof result.id !== "number" && typeof result.id !== "string")) {
			throw new Error("Telegram getMe did not return a bot id");
		}
		return { id: String(result.id), username: typeof result.username === "string" ? result.username : String(result.id) };
	}

	async getUpdates(offset: number | undefined, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
		// The HTTP deadline must outlast the long poll, or every idle poll aborts.
		const requestTimeoutMs = (timeoutSeconds + 10) * 1000;
		const result = await this.request(
			"getUpdates",
			{
				...(offset === undefined ? {} : { offset }),
				timeout: timeoutSeconds,
				allowed_updates: ["message"],
			},
			{ timeoutMs: requestTimeoutMs, ...(signal === undefined ? {} : { signal }) },
		);
		return Array.isArray(result) ? (result as TelegramUpdate[]) : [];
	}

	async sendMessage(chatId: string, text: string, threadId?: string): Promise<{ messageId: string }> {
		const result = await this.request("sendMessage", {
			chat_id: chatId,
			text,
			// The bridge renders CommonMark to HTML; without this Telegram shows the tags.
			parse_mode: "HTML",
			...(threadId === undefined ? {} : { message_thread_id: Number(threadId) }),
		});
		if (!isRecord(result) || (typeof result.message_id !== "number" && typeof result.message_id !== "string")) {
			throw new Error("Telegram sendMessage did not return a message id");
		}
		return { messageId: String(result.message_id) };
	}

	async editMessageText(chatId: string, messageId: string, text: string): Promise<void> {
		await this.request("editMessageText", { chat_id: chatId, message_id: Number(messageId), text, parse_mode: "HTML" });
	}

	async sendChatAction(chatId: string, action: string): Promise<void> {
		await this.request("sendChatAction", { chat_id: chatId, action });
	}

	async getFile(fileId: string): Promise<{ file_path: string }> {
		const result = await this.request("getFile", { file_id: fileId });
		if (!isRecord(result) || typeof result.file_path !== "string") {
			throw new Error("Telegram getFile did not return a file path");
		}
		return { file_path: result.file_path };
	}

	/** Absolute download URL for a `file_path` from `getFile`. */
	downloadUrl(filePath: string): string {
		return `${this.apiBase}/file/bot${this.token}/${filePath}`;
	}

	// --- internals -----------------------------------------------------------

	private retryDelayMs(attempt: number): number {
		return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
	}

	private async request(
		method: string,
		params: Record<string, unknown>,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<unknown> {
		const url = `${this.apiBase}/bot${this.token}/${method}`;
		const timeoutMs = options.timeoutMs ?? this.timeoutMs;
		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			let response: Response;
			try {
				response = await this.fetchImpl(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(params),
					signal: options.signal ?? AbortSignal.timeout(timeoutMs),
				});
			} catch (error) {
				lastError = new Error(`Telegram ${method} could not be sent: ${String(error)}`);
				if (attempt < this.maxRetries) {
					await this.delayImpl(this.retryDelayMs(attempt));
					continue;
				}
				throw lastError;
			}

			if (response.status === 429) {
				lastError = new Error(`Telegram ${method} was rate limited`);
				if (attempt < this.maxRetries) {
					await this.delayImpl(await this.readRetryAfter(response));
					continue;
				}
				throw lastError;
			}

			if (response.status >= 500) {
				lastError = new Error(`Telegram ${method} failed with status ${response.status}`);
				if (attempt < this.maxRetries) {
					await this.delayImpl(this.retryDelayMs(attempt));
					continue;
				}
				throw lastError;
			}

			const body = await response.json().catch(() => null);
			if (!response.ok || !isRecord(body) || body.ok !== true) {
				const description = isRecord(body) && typeof body.description === "string" ? body.description : `status ${response.status}`;
				throw new Error(`Telegram ${method} failed: ${description}`);
			}
			return body.result;
		}

		throw lastError ?? new Error(`Telegram ${method} failed`);
	}

	private async readRetryAfter(response: Response): Promise<number> {
		const body = await response.json().catch(() => null);
		const fromBody =
			isRecord(body) && isRecord(body.parameters) && typeof body.parameters.retry_after === "number"
				? body.parameters.retry_after
				: Number.NaN;
		if (Number.isFinite(fromBody) && fromBody >= 0) return Math.min(fromBody * 1000, 10_000);
		return 1000;
	}
}
