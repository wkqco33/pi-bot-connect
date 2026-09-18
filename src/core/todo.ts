/**
 * Task-list extraction for the work digest.
 *
 * The digest's TODO section has to come from somewhere deterministic. The
 * agent's own assistant output is the one source the bridge already has: it
 * routinely ends a turn with a markdown checklist. Parsing that is pure, so it
 * is pinned here instead of guessed in the adapter.
 */

import type { DigestTodo } from "./digest.js";

export interface TodoExtractionOptions {
	/** Keep at most this many items. */
	readonly max?: number;
	/** Truncate a single item to this many characters. */
	readonly maxLength?: number;
}

const ITEM_PATTERN = /^\s*[-*+]\s+\[( |x|X)\]\s+(.+?)\s*$/;
const FENCE_PATTERN = /^\s*(```|~~~)/;

export function extractMarkdownTodos(text: string, options: TodoExtractionOptions = {}): DigestTodo[] {
	const max = options.max ?? 20;
	const maxLength = options.maxLength ?? 120;
	const todos: DigestTodo[] = [];
	let inFence = false;

	for (const line of text.split("\n")) {
		if (FENCE_PATTERN.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		if (todos.length >= max) break;

		const match = ITEM_PATTERN.exec(line);
		if (!match) continue;

		const done = (match[1] ?? " ").toLowerCase() === "x";
		const collapsed = (match[2] ?? "").replace(/\s+/g, " ").trim();
		if (collapsed.length === 0) continue;

		todos.push({
			text: collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed,
			done,
		});
	}

	return todos;
}
