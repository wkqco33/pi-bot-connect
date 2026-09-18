/**
 * Pure Discord payload → `Envelope` normalization.
 *
 * No network, no clock, no token: fixture-driven tests cover every branch here,
 * which is where the "why did the bot reply to that?" bugs actually live.
 */

import { escapeRegExp } from "../../core/text.js";
import type { Envelope, InboundAttachment } from "../../core/types.js";

export const DISCORD_TRANSPORT_ID = "discord";
export const DISCORD_API_VERSION = "10";

/** Gateway intents. MESSAGE_CONTENT is privileged and must be enabled in the app. */
export const DISCORD_INTENTS = {
	GUILD_MESSAGES: 1 << 9,
	DIRECT_MESSAGES: 1 << 12,
	MESSAGE_CONTENT: 1 << 15,
} as const;

export const DISCORD_DEFAULT_INTENTS =
	DISCORD_INTENTS.GUILD_MESSAGES | DISCORD_INTENTS.DIRECT_MESSAGES | DISCORD_INTENTS.MESSAGE_CONTENT;

/** 0 = DEFAULT, 19 = REPLY. Everything else is a system/command/interaction message. */
const ACCEPTED_MESSAGE_TYPES = new Set([0, 19]);

export type NormalizeSkipReason = "not-a-message" | "self" | "bot-author" | "unsupported-type";

export type NormalizeResult =
	| { readonly kind: "envelope"; readonly envelope: Envelope }
	| { readonly kind: "skip"; readonly reason: NormalizeSkipReason };

export interface NormalizeOptions {
	/** The bot's own user id, used to drop self-messages and strip mentions. */
	readonly botId: string;
}

export interface StripMentionsResult {
	readonly text: string;
	readonly mentioned: boolean;
}

/**
 * Removes `<@id>` / `<@!id>` tokens. Runs of spaces left behind are collapsed,
 * but newlines survive: remote users legitimately send multi-line prompts.
 */
export function stripBotMentions(content: string, botId: string): StripMentionsResult {
	const pattern = new RegExp(`<@!?${escapeRegExp(botId)}>`, "g");
	const mentioned = pattern.test(content);
	pattern.lastIndex = 0;
	if (!mentioned) return { text: content.trim(), mentioned: false };
	const text = content
		.replace(pattern, "")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
	return { text, mentioned: true };
}

function toAttachments(raw: unknown): InboundAttachment[] {
	if (!Array.isArray(raw)) return [];
	const attachments: InboundAttachment[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const mediaType = typeof record.content_type === "string" ? record.content_type : "application/octet-stream";
		const ref =
			typeof record.url === "string" ? record.url : typeof record.id === "string" ? record.id : undefined;
		if (ref === undefined) continue;
		attachments.push({
			kind: mediaType.startsWith("image/") ? "image" : "file",
			mediaType,
			ref,
			...(typeof record.filename === "string" ? { name: record.filename } : {}),
			...(typeof record.size === "number" ? { sizeBytes: record.size } : {}),
		});
	}
	return attachments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when the message replies to one of the bot's own messages. Discord only
 * includes `referenced_message` when it can resolve it, so this is best-effort:
 * a missing reference means "not addressed", never a crash.
 */
function repliesToBot(payload: Record<string, unknown>, botId: string): boolean {
	const referenced = payload.referenced_message;
	if (!isRecord(referenced)) return false;
	const author = referenced.author;
	return isRecord(author) && author.id === botId;
}

export function normalizeDiscordMessage(payload: unknown, options: NormalizeOptions): NormalizeResult {
	if (!isRecord(payload)) return { kind: "skip", reason: "not-a-message" };

	const channelId = payload.channel_id;
	const author = payload.author;
	if (typeof payload.id !== "string" || typeof channelId !== "string" || !isRecord(author)) {
		return { kind: "skip", reason: "not-a-message" };
	}

	const authorId = author.id;
	if (typeof authorId !== "string") return { kind: "skip", reason: "not-a-message" };

	// Self and bot messages are dropped: forwarding them would let two bots
	// (or the bot and itself) talk in a loop.
	if (authorId === options.botId) return { kind: "skip", reason: "self" };
	if (author.bot === true || typeof payload.webhook_id === "string") {
		return { kind: "skip", reason: "bot-author" };
	}

	const type = typeof payload.type === "number" ? payload.type : 0;
	if (!ACCEPTED_MESSAGE_TYPES.has(type)) return { kind: "skip", reason: "unsupported-type" };

	const content = typeof payload.content === "string" ? payload.content : "";
	const stripped = stripBotMentions(content, options.botId);

	const guildId = typeof payload.guild_id === "string" ? payload.guild_id : undefined;
	const isDirect = guildId === undefined;
	const parsedTimestamp = typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : Number.NaN;
	const attachments = toAttachments(payload.attachments);

	const envelope: Envelope = {
		transport: DISCORD_TRANSPORT_ID,
		// In a thread, channel_id is the thread's own id, so threads are isolated
		// conversations for free.
		conversationId: channelId,
		userId: authorId,
		isDirect,
		addressed: isDirect || stripped.mentioned || repliesToBot(payload, options.botId),
		timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0,
		text: stripped.text,
		...(attachments.length > 0 ? { attachments } : {}),
		raw: payload,
	};

	return { kind: "envelope", envelope };
}
