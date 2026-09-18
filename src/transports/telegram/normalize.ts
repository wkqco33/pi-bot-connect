/**
 * Pure Telegram update → `Envelope` normalization.
 *
 * No network, no clock, no token: fixture-driven tests cover every branch, which
 * is where "why did the bot reply to that group?" bugs actually live.
 *
 * Telegram has no threads in the Discord sense: a forum topic carries a
 * `message_thread_id` that must be echoed when replying, so it is exposed as
 * `threadId`.
 */

import { escapeRegExp } from "../../core/text.js";
import type { Envelope, InboundAttachment } from "../../core/types.js";

export const TELEGRAM_TRANSPORT_ID = "telegram";

export interface TelegramBotIdentity {
	readonly id: string;
	readonly username: string;
}

export interface TelegramUser {
	readonly id: number | string;
	readonly is_bot?: boolean;
	readonly username?: string;
}

export interface TelegramChat {
	readonly id: number | string;
	readonly type?: string;
}

export interface TelegramPhotoSize {
	readonly file_id?: string;
	readonly file_size?: number;
	readonly width?: number;
	readonly height?: number;
}

export interface TelegramMessage {
	readonly message_id?: number;
	readonly date?: number;
	readonly chat?: TelegramChat;
	readonly from?: TelegramUser;
	readonly text?: string;
	readonly caption?: string;
	readonly message_thread_id?: number;
	readonly reply_to_message?: { readonly from?: TelegramUser };
	readonly photo?: readonly TelegramPhotoSize[];
	readonly document?: { readonly file_id?: string; readonly mime_type?: string; readonly file_size?: number; readonly file_name?: string };
}

export interface TelegramUpdate {
	readonly update_id?: number;
	readonly message?: TelegramMessage;
	readonly edited_message?: unknown;
	readonly channel_post?: unknown;
}

export type TelegramSkipReason = "not-a-message" | "self" | "bot-author" | "no-sender";

export type TelegramNormalizeResult =
	| { readonly kind: "envelope"; readonly envelope: Envelope }
	| { readonly kind: "skip"; readonly reason: TelegramSkipReason };

export interface TelegramNormalizeOptions {
	readonly botId: string;
	readonly botUsername?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `/status@piBot` -> `/status` when the mention is ours. Foreign targets stay intact. */
export function stripTelegramCommandMention(text: string, botUsername: string | undefined): string {
	if (!botUsername) return text;
	const pattern = new RegExp(`^(/[^@\\s]+)@${escapeRegExp(botUsername)}\\b`, "i");
	return text.replace(pattern, "$1");
}

function containsMention(text: string, botUsername: string | undefined): boolean {
	if (!botUsername) return false;
	return new RegExp(`(^|[^\\w])@${escapeRegExp(botUsername)}\\b`, "i").test(text);
}

function stripMention(text: string, botUsername: string | undefined): string {
	if (!botUsername) return text.trim();
	const pattern = new RegExp(`(^|[^\\w])@${escapeRegExp(botUsername)}\\b`, "gi");
	return text.replace(pattern, "$1").replace(/[ \t]{2,}/g, " ").trim();
}

function commandTargetsBot(text: string, botUsername: string | undefined): boolean {
	const match = /^\/([^@\s]+)(?:@(\S+))?/.exec(text.trim());
	if (!match) return false;
	const target = match[2];
	if (target === undefined) return true;
	if (!botUsername) return false;
	return target.toLowerCase() === botUsername.toLowerCase();
}

function toAttachments(message: TelegramMessage): InboundAttachment[] {
	const attachments: InboundAttachment[] = [];

	const photo = message.photo;
	if (Array.isArray(photo) && photo.length > 0) {
		// Renditions are ordered smallest-first; the last is the largest.
		const largest = photo[photo.length - 1];
		if (largest && typeof largest.file_id === "string") {
			attachments.push({
				kind: "image",
				mediaType: "image/jpeg",
				ref: largest.file_id,
				...(typeof largest.file_size === "number" ? { sizeBytes: largest.file_size } : {}),
			});
		}
	}

	const document = message.document;
	if (isRecord(document) && typeof document.file_id === "string") {
		const mediaType = typeof document.mime_type === "string" ? document.mime_type : "application/octet-stream";
		attachments.push({
			kind: mediaType.startsWith("image/") ? "image" : "file",
			mediaType,
			ref: document.file_id,
			...(typeof document.file_name === "string" ? { name: document.file_name } : {}),
			...(typeof document.file_size === "number" ? { sizeBytes: document.file_size } : {}),
		});
	}

	return attachments;
}

export function normalizeTelegramUpdate(
	update: TelegramUpdate,
	options: TelegramNormalizeOptions,
): TelegramNormalizeResult {
	const message = update.message;
	if (!isRecord(message)) return { kind: "skip", reason: "not-a-message" };

	const sender = message.from;
	if (!isRecord(sender)) return { kind: "skip", reason: "no-sender" };
	if (typeof sender.id !== "number" && typeof sender.id !== "string") {
		return { kind: "skip", reason: "no-sender" };
	}

	// Self and bot messages are dropped: forwarding them would let two bots (or
	// the bot and itself) talk in a loop.
	if (String(sender.id) === options.botId) return { kind: "skip", reason: "self" };
	if (sender.is_bot === true) return { kind: "skip", reason: "bot-author" };

	const chat = message.chat;
	if (!isRecord(chat) || (typeof chat.id !== "number" && typeof chat.id !== "string")) {
		return { kind: "skip", reason: "not-a-message" };
	}

	const isDirect = chat.type === "private";
	const rawText = typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : "";
	const normalizedCommand = stripTelegramCommandMention(rawText, options.botUsername);
	const mentioned = containsMention(rawText, options.botUsername);
	const replyFrom = update.message?.reply_to_message?.from;
	const repliesToBot = replyFrom !== undefined && String(replyFrom.id) === options.botId;
	const addressed = isDirect || mentioned || repliesToBot || commandTargetsBot(rawText, options.botUsername);

	const text = mentioned ? stripMention(normalizedCommand, options.botUsername) : normalizedCommand.trim();
	const attachments = toAttachments(message as TelegramMessage);
	const timestamp = typeof message.date === "number" ? message.date * 1000 : 0;

	const envelope: Envelope = {
		transport: TELEGRAM_TRANSPORT_ID,
		conversationId: String(chat.id),
		userId: String(sender.id),
		isDirect,
		addressed,
		timestamp,
		text,
		...(typeof message.message_thread_id === "number" ? { threadId: String(message.message_thread_id) } : {}),
		...(attachments.length > 0 ? { attachments } : {}),
		raw: update,
	};

	return { kind: "envelope", envelope };
}
