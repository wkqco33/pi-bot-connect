/**
 * Parsers that turn raw work-state text into digest input.
 *
 * Pure on purpose: git and test-runner output shapes are messy and version
 * dependent, so every case here is pinned by a fixture instead of being
 * discovered in production. Git invocation and command capture live in the
 * adapter (`src/index.ts`).
 */

import type { DigestFileChange } from "./digest.js";

const MAX_PATH_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 120;

/** `old => new`, used both bare and inside `{...}` for partial renames. */
const RENAME_ARROW = /^(.*?)\s*=>\s*(.*)$/;

/** Git quotes paths that contain special characters; `{old => new}` marks renames. */
export function normalizeGitPath(rawPath: string): string {
	let path = rawPath.trim();
	if (path.startsWith('"') && path.endsWith('"') && path.length > 1) {
		path = path.slice(1, -1);
	}
	if (!path.includes(" => ")) return path;

	const braced = path.match(/^(.*)\{([^{}]*)\}(.*)$/);
	if (braced) {
		const before = braced[1] ?? "";
		const inner = braced[2] ?? "";
		const after = braced[3] ?? "";
		const renamed = inner.match(RENAME_ARROW)?.[2] ?? inner;
		return `${before}${renamed.trim()}${after}`;
	}

	return (path.match(RENAME_ARROW)?.[2] ?? path).trim();
}

export interface ParseNumstatOptions {
	/** Keep at most this many entries, after sorting. */
	readonly max?: number;
}

/**
 * Parses `git diff --numstat HEAD` output.
 *
 * Binary files report `-` for both counts and are kept with zero counts so the
 * digest still lists them. Entries are sorted by total churn descending, because
 * a digest that shows the alphabetically-first files is useless.
 */
export function parseGitNumstat(output: string, options: ParseNumstatOptions = {}): DigestFileChange[] {
	const changes: DigestFileChange[] = [];

	for (const line of output.split("\n")) {
		if (line.trim().length === 0) continue;
		const fields = line.split("\t");
		if (fields.length < 3) continue;

		const [addedField, removedField, ...pathFields] = fields;
		const path = normalizeGitPath(pathFields.join("\t"));
		if (path.length === 0 || path.length > MAX_PATH_LENGTH) continue;

		const added = addedField === "-" ? 0 : Number(addedField);
		const removed = removedField === "-" ? 0 : Number(removedField);
		if (!Number.isFinite(added) || !Number.isFinite(removed)) continue;

		changes.push({ path, added, removed });
	}

	changes.sort((a, b) => b.added + b.removed - (a.added + a.removed));
	const max = options.max;
	return max === undefined ? changes : changes.slice(0, Math.max(0, max));
}

/** `git rev-parse --abbrev-ref HEAD`; a detached HEAD is not a branch. */
export function parseGitBranch(output: string): string | undefined {
	const branch = output.trim();
	if (branch.length === 0 || branch === "HEAD") return undefined;
	return branch.length > MAX_PATH_LENGTH ? branch.slice(0, MAX_PATH_LENGTH) : branch;
}

const TEST_COMMAND_PATTERNS: readonly RegExp[] = [
	/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/,
	/\b(?:vitest|jest|mocha|ava|jasmine|karma|tap)\b/,
	/\b(?:pytest|py\.test|tox|nox)\b/,
	/\bpython[0-9.]*\s+-m\s+(?:pytest|unittest)\b/,
	/\bgo\s+test\b/,
	/\bcargo\s+test\b/,
	/\b(?:rspec|rake\s+test)\b/,
	/\bphpunit\b/,
	/\bdotnet\s+test\b/,
	/\b(?:gradlew|gradle|mvn|maven)\b[^\n]*\btest\b/,
	/\bmake\s+test\b/,
];

export function isTestCommand(command: string): boolean {
	return TEST_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

interface SummaryPattern {
	readonly pattern: RegExp;
	readonly render: (match: RegExpMatchArray) => string;
}

const SUMMARY_PATTERNS: readonly SummaryPattern[] = [
	// vitest: "Tests  312 passed (312)" / jest: "Tests: 2 failed, 10 passed, 12 total"
	{
		pattern: /^[^\S\n]*Tests:?[^\S\n]+(.+?)[^\S\n]*$/m,
		render: (match) => (match[1] ?? "").replace(/\s*\(\d+\)\s*/g, " ").trim(),
	},
	// cargo: "test result: ok. 12 passed; 0 failed;"
	{
		pattern: /test result:\s*(ok|FAILED)\.\s*(\d+)\s+passed;\s*(\d+)\s+failed/i,
		render: (match) => `${match[2] ?? "0"} passed, ${match[3] ?? "0"} failed`,
	},
	// pytest: "===== 5 passed, 1 failed in 0.12s ====="
	{
		pattern: /=+\s*([\d]+ (?:passed|failed|error|errors|skipped)[^=]*?)\s+in\s+[\d.]+s\s*=+/i,
		render: (match) => (match[1] ?? "").trim(),
	},
	// go test: "ok  github.com/x/y  0.5s" / "FAIL  github.com/x/y"
	{
		pattern: /^(ok|FAIL)\s+\S+/m,
		render: (match) => (match[1] === "ok" ? "ok" : "failed"),
	},
];

/** Extracts a compact result line from test-runner output. */
export function extractTestSummary(output: string): string | undefined {
	for (const { pattern, render } of SUMMARY_PATTERNS) {
		const match = output.match(pattern);
		if (!match) continue;
		const rendered = render(match).replace(/\s+/g, " ").trim();
		if (rendered.length === 0) continue;
		return rendered.length > MAX_SUMMARY_LENGTH ? `${rendered.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : rendered;
	}
	return undefined;
}

export interface TestRunInput {
	readonly command: string;
	/** True when the tool reported a failure. */
	readonly failed: boolean;
	readonly output: string;
}

/**
 * Produces the digest's test line, or undefined when the last command was not a
 * test command. Prefers the runner's own summary over our exit-code guess.
 */
export function summarizeTestRun(input: TestRunInput): string | undefined {
	if (!isTestCommand(input.command)) return undefined;

	const label = input.command.replace(/\s+/g, " ").trim();
	const short = label.length > 60 ? `${label.slice(0, 59)}…` : label;
	const detail = extractTestSummary(input.output) ?? (input.failed ? "failed" : "ok");
	return `${short} — ${detail}`;
}
