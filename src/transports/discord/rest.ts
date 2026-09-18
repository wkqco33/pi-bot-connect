/**
 * Thin Discord REST client.
 *
 * Only the four calls the bridge needs. `fetch` and the retry delay are
 * injected, so rate-limit and error handling are testable without a network.
 */

import { DISCORD_API_VERSION } from "./normalize.js";

export const DISCORD_API_BASE = `https://discord.com/api/v${DISCORD_API_VERSION}`;

/** Per-request deadline. Discord normally answers well within this. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Backoff for transient 5xx/network failures, in milliseconds. */
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 5_000;

export interface DiscordBotIdentity {
	readonly id: string;
	readonly username: string;
}

/**
 * The REST surface the transport depends on. Declared structurally so tests can
 * substitute a fake without casting.
 */
export interface DiscordApi {
	getBotIdentity(): Promise<DiscordBotIdentity>;
	resolveGatewayUrl(): Promise<string>;
	createMessage(channelId: string, content: string): Promise<{ id: string }>;
	editMessage(channelId: string, messageId: string, content: string): Promise<void>;
	triggerTyping(channelId: string): Promise<void>;
}

export interface DiscordRestOptions {
	readonly token: string;
	readonly apiBase?: string;
	readonly fetchImpl?: typeof fetch;
	readonly delayImpl?: (ms: number) => Promise<void>;
	readonly maxRateLimitRetries?: number;
	/** Aborts an individual HTTP request so a hung socket cannot block a turn. */
	readonly timeoutMs?: number;
}

interface RequestInitLike {
	readonly method: string;
	readonly body?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultDelay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DiscordRest implements DiscordApi {
	private readonly token: string;
	private readonly apiBase: string;
	private readonly fetchImpl: typeof fetch;
	private readonly delayImpl: (ms: number) => Promise<void>;
	private readonly maxRetries: number;
	private readonly timeoutMs: number;

	constructor(options: DiscordRestOptions) {
		this.token = options.token;
		this.apiBase = options.apiBase ?? DISCORD_API_BASE;
		this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
		this.delayImpl = options.delayImpl ?? defaultDelay;
		this.maxRetries = options.maxRateLimitRetries ?? 1;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	async getBotIdentity(): Promise<DiscordBotIdentity> {
		const body = await this.request("/users/@me", { method: "GET" });
		if (!isRecord(body) || typeof body.id !== "string") {
			throw new Error("Discord /users/@me did not return a bot id");
		}
		return { id: body.id, username: typeof body.username === "string" ? body.username : body.id };
	}

	async resolveGatewayUrl(): Promise<string> {
		const body = await this.request("/gateway/bot", { method: "GET" });
		if (!isRecord(body) || typeof body.url !== "string") {
			throw new Error("Discord /gateway/bot did not return a gateway url");
		}
		return body.url;
	}

	async createMessage(channelId: string, content: string): Promise<{ id: string }> {
		const body = await this.request(`/channels/${encodeURIComponent(channelId)}/messages`, {
			method: "POST",
			body: JSON.stringify({ content }),
		});
		if (!isRecord(body) || typeof body.id !== "string") {
			throw new Error("Discord did not return a message id");
		}
		return { id: body.id };
	}

	async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
		await this.request(
			`/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
			{ method: "PATCH", body: JSON.stringify({ content }) },
		);
	}

	/** Shows the "bot is typing" indicator, which Discord clears after ~10 seconds. */
	async triggerTyping(channelId: string): Promise<void> {
		await this.request(`/channels/${encodeURIComponent(channelId)}/typing`, { method: "POST" });
	}

	// --- internals -----------------------------------------------------------

	private async send(path: string, init: RequestInitLike): Promise<Response> {
		try {
			return await this.fetchImpl(`${this.apiBase}${path}`, {
				method: init.method,
				headers: {
					Authorization: `Bot ${this.token}`,
					"Content-Type": "application/json",
					// Discord rejects requests without a recognisable user agent.
					"User-Agent": "DiscordBot (https://github.com/, 0.0.0)",
				},
				signal: AbortSignal.timeout(this.timeoutMs),
				...(init.body === undefined ? {} : { body: init.body }),
			});
		} catch (error) {
			throw new Error(`Discord ${init.method} ${path} could not be sent: ${String(error)}`);
		}
	}

	private retryDelayMs(attempt: number): number {
		return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
	}

	private async request(path: string, init: RequestInitLike): Promise<unknown> {
		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			let response: Response;
			try {
				response = await this.send(path, init);
			} catch (error) {
				// Network-level failures are as transient as a 5xx; retry them too.
				lastError = error instanceof Error ? error : new Error(String(error));
				if (attempt < this.maxRetries) {
					await this.delayImpl(this.retryDelayMs(attempt));
					continue;
				}
				throw lastError;
			}

			if (response.status === 429) {
				lastError = new Error(`Discord ${init.method} ${path} was rate limited`);
				if (attempt < this.maxRetries) {
					await this.delayImpl(await this.readRetryAfter(response));
					continue;
				}
				throw lastError;
			}

			if (response.status >= 500) {
				lastError = new Error(await this.describeError(response, init.method, path));
				if (attempt < this.maxRetries) {
					await this.delayImpl(this.retryDelayMs(attempt));
					continue;
				}
				throw lastError;
			}

			if (!response.ok) {
				throw new Error(await this.describeError(response, init.method, path));
			}

			return await this.readJson(response, init.method, path);
		}

		throw lastError ?? new Error(`Discord ${init.method} ${path} failed`);
	}

	private async readJson(response: Response, method: string, path: string): Promise<unknown> {
		if (response.status === 204) return undefined;
		const body = await response.text().catch(() => "");
		if (body.length === 0) return undefined;
		try {
			return JSON.parse(body) as unknown;
		} catch (error) {
			throw new Error(`Discord returned a non-JSON body for ${method} ${path}: ${String(error)}`);
		}
	}

	private async readRetryAfter(response: Response): Promise<number> {
		const header = response.headers.get("retry-after");
		const fromHeader = header === null ? Number.NaN : Number(header);
		if (Number.isFinite(fromHeader) && fromHeader >= 0) return Math.min(fromHeader * 1000, 10_000);

		const body = await response.json().catch(() => null);
		const fromBody = isRecord(body) && typeof body.retry_after === "number" ? body.retry_after : Number.NaN;
		if (Number.isFinite(fromBody) && fromBody >= 0) return Math.min(fromBody * 1000, 10_000);
		return 1000;
	}

	private async describeError(response: Response, method: string, path: string): Promise<string> {
		const body = await response.json().catch(() => null);
		const detail = isRecord(body) && typeof body.message === "string" ? ` (${body.message})` : "";

		let hint = "";
		if (response.status === 401) hint = " The bot token is missing, expired or malformed.";
		else if (response.status === 403) hint = " The bot lacks a permission or scope for this action.";
		else if (response.status === 404) hint = " The channel does not exist, or the bot cannot see it.";

		return `Discord ${method} ${path} failed with status ${response.status}${detail}.${hint}`;
	}
}
