import { describe, expect, it } from "vitest";
import { measureLength } from "./chunk.js";
import { chunkMarkdown, parseMarkdownBlocks } from "./markdown-blocks.js";

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

const lastContentLine = (chunk: string): string => {
	const lines = chunk.trimEnd().split("\n");
	return lines[lines.length - 1] ?? "";
};

const looksLikeHeading = (line: string): boolean => /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line);

/** An unpaired surrogate would mean a chunk cut a code point in half. */
const hasLoneSurrogate = (value: string): boolean =>
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);

/** Four heading sections, long enough that a size-only splitter orphans a heading. */
const SECTIONED = [
	"## 구현 계획",
	"",
	"먼저 코어에 순수 함수를 넣는다. 현재 청킹은 렌더링 이후에 수행되므로 헤딩 정보가 남아 있지 않다. 이 점을 반드시 고려해야 한다.",
	"",
	"## 변경 지점",
	"",
	"- src/core/chunk.ts: 브레이크 후보 확장",
	"- src/bridge.ts: 렌더/청킹 순서",
	"- docs/architecture.md: 불변식 갱신",
	"",
	"## 테스트",
	"",
	"헤딩 경계에서 잘리는지 확인하는 테스트를 먼저 작성한다. 실패를 확인한 뒤 구현한다.",
	"",
	"## 위험",
	"",
	"코드 펜스가 깨질 수 있다. 펜스 내부 분할 여부를 별도로 다뤄야 한다.",
	"",
].join("\n");

describe("parseMarkdownBlocks", () => {
	const raws = (source: string): string[] => parseMarkdownBlocks(source).map((block) => block.raw);

	it("reconstructs the source when block contents are joined", () => {
		expect(raws(SECTIONED).join("")).toBe(SECTIONED);
	});

	it("classifies an ATX heading and reports its level", () => {
		expect(parseMarkdownBlocks("### Title\n")).toEqual([{ kind: "heading", raw: "### Title\n", level: 3 }]);
	});

	it("does not treat #hashtag as a heading", () => {
		expect(parseMarkdownBlocks("#hashtag\n")).toEqual([{ kind: "text", raw: "#hashtag\n" }]);
	});

	it("does not treat a seven-hash line as a heading", () => {
		expect(parseMarkdownBlocks("####### deep\n")).toEqual([{ kind: "text", raw: "####### deep\n" }]);
	});

	it("does not treat a four-space indented line as a heading", () => {
		expect(parseMarkdownBlocks("    # code\n")).toEqual([{ kind: "text", raw: "    # code\n" }]);
	});

	it("accepts up to three leading spaces before a heading marker", () => {
		expect(parseMarkdownBlocks("   # Title\n")).toEqual([{ kind: "heading", raw: "   # Title\n", level: 1 }]);
	});

	it("does not treat a heading-looking line inside a fence as a heading", () => {
		expect(parseMarkdownBlocks("```\n# not a heading\n```\n")).toEqual([
			{ kind: "fence", raw: "```\n# not a heading\n```\n" },
		]);
	});

	it("closes a tilde fence only with a tilde fence", () => {
		expect(parseMarkdownBlocks("~~~\n```\n~~~\n")).toEqual([{ kind: "fence", raw: "~~~\n```\n~~~\n" }]);
	});

	it("closes a fence with a longer marker of the same character", () => {
		expect(parseMarkdownBlocks("```\ncode\n````\n")).toEqual([{ kind: "fence", raw: "```\ncode\n````\n" }]);
	});

	it("keeps an unclosed fence as one block to the end of the document", () => {
		expect(parseMarkdownBlocks("```\ncode\n")).toEqual([{ kind: "fence", raw: "```\ncode\n" }]);
	});

	it("does not open a fence when the info string contains a backtick", () => {
		expect(parseMarkdownBlocks("``` a`b\ncode\n")).toEqual([{ kind: "text", raw: "``` a`b\ncode\n" }]);
	});

	it("starts a fence block without a blank line before it", () => {
		expect(parseMarkdownBlocks("text\n```\ncode\n```\n")).toEqual([
			{ kind: "text", raw: "text\n" },
			{ kind: "fence", raw: "```\ncode\n```\n" },
		]);
	});

	it("attaches a blank line run to the preceding block", () => {
		expect(parseMarkdownBlocks("## A\n\n## B\n\nbody\n")).toEqual([
			{ kind: "heading", raw: "## A\n\n", level: 2 },
			{ kind: "heading", raw: "## B\n\n", level: 2 },
			{ kind: "text", raw: "body\n" },
		]);
	});

	it("separates paragraphs into their own blocks", () => {
		expect(parseMarkdownBlocks("a\nb\n\nc\n")).toEqual([
			{ kind: "text", raw: "a\nb\n\n" },
			{ kind: "text", raw: "c\n" },
		]);
	});

	it("keeps the leading blank lines of a document out of the first heading", () => {
		expect(parseMarkdownBlocks("\n\n# Title\n")).toEqual([
			{ kind: "text", raw: "\n\n" },
			{ kind: "heading", raw: "# Title\n", level: 1 },
		]);
	});
});

