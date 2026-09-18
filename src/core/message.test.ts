import { describe, expect, it } from "vitest";
import { extractAssistantText, summarize } from "./message.js";

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
