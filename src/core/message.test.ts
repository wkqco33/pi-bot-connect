import { describe, expect, it } from "vitest";
import { extractAssistantText, extractToolText, summarize } from "./message.js";

describe("extractAssistantText", () => {
	it("returns a plain string content unchanged", () => {
		expect(extractAssistantText("hello")).toBe("hello");
	});

	it("joins text parts in order", () => {
		const content = [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		];
		expect(extractAssistantText(content)).toBe("first\n\nsecond");
	});

	it("ignores thinking and tool call parts", () => {
		const content = [
			{ type: "thinking", thinking: "internal reasoning" },
			{ type: "text", text: "visible" },
			{ type: "toolCall", name: "bash", arguments: { command: "rm -rf /" } },
		];
		expect(extractAssistantText(content)).toBe("visible");
	});

	it("skips empty text parts", () => {
		expect(extractAssistantText([{ type: "text", text: "" }, { type: "text", text: "real" }])).toBe("real");
	});

	it("tolerates malformed content instead of throwing", () => {
		expect(extractAssistantText(null)).toBe("");
		expect(extractAssistantText(undefined)).toBe("");
		expect(extractAssistantText(42)).toBe("");
		expect(extractAssistantText([null, 1, "x", { type: "text" }])).toBe("");
	});
});

describe("summarize", () => {
	it("collapses whitespace", () => {
		expect(summarize("a\n\n  b\tc")).toBe("a b c");
	});

	it("truncates with an ellipsis at the requested length", () => {
		const result = summarize("x".repeat(50), 10);
		expect(result).toHaveLength(10);
		expect(result.endsWith("…")).toBe(true);
	});

	it("leaves short text alone", () => {
		expect(summarize("short", 10)).toBe("short");
	});
});

describe("extractToolText", () => {
	it("returns a bare string result", () => {
		expect(extractToolText("raw output")).toBe("raw output");
	});

	it("reads text parts from a content array", () => {
		expect(extractToolText({ content: [{ type: "text", text: "from content" }] })).toBe("from content");
	});

	it("reads output and details fields", () => {
		expect(extractToolText({ output: "from output" })).toBe("from output");
		expect(extractToolText({ details: { output: "from details" } })).toBe("from details");
		expect(extractToolText({ details: { stdout: "from stdout" } })).toBe("from stdout");
	});

	it("prefers the longest candidate", () => {
		expect(extractToolText({ content: [{ type: "text", text: "short" }], details: { output: "much longer text" } })).toBe(
			"much longer text",
		);
	});

	it("returns an empty string rather than throwing on an unknown shape", () => {
		expect(extractToolText(null)).toBe("");
		expect(extractToolText(42)).toBe("");
		expect(extractToolText({ details: { output: 5 } })).toBe("");
		expect(extractToolText({ content: [{ type: "image" }] })).toBe("");
	});
});
