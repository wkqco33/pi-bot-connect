import { describe, expect, it } from "vitest";
import type { Envelope } from "./types.js";
import { parseTranscript, serializeTranscript, TRANSCRIPT_VERSION } from "./transcript.js";

function envelope(overrides: Partial<Envelope> = {}): Envelope {
	return {
		transport: "discord",
		conversationId: "chan-1",
		userId: "user-9",
		timestamp: 1,
		text: "hello",
		isDirect: true,
		...overrides,
	};
}

describe("serializeTranscript", () => {
	it("round-trips an envelope through parse", () => {
		const text = serializeTranscript([envelope({ text: "run the tests", addressed: false })]);
		const parsed = parseTranscript(text);
		expect(parsed.warnings).toEqual([]);
		expect(parsed.envelopes).toEqual([envelope({ text: "run the tests", addressed: false })]);
	});

	it("redacts secrets so a captured transcript is safe to commit", () => {
		const text = serializeTranscript([envelope({ text: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWX" })]);
		expect(text).not.toContain("ABCDEF");
		expect(text).toContain("[redacted:github-token]");
	});

	it("drops the platform payload, which can carry arbitrary data", () => {
		const text = serializeTranscript([envelope({ raw: { secret: "payload" } })]);
		expect(text).not.toContain("payload");
	});

	it("stamps the version on its own header line", () => {
		const [header] = serializeTranscript([envelope()]).split("\n");
		expect(JSON.parse(header ?? "")).toEqual({ version: TRANSCRIPT_VERSION });
	});
});

describe("parseTranscript", () => {
	it("returns an empty result for empty input", () => {
		expect(parseTranscript("")).toEqual({ envelopes: [], warnings: [] });
	});

	it("rejects a transcript with a future version", () => {
		const parsed = parseTranscript(`${JSON.stringify({ version: 999 })}\n`);
		expect(parsed.envelopes).toEqual([]);
		expect(parsed.warnings[0]).toContain("unsupported version");
	});

	it("drops a malformed line with a warning instead of throwing", () => {
		const text = `${JSON.stringify({ version: TRANSCRIPT_VERSION })}\nnot json\n${JSON.stringify(envelope())}\n`;
		const parsed = parseTranscript(text);
		expect(parsed.envelopes).toHaveLength(1);
		expect(parsed.warnings).toHaveLength(1);
	});

	it("drops an entry missing required fields", () => {
		const text = `${JSON.stringify({ version: TRANSCRIPT_VERSION })}\n${JSON.stringify({ transport: "discord" })}\n`;
		const parsed = parseTranscript(text);
		expect(parsed.envelopes).toEqual([]);
		expect(parsed.warnings[0]).toContain("malformed envelope");
	});

	it("ignores blank lines", () => {
		const text = `${JSON.stringify({ version: TRANSCRIPT_VERSION })}\n\n${JSON.stringify(envelope())}\n\n`;
		expect(parseTranscript(text).envelopes).toHaveLength(1);
	});
});