describe("chunkMarkdown", () => {
	it("returns an empty list for empty input", () => {
		expect(chunkMarkdown("", { maxLength: 10 })).toEqual([]);
	});

	it("returns the source untouched when it already fits", () => {
		expect(chunkMarkdown("## A\n\nbody\n", { maxLength: 100 })).toEqual(["## A\n\nbody\n"]);
	});

	it("throws when maxLength is not a positive integer", () => {
		expect(() => chunkMarkdown("hello", { maxLength: 0 })).toThrow(RangeError);
		expect(() => chunkMarkdown("hello", { maxLength: -1 })).toThrow(RangeError);
		expect(() => chunkMarkdown("hello", { maxLength: 1.5 })).toThrow(RangeError);
	});

	it("cuts before a heading instead of after it", () => {
		const text = "## A\n\nbbbb\n\n## B\n\ncccc\n";
		expect(chunkMarkdown(text, { maxLength: 13 })).toEqual(["## A\n\nbbbb\n\n", "## B\n\ncccc\n"]);
	});

	it("never ends a chunk with the heading that owns the following body", () => {
		for (const chunk of chunkMarkdown(SECTIONED, { maxLength: 200 })) {
			expect(looksLikeHeading(lastContentLine(chunk))).toBe(false);
		}
	});

	it("keeps every chunk of the sectioned fixture within the budget", () => {
		for (const chunk of chunkMarkdown(SECTIONED, { maxLength: 200 })) {
			expect(chunk.length).toBeLessThanOrEqual(200);
		}
	});

	it("joins the sectioned fixture back to the source", () => {
		expect(chunkMarkdown(SECTIONED, { maxLength: 200 }).join("")).toBe(SECTIONED);
	});

	it("packs two short sections into one message", () => {
		const text = "## A\n\nx\n\n## B\n\ny\n\n## C\n\nz\n";
		expect(chunkMarkdown(text, { maxLength: 18 })).toEqual(["## A\n\nx\n\n## B\n\ny\n\n", "## C\n\nz\n"]);
	});

	it("does not emit a bare heading on its own when the next section is huge", () => {
		const text = `## A\n\n## B\n\n${"x".repeat(3000)}\n`;
		const chunks = chunkMarkdown(text, { maxLength: 2000 });
		expect(chunks[0]).toBe(`## A\n\n## B\n\n${"x".repeat(1988)}`);
		expect(chunks.join("")).toBe(text);
	});

	it("keeps a fenced block intact when the section is oversized", () => {
		const text = `## A\n\n${"p".repeat(120)}\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n`;
		const chunks = chunkMarkdown(text, { maxLength: 60 });
		for (const chunk of chunks) {
			expect((chunk.match(/\`\`\`/g) ?? []).length % 2).toBe(0);
		}
		expect(chunks.join("")).toBe(text);
	});

	it("splits a paragraph that exceeds the budget without orphaning its heading", () => {
		const chunks = chunkMarkdown(`## A\n\n${"p".repeat(120)}\n`, { maxLength: 60 });
		expect(chunks[0]?.startsWith("## A\n\n")).toBe(true);
		expect(looksLikeHeading(lastContentLine(chunks[0] ?? ""))).toBe(false);
		expect(chunks.join("")).toBe(`## A\n\n${"p".repeat(120)}\n`);
	});

	it("reopens and closes an oversized fence in every piece", () => {
		const lines = Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`);
		const text = `\`\`\`ts\n${lines.join("\n")}\n\`\`\`\n`;
		const chunks = chunkMarkdown(text, { maxLength: 60 });
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.startsWith("```ts\n")).toBe(true);
			expect(chunk.endsWith("```\n")).toBe(true);
		}
	});

	it("keeps every code line when repairing an oversized fence", () => {
		const lines = Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`);
		const body = `${lines.join("\n")}\n`;
		const chunks = chunkMarkdown(`\`\`\`ts\n${body}\`\`\`\n`, { maxLength: 60 });
		const stripped = chunks.map((chunk) => chunk.slice("```ts\n".length, chunk.length - "```\n".length));
		expect(stripped.join("")).toBe(body);
	});

	it("adds nothing but the fence markers when the body already ends its lines", () => {
		const lines = Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`);
		const text = `\`\`\`ts\n${lines.join("\n")}\n\`\`\`\n`;
		const chunks = chunkMarkdown(text, { maxLength: 60 });
		const markers = ("```ts\n".length + "```\n".length) * (chunks.length - 1);
		expect(chunks.join("").length).toBe(text.length + markers);
	});

	it("adds line breaks but no other characters when repairing a one-line fence", () => {
		const body = `${"x".repeat(200)}\n`;
		const text = `\`\`\`\n${body}\`\`\`\n`;
		const chunks = chunkMarkdown(text, { maxLength: 40 });
		const stripped = chunks.map((chunk) => chunk.slice("```\n".length, chunk.length - "```\n".length));
		// A hard cut inside a code line becomes a line break: nothing else changes.
		expect(stripped.join("").replace(/\n/g, "")).toBe(body.replace(/\n/g, ""));
	});

	it("does not satisfy join(chunks) === source once a fence has to be repaired", () => {
		const text = `\`\`\`\n${"x".repeat(200)}\n\`\`\`\n`;
		expect(chunkMarkdown(text, { maxLength: 40 }).join("")).not.toBe(text);
	});

	it("repairs an oversized fence that follows a heading", () => {
		const text = `## A\n\n\`\`\`ts\n${"x".repeat(200)}\n\`\`\`\n`;
		const chunks = chunkMarkdown(text, { maxLength: 60 });
		expect(chunks[0]?.startsWith("## A\n\n```ts\n")).toBe(true);
	});

	it("closes an unclosed oversized fence in every piece", () => {
		const chunks = chunkMarkdown(`\`\`\`\n${"x".repeat(200)}\n`, { maxLength: 40 });
		for (const chunk of chunks) {
			expect(chunk.endsWith("```\n")).toBe(true);
		}
	});

	it("keeps the fence language on every repaired piece", () => {
		const chunks = chunkMarkdown(`\`\`\`typescript\n${"x".repeat(120)}\n\`\`\`\n`, { maxLength: 40 });
		for (const chunk of chunks) {
			expect(chunk.startsWith("```typescript\n")).toBe(true);
		}
	});

	it("keeps the fence closed when a blank line follows it", () => {
		const text = `## A\n\n\`\`\`ts\n${"x".repeat(200)}\n\`\`\`\n\n## B\n\n끝.\n`;
		const chunks = chunkMarkdown(text, { maxLength: 60 });
		for (const chunk of chunks) {
			expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
		}
	});

	it("keeps the trailing blank line of a repaired fence", () => {
		const text = `\`\`\`\n${"x".repeat(200)}\n\`\`\`\n\n`;
		const chunks = chunkMarkdown(text, { maxLength: 40 });
		expect(chunks[chunks.length - 1]?.endsWith("\`\`\`\n\n")).toBe(true);
	});

	it("falls back to size splitting when a heading leaves no room for the fence", () => {
		const text = `# ${"x".repeat(30)}\n\n\`\`\`\ncode\n\`\`\`\n`;
		const chunks = chunkMarkdown(text, { maxLength: 10 });
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(10);
		}
		expect(chunks.join("")).toBe(text);
	});

	it("treats a document without headings as a single section", () => {
		const text = "word ".repeat(50);
		const chunks = chunkMarkdown(text, { maxLength: 40 });
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(40);
		}
		expect(chunks.join("")).toBe(text);
	});

	it("keeps a trailing bare heading as its own chunk", () => {
		expect(chunkMarkdown("## A\n\nbody\n\n## B\n", { maxLength: 12 })).toEqual(["## A\n\nbody\n\n", "## B\n"]);
	});

	it("splits a heading that is longer than the budget", () => {
		const text = `#${"x".repeat(20)}\n\nbody\n`;
		const chunks = chunkMarkdown(text, { maxLength: 10 });
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(10);
		}
		expect(chunks.join("")).toBe(text);
	});

	it("keeps CRLF line endings intact across a section boundary", () => {
		const text = `## A\r\n\r\n${"a".repeat(30)}\r\n\r\n## B\r\n\r\n${"b".repeat(30)}\r\n`;
		const chunks = chunkMarkdown(text, { maxLength: 45 });
		expect(chunks.join("")).toBe(text);
		expect(chunks[1]?.startsWith("## B")).toBe(true);
	});

	it("measures byte budgets for byte-budgeted transports", () => {
		const text = `## 제목\n\n${"가나다".repeat(100)}\n`;
		const chunks = chunkMarkdown(text, { maxLength: 30, unit: "bytes" });
		for (const chunk of chunks) {
			expect(utf8Bytes(chunk)).toBeLessThanOrEqual(30);
		}
		expect(chunks[0]?.startsWith("## 제목\n\n")).toBe(true);
		expect(chunks.join("")).toBe(text);
	});

	it("measures UTF-16 units for a platform that counts them", () => {
		const text = `## A\n\n${"😀".repeat(40)}\n`;
		const chunks = chunkMarkdown(text, { maxLength: 20, unit: "utf16" });
		for (const chunk of chunks) {
			expect(measureLength(chunk, "utf16")).toBeLessThanOrEqual(20);
		}
		expect(chunks[0]?.startsWith("## A\n\n")).toBe(true);
		expect(chunks.join("")).toBe(text);
	});

	it("never splits a surrogate pair when splitting a section", () => {
		const text = `## A\n\n${"😀".repeat(50)}\n`;
		const chunks = chunkMarkdown(text, { maxLength: 9 });
		for (const chunk of chunks) {
			expect(hasLoneSurrogate(chunk)).toBe(false);
		}
		expect(chunks.join("")).toBe(text);
	});
});
