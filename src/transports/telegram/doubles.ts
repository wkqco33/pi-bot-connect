/**
 * Shared test double for the Telegram transport.
 *
 * Not a product module: it lives in `src/` only so the transport tests and the
 * conformance kit use one implementation. Excluded from coverage.
 */

import type { TelegramBotIdentity, TelegramUpdate } from "./normalize.js";
import type { TelegramApi } from "./rest.js";

export class FakeTelegramRest implements TelegramApi {
	identity: TelegramBotIdentity = { id: "999", username: "piBot" };
	identityError: Error | null = null;
	sendError: Error | null = null;
	readonly sent: Array<{ chatId: string; text: string; threadId?: string }> = [];
	readonly edited: Array<{ chatId: string; messageId: string; text: string }> = [];
	readonly actions: string[] = [];
	readonly calls: Array<{ offset: number | undefined; timeout: number }> = [];
	readonly files = new Map<string, string>();

	private readonly queued: TelegramUpdate[][] = [];
	private readonly pending: Array<(updates: TelegramUpdate[]) => void> = [];

	getMe(): Promise<TelegramBotIdentity> {
		if (this.identityError !== null) return Promise.reject(this.identityError);
		return Promise.resolve(this.identity);
	}

	getUpdates(offset: number | undefined, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
		this.calls.push({ offset, timeout: timeoutSeconds });
		// A zero-timeout poll (the startup probe) must never block.
		if (timeoutSeconds === 0) return Promise.resolve(this.queued.shift() ?? []);
		const next = this.queued.shift();
		if (next !== undefined) return Promise.resolve(next);
		// Block like a real long poll until a batch arrives or the transport stops.
		return new Promise((resolve) => {
			this.pending.push(resolve);
			signal?.addEventListener("abort", () => resolve([]));
		});
	}

	/** Feed a batch to the pending long poll, or queue it for the next one. */
	emitUpdates(updates: TelegramUpdate[]): void {
		const resolver = this.pending.shift();
		if (resolver) resolver(updates);
		else this.queued.push(updates);
	}

	sendMessage(chatId: string, text: string, threadId?: string): Promise<{ messageId: string }> {
		if (this.sendError !== null) return Promise.reject(this.sendError);
		this.sent.push({ chatId, text, ...(threadId === undefined ? {} : { threadId }) });
		return Promise.resolve({ messageId: `tg-${this.sent.length}` });
	}

	editMessageText(chatId: string, messageId: string, text: string): Promise<void> {
		if (this.sendError !== null) return Promise.reject(this.sendError);
		this.edited.push({ chatId, messageId, text });
		return Promise.resolve();
	}

	sendChatAction(chatId: string, action: string): Promise<void> {
		this.actions.push(`${chatId}:${action}`);
		return Promise.resolve();
	}

	getFile(fileId: string): Promise<{ file_path: string }> {
		const path = this.files.get(fileId);
		if (path === undefined) return Promise.reject(new Error(`unknown file ${fileId}`));
		return Promise.resolve({ file_path: path });
	}
}
