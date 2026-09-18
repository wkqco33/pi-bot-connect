/**
 * Envelope transcript codec: record/replay for regression tests.
 *
 * A captured messenger session is the most faithful regression fixture there is,
 * but a raw capture carries prompt text and platform payloads. Recording here
 * redacts secrets and drops `raw`, so a transcript can be committed and replayed
 * through the real bridge without a bot token.
 *
 * The file is untrusted input on replay: malformed lines are dropped with a
 * warning rather than throwing.
 */

import { redactSecrets } from "./redact.js";
import type { Envelope, InboundAttachment } from "./types.js";

export const TRANSCRIPT_VERSION = 1;

export interface ParseTranscriptResult {
	readonly envelopes: Envelope[];
	readonly warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A sanitized view of an envelope: redacted text, no platform payload. */
function toRecord(envelope: Envelope): Record<string, unknown> {
	return {
		transport: envelope.transport,
		conversationId: envelope.conversationId,
		userId: envelope.userId,
		...(envelope.threadId === undefined ? {} : { threadId: envelope.threadId }),
		timestamp: envelope.timestamp,
		text: redactSecrets(envelope.text),
		isDirect: envelope.isDirect,
		...(envelope.addressed === undefined ? {} : { addressed: envelope.addressed }),
		...(envelope.attachments === undefined ? {} : { attachments: envelope.attachments }),
	};
}

export function serializeTranscript(envelopes: readonly Envelope[]): string {
	const lines = [JSON.stringify({ version: TRANSCRIPT_VERSION })];
	for (const envelope of envelopes) lines.push(JSON.stringify(toRecord(envelope)));
	return `${lines.join("\n")}\n`;
}

function parseAttachments(raw: unknown): InboundAttachment[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const attachments: InboundAttachment[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		if (typeof entry.mediaType !== "string" || typeof entry.ref !== "string") continue;
		attachments.push({
			kind: entry.kind === "file" ? "file" : "image",
			mediaType: entry.mediaType,
			ref: entry.ref,
			...(typeof entry.name === "string" ? { name: entry.name } : {}),
			...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
		});
	}
	return attachments.length > 0 ? attachments : undefined;
}

function parseEnvelope(raw: unknown): Envelope | null {
	if (!isRecord(raw)) return null;
	if (
		typeof raw.transport !== "string" ||
		typeof raw.conversationId !== "string" ||
		typeof raw.userId !== "string" ||
		typeof raw.text !== "string" ||
		typeof raw.isDirect !== "boolean"
	) {
		return null;
	}
	const attachments = parseAttachments(raw.attachments);
	return {
		transport: raw.transport,
		conversationId: raw.conversationId,
		userId: raw.userId,
		...(typeof raw.threadId === "string" ? { threadId: raw.threadId } : {}),
		timestamp: typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp) ? raw.timestamp : 0,
		text: raw.text,
		isDirect: raw.isDirect,
		...(typeof raw.addressed === "boolean" ? { addressed: raw.addressed } : {}),
		...(attachments === undefined ? {} : { attachments }),
	};
}

export function parseTranscript(text: string): ParseTranscriptResult {
	const warnings: string[] = [];
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length === 0) return { envelopes: [], warnings };

	let start = 0;
	const header = lines[0];
	if (header !== undefined && header.includes("\"version\"")) {
		try {
			const parsed = JSON.parse(header) as unknown;
			const version = isRecord(parsed) && typeof parsed.version === "number" ? parsed.version : TRANSCRIPT_VERSION;
			if (version !== TRANSCRIPT_VERSION) {
				warnings.push(`transcript: unsupported version ${version}, ignoring the file`);
				return { envelopes: [], warnings };
			}
		} catch {
			warnings.push("transcript: unreadable header, ignoring the file");
			return { envelopes: [], warnings };
		}
		start = 1;
	}

	const envelopes: Envelope[] = [];
	for (let index = start; index < lines.length; index++) {
		const line = lines[index] as string;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			warnings.push(`transcript line ${index + 1}: not valid JSON, ignored`);
			continue;
		}
		const envelope = parseEnvelope(parsed);
		if (envelope === null) {
			warnings.push(`transcript line ${index + 1}: malformed envelope, ignored`);
			continue;
		}
		envelopes.push(envelope);
	}

	return { envelopes, warnings };
}
