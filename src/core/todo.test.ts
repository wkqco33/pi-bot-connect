import { describe, expect, it } from "vitest";
import { extractMarkdownTodos } from "./todo.js";

describe("extractMarkdownTodos", () => {
	it("extracts pending and done items from a task list", () => {
		expect(extractMarkdownTodos("- [ ] write tests\n- [x] ship it")).toEqual([
			{ text: "write tests", done: false },
			{ text: "ship it", done: true },
		]);
	});

	it("accepts every bullet marker, an uppercase X, and indentation", () => {
		expect(extractMarkdownTodos("  * [X] nested\n\t+ [ ] tabbed")).toEqual([
			{ text: "nested", done: true },
			{ text: "tabbed", done: false },
		]);
	});

	it("ignores headings, prose and plain bullets", () => {
		expect(extractMarkdownTodos("# Heading\nplain text\n- a bullet without a box")).toEqual([]);
	});

	it("collapses whitespace inside the task text", () => {
		expect(extractMarkdownTodos("- [ ]   fix   the   bug  ")).toEqual([{ text: "fix the bug", done: false }]);
	});

	it("caps the number of items it keeps", () => {
		const many = Array.from({ length: 30 }, (_value, index) => `- [ ] task ${index}`).join("\n");
		expect(extractMarkdownTodos(many, { max: 5 })).toHaveLength(5);
	});

	it("truncates a pathologically long item", () => {
		const todos = extractMarkdownTodos(`- [ ] ${"x".repeat(500)}`, { maxLength: 20 });
		expect(todos[0]?.text.length).toBeLessThanOrEqual(20);
	});

	it("returns an empty array for empty input", () => {
		expect(extractMarkdownTodos("")).toEqual([]);
	});

	it("does not treat a checkbox inside a code fence as a task", () => {
		expect(extractMarkdownTodos("```\n- [ ] not a task\n```")).toEqual([]);
	});
});
