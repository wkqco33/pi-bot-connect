/**
 * Work digest: the "share what I'm doing right now" payload.
 *
 * Built from a plain snapshot so it can be produced from the terminal, on a
 * timer, or on demand from a messenger — and unit-tested without a session.
 */

import { redactSecrets } from "./redact.js";

export interface DigestFileChange {
	readonly path: string;
	readonly added: number;
	readonly removed: number;
}

export interface DigestTodo {
	readonly text: string;
	readonly done: boolean;
}

export interface WorkDigestInput {
	readonly cwd: string;
	readonly agentState: "idle" | "busy";
	readonly sessionName?: string;
	readonly branch?: string;
	readonly runningTool?: string;
	readonly changes?: readonly DigestFileChange[];
	readonly todos?: readonly DigestTodo[];
	readonly testSummary?: string;
	readonly lastUserPrompt?: string;
	readonly lastAssistantSummary?: string;
}

export interface DigestOptions {
	readonly maxLength?: number;
	readonly maxFiles?: number;
	readonly redact?: boolean;
}

const DEFAULT_MAX_LENGTH = 1500;
const DEFAULT_MAX_FILES = 6;

interface Section {
	readonly id: string;
	/** Lower is kept longer when the budget is tight. */
	readonly priority: number;
	readonly lines: string[];
}

function truncateLine(value: string, max: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, Math.max(0, max - 1))}…`;
}

function todoSection(todos: readonly DigestTodo[]): Section | null {
	if (todos.length === 0) return null;
	const open = todos.filter((todo) => !todo.done);
	const lines = [`**Pending (${open.length}/${todos.length})**`];
	for (const todo of todos) {
		lines.push(`- [${todo.done ? "x" : " "}] ${truncateLine(todo.text, 100)}`);
	}
	return { id: "todos", priority: 3, lines };
}

function changesSection(changes: readonly DigestFileChange[], maxFiles: number): Section | null {
	if (changes.length === 0) return null;
	const added = changes.reduce((sum, change) => sum + change.added, 0);
	const removed = changes.reduce((sum, change) => sum + change.removed, 0);
	const lines = [`**Changes (${changes.length} files, +${added}/-${removed})**`];
	for (const change of changes.slice(0, maxFiles)) {
		lines.push(`- \`${change.path}\` +${change.added}/-${change.removed}`);
	}
	if (changes.length > maxFiles) {
		lines.push(`- …and ${changes.length - maxFiles} more`);
	}
	return { id: "changes", priority: 2, lines };
}

function collectSections(
	input: WorkDigestInput,
	maxFiles: number,
	clean: (value: string) => string,
): Section[] {
	const sections: Section[] = [];

	if (input.runningTool) {
		sections.push({ id: "now", priority: 1, lines: [`**Now:** ${truncateLine(input.runningTool, 80)}`] });
	}
	const todos = todoSection(input.todos ?? []);
	if (todos) sections.push(todos);
	const changes = changesSection(input.changes ?? [], maxFiles);
	if (changes) sections.push(changes);
	if (input.testSummary) {
		sections.push({ id: "tests", priority: 2, lines: [`**Tests:** ${truncateLine(input.testSummary, 120)}`] });
	}
	if (input.lastUserPrompt) {
		sections.push({
			id: "request",
			priority: 4,
			lines: ["**Last request**", `> ${truncateLine(clean(input.lastUserPrompt), 200)}`],
		});
	}
	if (input.lastAssistantSummary) {
		sections.push({
			id: "summary",
			priority: 5,
			lines: ["**Summary**", truncateLine(clean(input.lastAssistantSummary), 300)],
		});
	}

	return sections;
}

function assembleDigest(header: string, sections: readonly Section[], maxLength: number): string {
	const ordered = [...sections].sort((a, b) => a.priority - b.priority);
	const kept: string[] = [];
	const omitted: string[] = [];
	let length = header.length;

	for (const section of ordered) {
		const block = section.lines.join("\n");
		if (kept.length > 0 && length + 2 + block.length > maxLength) {
			omitted.push(section.id);
			continue;
		}
		kept.push(block);
		length += 2 + block.length;
	}

	const parts = [header];
	if (kept.length > 0) parts.push(kept.join("\n\n"));
	if (omitted.length > 0) parts.push(`_digest truncated (${omitted.join(", ")})_`);
	return parts.join("\n\n");
}

export function buildWorkDigest(input: WorkDigestInput, options: DigestOptions = {}): string {
	const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
	const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
	const redact = options.redact ?? true;

	const header = [
		`### ${input.sessionName ?? "pi session"} — ${input.agentState}`,
		`\`${input.cwd}\`${input.branch ? ` · branch \`${input.branch}\`` : ""}`,
	].join("\n");

	const clean = redact ? (value: string) => redactSecrets(value) : (value: string) => value;
	const sections = collectSections(input, maxFiles, clean);
	return assembleDigest(header, sections, maxLength);
}
