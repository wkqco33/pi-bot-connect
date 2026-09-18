import { describe, expect, it } from "vitest";
import { capChunkCount, chunkForTransport, chunkText, measureLength } from "./chunk.js";

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

describe("chunkText", () => {
	it("throws when maxLength is not a positive integer", () => {
		expect(() => chunkText("hello", { maxLength: 0 })).toThrow(RangeError);
		expect(() => chunkText("hello", { maxLength: -1 })).toThrow(RangeError);
		expect(() => chunkText("hello", { maxLength: 1.5 })).toThrow(RangeError);
	});

	it("returns an empty array for empty input", () => {
		expect(chunkText("", { maxLength: 10 })).toEqual([]);
	});

	it("returns the original text untouched when it already fits", () => {
		expect(chunkText("short", { maxLength: 10 })).toEqual(["short"]);
	});

	it("never exceeds maxLength", () => {
		const text = "word ".repeat(200);
		for (const chunk of chunkText(text, { maxLength: 50 })) {
			expect(chunk.length).toBeLessThanOrEqual(50);
		}
	});

	it("preserves the original text exactly when joined", () => {
		const text = "# Title\n\nSome paragraph text that is fairly long.\n\n```ts\nconst a = 1;\n```\n";
		const chunks = chunkText(text, { maxLength: 24 });
		expect(chunks.join("")).toBe(text);
	});

	it("prefers paragraph breaks over line breaks", () => {
		const text = "first part\n\nsecond part\nthird part";
		expect(chunkText(text, { maxLength: 12 })).toEqual(["first part\n\n", "second part\n", "third part"]);
	});

	it("falls back to a line break when no paragraph break is available", () => {
		const text = "alpha beta gamma\ndelta epsilon";
		const chunks = chunkText(text, { maxLength: 17 });
		expect(chunks).toEqual(["alpha beta gamma\n", "delta epsilon"]);
	});

	it("does not produce a degenerate chunk when a break appears very early", () => {
		const text = "\n\nfollowed by a very long single line of prose that must be hard cut";
		const chunks = chunkText(text, { maxLength: 20 });
		for (const chunk of chunks) {
			expect(chunk.length).toBeGreaterThan(5);
		}
		expect(chunks.join("")).toBe(text);
	});

	it("never splits a surrogate pair", () => {
		const text = "😀😀😀";
		expect(chunkText(text, { maxLength: 2 })).toEqual(["😀😀", "😀"]);
	});

	it("counts bytes when unit is bytes so emoji stay intact", () => {
		const chunks = chunkText("😀😀😀", { maxLength: 4, unit: "bytes" });
		expect(chunks).toEqual(["😀", "😀", "😀"]);
		for (const chunk of chunks) {
			expect(utf8Bytes(chunk)).toBeLessThanOrEqual(4);
		}
	});

	it("measures byte budgets against UTF-8 length, not code point count", () => {
		const text = "가나다라마바사";
		const chunks = chunkText(text, { maxLength: 7, unit: "bytes" });
		for (const chunk of chunks) {
			expect(utf8Bytes(chunk)).toBeLessThanOrEqual(7);
		}
		expect(chunks.join("")).toBe(text);
	});

	it("emits a single oversized code point rather than looping forever", () => {
		expect(chunkText("😀", { maxLength: 1, unit: "bytes" })).toEqual(["😀"]);
	});

	it("never cuts between a carriage return and its line feed", () => {
		const text = "aaaa\r\nbbbb";
		for (const chunk of chunkText(text, { maxLength: 5 })) {
			expect(chunk.endsWith("\r")).toBe(false);
			expect(chunk.startsWith("\n")).toBe(false);
		}
		expect(chunkText(text, { maxLength: 5 }).join("")).toBe(text);
	});

	it("prefers a CRLF paragraph break over a CRLF line break", () => {
		const text = "first part\r\n\r\nsecond part\r\nthird part";
		expect(chunkText(text, { maxLength: 14 })).toEqual(["first part\r\n\r\n", "second part\r\n", "third part"]);
	});

	it("keeps chunks inside a UTF-16 budget", () => {
		expect(chunkText("😀😀😀", { maxLength: 4, unit: "utf16" })).toEqual(["😀😀", "😀"]);
	});

	it("counts a BMP character as one UTF-16 unit", () => {
		expect(chunkText("가나다", { maxLength: 2, unit: "utf16" })).toEqual(["가나", "다"]);
	});

	it("supports a custom break point list", () => {
		const text = "aaa|bbb|ccc";
		expect(chunkText(text, { maxLength: 6, breakPoints: ["|"], minFillRatio: 0 })).toEqual([
			"aaa|",
			"bbb|",
			"ccc",
		]);
	});
});

describe("measureLength", () => {
	it("counts code points for a char budget", () => {
		expect(measureLength("😀😀", "chars")).toBe(2);
	});

	it("counts UTF-8 bytes for a byte budget", () => {
		expect(measureLength("가나다", "bytes")).toBe(9);
	});

	it("defaults to chars", () => {
		expect(measureLength("😀")).toBe(1);
	});

	it("reports zero for empty input", () => {
		expect(measureLength("", "bytes")).toBe(0);
	});

	it("matches the byte budget chunkText enforces", () => {
		for (const chunk of chunkText("가나다라마바사", { maxLength: 7, unit: "bytes" })) {
			expect(measureLength(chunk, "bytes")).toBeLessThanOrEqual(7);
		}
	});

	it("counts two units for an astral character in a UTF-16 budget", () => {
		expect(measureLength("😀", "utf16")).toBe(2);
	});

	it("counts one unit for a BMP character in a UTF-16 budget", () => {
		expect(measureLength("가나", "utf16")).toBe(2);
	});
});

describe("capChunkCount", () => {
	it("keeps every chunk when the count is within budget", () => {
		expect(capChunkCount(["a", "b"], 2)).toEqual({ chunks: ["a", "b"], dropped: 0 });
	});

	it("reports how many chunks were dropped", () => {
		expect(capChunkCount(["a", "b", "c", "d"], 2)).toEqual({ chunks: ["a", "b"], dropped: 2 });
	});

	it("keeps a single chunk when the budget is one", () => {
		expect(capChunkCount(["a", "b"], 1)).toEqual({ chunks: ["a"], dropped: 1 });
	});

	it("accepts an empty chunk list", () => {
		expect(capChunkCount([], 3)).toEqual({ chunks: [], dropped: 0 });
	});

	it("rejects a budget below one", () => {
		expect(() => capChunkCount(["a"], 0)).toThrow(RangeError);
	});

	it("rejects a fractional budget", () => {
		expect(() => capChunkCount(["a"], 1.5)).toThrow(RangeError);
	});
});

describe("chunkForTransport", () => {
	it("uses the transport's unit and limit", () => {
		const chunks = chunkForTransport("😀😀😀", { maxMessageLength: 4, lengthUnit: "bytes" });
		expect(chunks).toEqual(["😀", "😀", "😀"]);
	});

	it("chunks by characters for char-measured transports", () => {
		const chunks = chunkForTransport("abcdefghij", { maxMessageLength: 4, lengthUnit: "chars" });
		expect(chunks).toEqual(["abcd", "efgh", "ij"]);
	});

	it("chunks by UTF-16 units for platforms that count them", () => {
		const chunks = chunkForTransport("😀😀😀", { maxMessageLength: 4, lengthUnit: "utf16" });
		expect(chunks).toEqual(["😀😀", "😀"]);
	});
});
