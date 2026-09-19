/**
 * Pure RoboClaw ChatMessage ↔ `Envelope` normalization.
 *
 * No network, no clock, no token: purely data transformation.
 */

import type { Envelope, InboundAttachment, OutboundMessage } from "../../core/types.js";

export const ROBO_CLAW_TRANSPORT_ID = "robo_claw";

export interface RoboClawChatMessage {
	readonly sender_id?: string | null;
	readonly content?: string | null;
	readonly timestamp?: number | string | bigint | null;
	readonly metadata?: Readonly<Record<string, string>> | null;
}

export type NormalizeSkipReason = "self" | "empty" | "not-a-message";

export type NormalizeResult =
	| { readonly kind: "envelope"; readonly envelope: Envelope }
	| { readonly kind: "skip"; readonly reason: NormalizeSkipReason };

export interface NormalizeOptions {
	/** Identifier used by the robot/agent itself to detect echoes. Defaults to "robot". */
	readonly selfSenderId?: string;
	/** Conversation ID for this stream session. Defaults to metadata['room_id'] or "default". */
	readonly conversationId?: string;
}

export interface NormalizeOutboundOptions {
	readonly senderId?: string;
	readonly now?: number;
}

function parseTimestamp(raw: number | string | bigint | null | undefined): number {
	if (typeof raw === "number") return raw;
	if (typeof raw === "string") {
		const parsed = Number(raw);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	if (typeof raw === "bigint") {
		return Number(raw);
	}
	return 0;
}

export function normalizeInbound(
	raw: unknown,
	options: NormalizeOptions = {},
): NormalizeResult {
	if (typeof raw !== "object" || raw === null) {
		return { kind: "skip", reason: "not-a-message" };
	}

	const msg = raw as RoboClawChatMessage;
	const senderId = (msg.sender_id ?? "user").trim();
	const selfId = options.selfSenderId ?? "robot";

	if (senderId === selfId || senderId === "robot") {
		return { kind: "skip", reason: "self" };
	}

	const content = (msg.content ?? "").trim();
	const metadata = msg.metadata ?? {};
	const fileId = metadata["file_id"];

	if (content.length === 0 && (!fileId || fileId.trim().length === 0)) {
		return { kind: "skip", reason: "empty" };
	}

	const attachments: InboundAttachment[] = [];
	if (fileId && fileId.trim().length > 0) {
		const mediaType = metadata["type"] || "application/octet-stream";
		const isImage = mediaType.startsWith("image/");
		attachments.push({
			kind: isImage ? "image" : "file",
			mediaType,
			ref: fileId.trim(),
			...(metadata["filename"] ? { name: metadata["filename"] } : {}),
		});
	}

	const conversationId =
		options.conversationId ?? metadata["room_id"] ?? "default";

	const envelope: Envelope = {
		transport: ROBO_CLAW_TRANSPORT_ID,
		conversationId,
		userId: senderId,
		timestamp: parseTimestamp(msg.timestamp),
		text: content,
		isDirect: true,
		addressed: true,
		...(attachments.length > 0 ? { attachments } : {}),
		raw,
	};

	return { kind: "envelope", envelope };
}

export function normalizeOutbound(
	message: OutboundMessage,
	options: NormalizeOutboundOptions = {},
): RoboClawChatMessage {
	return {
		sender_id: options.senderId ?? "robot",
		content: message.text,
		timestamp: options.now ?? Date.now(),
		metadata: {},
	};
}

export function extractAuthToken(
	raw: unknown,
	headers?: Readonly<Record<string, string | string[] | undefined>>,
): string | undefined {
	if (typeof raw === "object" && raw !== null) {
		const msg = raw as RoboClawChatMessage;
		const metadataToken = msg.metadata?.["auth_token"];
		if (metadataToken && metadataToken.trim().length > 0) {
			return metadataToken.trim();
		}
	}

	if (headers) {
		const peerToken = headers["x-robo-claw-peer-token"];
		if (typeof peerToken === "string" && peerToken.trim().length > 0) {
			return peerToken.trim();
		}
		if (Array.isArray(peerToken) && typeof peerToken[0] === "string" && peerToken[0].trim().length > 0) {
			return peerToken[0].trim();
		}
	}

	return undefined;
}

