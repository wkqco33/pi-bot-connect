import { describe, expect, it } from "vitest";
import { normalizeTelegramUpdate, stripTelegramCommandMention, type TelegramUpdate } from "./normalize.js";

const BOT = { botId: "999", botUsername: "piBot" };

function update(message: Record<string, unknown> = {}): TelegramUpdate {
	return {
		update_id: 100,
		message: {
			message_id: 5,
			date: 1_700_000_000,
			chat: { id: -100, type: "private" },
			from: { id: 42, is_bot: false, username: "alice" },
			text: "hello",
			...message,
		},
	};
}

describe("normalizeTelegramUpdate", () => {
	it("maps a private message to an Envelope", () => {
		const result = normalizeTelegramUpdate(update(), BOT);
		expect(result.kind).toBe("envelope");
		if (result.kind !== "envelope") return;
		expect(result.envelope).toMatchObject({
			transport: "telegram",
			conversationId: "-100",
			userId: "42",
			isDirect: true,
			addressed: true,
			text: "hello",
			timestamp: 1_700_000_000_000,
		});
	});

	it("treats a group message without a mention as unaddressed", () => {
		const result = normalizeTelegramUpdate(update({ chat: { id: -50, type: "supergroup" } }), BOT);
		expect(result.kind).toBe("envelope");
		if (result.kind !== "envelope") return;
		expect(result.envelope.isDirect).toBe(false);
		expect(result.envelope.addressed).toBe(false);
	});

	it("strips an @bot mention and marks the message addressed", () => {
		const result = normalizeTelegramUpdate(
			update({ text: "@piBot run the tests", chat: { id: -50, type: "group" } }),
			BOT,
		);
		expect(result.kind).toBe("envelope");
		if (result.kind !== "envelope") return;
		expect(result.envelope.addressed).toBe(true);
		expect(result.envelope.text).toBe("run the tests");
	});

	it("treats a reply to the bot as addressed", () => {
		const result = normalizeTelegramUpdate(
			update({
				chat: { id: -50, type: "group" },
				reply_to_message: { message_id: 4, from: { id: 999, is_bot: true } },
			}),
			BOT,
		);
		expect(result.kind).toBe("envelope");
		if (result.kind !== "envelope") return;
		expect(result.envelope.addressed).toBe(true);
	});

	it("normalizes a group command that targets the bot", () => {
		const result = normalizeTelegramUpdate(
			update({ text: "/status@piBot", chat: { id: -50, type: "group" } }),
			BOT,
		);
		expect(result.kind).toBe("envelope");
		if (result.kind !== "envelope") return;
		expect(result.envelope.addressed).toBe(true);
		expect(result.envelope.text).toBe("/status");
	});

	it("ignores a command that targets another bot", () => {
		const result = normalizeTelegramUpdate(
			update({ text: "/status@otherBot", chat: { id: -50, type: "group" } }),
			BOT,
		);
		expect(result.kind).toBe("envelope");
		if (result.kind !== "envelope") return;
		expect(result.envelope.addressed).toBe(false);
	});

	it("skips messages from bots", () => {
		const result = normalizeTelegramUpdate(update({ from: { id: 7, is_bot: true } }), BOT);
		expect(result).toEqual({ kind: "skip", reason: "bot-author" });
	});

	it("skips the bot's own messages", () => {
		const result = normalizeTelegramUpdate(update({ from: { id: 999, is_bot: true } }), BOT);
		expect(result).toEqual({ kind: "skip", reason: "self" });
	});

	it("skips edits and other non-message updates", () => {
		const result = normalizeTelegramUpdate({ update_id: 1, edited_message: { message_id: 5 } }, BOT);
		expect(result).toEqual({ kind: "skip", reason: "not-a-message" });
	});

	it("carries a photo as an image attachment", () => {
		const result = normalizeTelegramUpdate(
			update({
				text: undefined,
				caption: "look",
				photo: [
					{ file_id: "small", file_unique_id: "u1", width: 10, height: 10, file_size: 100 },
					{ file_id: "large", file_unique_id: "u2", width: 100, height: 100, file_size: 500 },
				],
			}),
			BOT,
		);
		expect(result.kind).toBe("envelope");
		if (result.kind !== "envelope") return;
		// The largest rendition is the one worth forwarding.
		expect(result.envelope.attachments).toEqual([
			{ kind: "image", mediaType: "image/jpeg", ref: "large", sizeBytes: 500 },
		]);
		expect(result.envelope.text).toBe("look");
	});

	it("carries a document with its declared media type", () => {
		const result = normalizeTelegramUpdate(
			update({ text: undefined, document: { file_id: "doc1", mime_type: "application/pdf", file_size: 12 } }),
			BOT,
		);
		expect(result.kind).toBe("envelope");
		if (result.kind !== "envelope") return;
		expect(result.envelope.attachments?.[0]).toMatchObject({ kind: "file", mediaType: "application/pdf", ref: "doc1" });
	});

	it("keeps the topic thread id", () => {
		const result = normalizeTelegramUpdate(
			update({ chat: { id: -50, type: "supergroup" }, message_thread_id: 77 }),
			BOT,
		);
		expect(result.kind).toBe("envelope");
		if (result.kind !== "envelope") return;
		expect(result.envelope.threadId).toBe("77");
	});
});

describe("stripTelegramCommandMention", () => {
	it("rewrites /cmd@bot to /cmd when the mention is ours", () => {
		expect(stripTelegramCommandMention("/status@piBot", "piBot")).toBe("/status");
	});

	it("leaves a foreign command target intact", () => {
		expect(stripTelegramCommandMention("/status@otherBot", "piBot")).toBe("/status@otherBot");
	});

	it("leaves an unmentioned command intact", () => {
		expect(stripTelegramCommandMention("/status", "piBot")).toBe("/status");
	});
});
