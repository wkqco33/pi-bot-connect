import { describe, expect, it } from "vitest";
import {
	DISCORD_DEFAULT_INTENTS,
	DISCORD_INTENTS,
	normalizeDiscordMessage,
	stripBotMentions,
} from "./normalize.js";
import type { Envelope } from "../../core/types.js";

const BOT_ID = "999";
const OPTIONS = { botId: BOT_ID };

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "m1",
		channel_id: "chan-1",
		guild_id: "guild-1",
		content: "hello there",
		type: 0,
		author: { id: "user-1", username: "someone" },
		timestamp: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function envelopeOf(payload: unknown): Envelope {
	const result = normalizeDiscordMessage(payload, OPTIONS);
	if (result.kind !== "envelope") throw new Error(`expected an envelope, got skip:${result.reason}`);
	return result.envelope;
}

describe("normalizeDiscordMessage — addressing", () => {
	it("treats a reply to the bot as addressed in a guild channel", () => {
		const envelope = envelopeOf(
			message({
				content: "carry on",
				type: 19,
				message_reference: { message_id: "m0" },
				referenced_message: { id: "m0", author: { id: BOT_ID } },
			}),
		);
		expect(envelope.addressed).toBe(true);
	});

	it("does not treat a reply to another user as addressing the bot", () => {
		const envelope = envelopeOf(
			message({
				content: "carry on",
				type: 19,
				message_reference: { message_id: "m0" },
				referenced_message: { id: "m0", author: { id: "user-2" } },
			}),
		);
		expect(envelope.addressed).toBe(false);
	});

	it("does not treat a reply as addressed when the referenced author is missing", () => {
		const envelope = envelopeOf(
			message({ content: "carry on", type: 19, message_reference: { message_id: "m0" } }),
		);
		expect(envelope.addressed).toBe(false);
	});
});

describe("stripBotMentions", () => {
	it("reports no mention and trims when the bot is not mentioned", () => {
		expect(stripBotMentions("  fix the tests  ", BOT_ID)).toEqual({ text: "fix the tests", mentioned: false });
	});

	it("removes a modern mention and collapses the gap", () => {
		expect(stripBotMentions(`<@${BOT_ID}> fix the tests`, BOT_ID)).toEqual({
			text: "fix the tests",
			mentioned: true,
		});
	});

	it("removes a legacy nickname mention", () => {
		expect(stripBotMentions(`<@!${BOT_ID}> run it`, BOT_ID)).toEqual({ text: "run it", mentioned: true });
	});

	it("detects a mention that is not at the start", () => {
		expect(stripBotMentions(`I think <@${BOT_ID}> should look`, BOT_ID)).toEqual({
			text: "I think should look",
			mentioned: true,
		});
	});

	it("preserves newlines while collapsing horizontal space", () => {
		expect(stripBotMentions(`<@${BOT_ID}>  line one\nline two`, BOT_ID)).toEqual({
			text: "line one\nline two",
			mentioned: true,
		});
	});

	it("does not strip a different user's mention", () => {
		expect(stripBotMentions("<@123> hello", BOT_ID)).toEqual({ text: "<@123> hello", mentioned: false });
	});

	it("is stable across repeated calls", () => {
		const content = `<@${BOT_ID}> hello`;
		expect(stripBotMentions(content, BOT_ID).mentioned).toBe(true);
		expect(stripBotMentions(content, BOT_ID).mentioned).toBe(true);
	});
});

describe("DISCORD_DEFAULT_INTENTS", () => {
	it("requests direct messages, guild messages and message content", () => {
		expect(DISCORD_DEFAULT_INTENTS).toBe(
			DISCORD_INTENTS.GUILD_MESSAGES | DISCORD_INTENTS.DIRECT_MESSAGES | DISCORD_INTENTS.MESSAGE_CONTENT,
		);
		expect(DISCORD_DEFAULT_INTENTS).toBe(37376);
	});
});

