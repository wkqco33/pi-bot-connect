import { describe, expect, it } from "vitest";
import { chunkForTransport, chunkText } from "./chunk.js";

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

	it("supports a custom break point list", () => {
		const text = "aaa|bbb|ccc";
		expect(chunkText(text, { maxLength: 6, breakPoints: ["|"], minFillRatio: 0 })).toEqual([
			"aaa|",
			"bbb|",
			"ccc",
		]);
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
});