describe("normalizeDiscordMessage — accepted messages", () => {
	it("maps a direct message and treats it as addressed", () => {
		const envelope = envelopeOf(message({ guild_id: undefined }));
		expect(envelope).toMatchObject({
			transport: "discord",
			conversationId: "chan-1",
			userId: "user-1",
			isDirect: true,
			addressed: true,
			text: "hello there",
		});
		expect(envelope.timestamp).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
	});

	it("does not treat an unmentioned guild message as addressed", () => {
		const envelope = envelopeOf(message());
		expect(envelope.isDirect).toBe(false);
		expect(envelope.addressed).toBe(false);
	});

	it("treats a guild message that mentions the bot as addressed and strips the mention", () => {
		const envelope = envelopeOf(message({ content: `<@${BOT_ID}> fix the failing test` }));
		expect(envelope.addressed).toBe(true);
		expect(envelope.text).toBe("fix the failing test");
	});

	it("accepts reply messages", () => {
		expect(envelopeOf(message({ type: 19 })).text).toBe("hello there");
	});

	it("keeps a thread conversation separate from its parent channel", () => {
		// In a thread, channel_id is the thread id, so routing is isolated.
		const envelope = envelopeOf(message({ channel_id: "thread-7" }));
		expect(envelope.conversationId).toBe("thread-7");
	});

	it("falls back to timestamp 0 when the timestamp is unparseable", () => {
		expect(envelopeOf(message({ timestamp: "not a date" })).timestamp).toBe(0);
		expect(envelopeOf(message({ timestamp: undefined })).timestamp).toBe(0);
	});

	it("treats a missing content field as empty text", () => {
		expect(envelopeOf(message({ content: undefined })).text).toBe("");
	});

	it("keeps the raw payload for adapter debugging", () => {
		const payload = message();
		expect(envelopeOf(payload).raw).toBe(payload);
	});
});

describe("normalizeDiscordMessage — attachments", () => {
	it("classifies image attachments and file attachments", () => {
		const envelope = envelopeOf(
			message({
				content: "",
				attachments: [
					{ id: "a1", filename: "shot.png", content_type: "image/png", size: 1234, url: "https://cdn/a1" },
					{ id: "a2", filename: "log.txt", content_type: "text/plain", url: "https://cdn/a2" },
				],
			}),
		);
		expect(envelope.attachments).toEqual([
			{ kind: "image", mediaType: "image/png", ref: "https://cdn/a1", name: "shot.png", sizeBytes: 1234 },
			{ kind: "file", mediaType: "text/plain", ref: "https://cdn/a2", name: "log.txt" },
		]);
	});

	it("assumes a binary file when the content type is missing", () => {
		const envelope = envelopeOf(message({ attachments: [{ id: "a1", url: "https://cdn/a1" }] }));
		expect(envelope.attachments?.[0]).toMatchObject({ kind: "file", mediaType: "application/octet-stream" });
	});

	it("falls back to the attachment id when no url is present", () => {
		const envelope = envelopeOf(message({ attachments: [{ id: "a1" }] }));
		expect(envelope.attachments?.[0]?.ref).toBe("a1");
	});

	it("drops an attachment with neither url nor id", () => {
		expect(envelopeOf(message({ attachments: [{ filename: "x" }] })).attachments).toBeUndefined();
	});

	it("omits the field entirely when there are no attachments", () => {
		expect(envelopeOf(message()).attachments).toBeUndefined();
		expect(envelopeOf(message({ attachments: [] })).attachments).toBeUndefined();
	});

	it("tolerates a non-array attachments field", () => {
		expect(envelopeOf(message({ attachments: "nope" })).attachments).toBeUndefined();
	});
});

describe("normalizeDiscordMessage — skipped messages", () => {
	function reasonOf(payload: unknown): string {
		const result = normalizeDiscordMessage(payload, OPTIONS);
		return result.kind === "skip" ? result.reason : "envelope";
	}

	it("skips the bot's own message", () => {
		expect(reasonOf(message({ author: { id: BOT_ID } }))).toBe("self");
	});

	it("skips another bot to avoid a loop", () => {
		expect(reasonOf(message({ author: { id: "other-bot", bot: true } }))).toBe("bot-author");
	});

	it("skips a webhook message", () => {
		expect(reasonOf(message({ webhook_id: "wh-1" }))).toBe("bot-author");
	});

	it("skips system and interaction message types", () => {
		expect(reasonOf(message({ type: 7 }))).toBe("unsupported-type");
		expect(reasonOf(message({ type: 20 }))).toBe("unsupported-type");
	});

	it("skips payloads that are missing required fields", () => {
		expect(reasonOf("not an object")).toBe("not-a-message");
		expect(reasonOf(null)).toBe("not-a-message");
		expect(reasonOf([])).toBe("not-a-message");
		expect(reasonOf(message({ id: undefined }))).toBe("not-a-message");
		expect(reasonOf(message({ channel_id: 5 }))).toBe("not-a-message");
		expect(reasonOf(message({ author: undefined }))).toBe("not-a-message");
		expect(reasonOf(message({ author: { username: "no id" } }))).toBe("not-a-message");
	});
});
