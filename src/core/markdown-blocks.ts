/**
 * Markdown-structure-aware chunking.
 *
 * `chunkText` (chunk.ts) is limit-safe but structure-blind: it happily ends a
 * message with a heading whose body went to the next one, or cuts inside a
 * fenced code block. This module splits the CommonMark *source* at structural
 * boundaries first and only then hands whatever still does not fit to
 * `chunkText`, which stays the hard guarantee for the transport limit.
 *
 * It deliberately runs before rendering: a transport that renders `## X` as
 * `<b>X</b>` (html) or `*X*` (mrkdwn) would otherwise hide the structure from
 * the splitter.
 *
 * Guarantees:
 *  - `chunks.join("") === source` — nothing is lost, duplicated or reordered —
 *    with one documented exception: a fence that alone exceeds the budget has
 *    its opening and closing marker repeated in every piece, because a chunk
 *    boundary inside a fence would render as broken markdown. No code content
 *    is added, lost or reordered.
 *  - a chunk never ends with a heading that still has a body
 *  - a fenced block is split only when the fence alone exceeds the budget
 */

import { chunkText, measureLength, type LengthUnit } from "./chunk.js";

export interface MarkdownBlock {
	readonly kind: "heading" | "fence" | "text";
	/** The block's exact source text, including its line endings. */
	readonly raw: string;
	/** Heading level (1..6). Present on `heading` blocks only. */
	readonly level?: number;
}

export interface MarkdownChunkOptions {
	/** Maximum size of one chunk. Must be a positive integer. */
	readonly maxLength: number;
	/** How `maxLength` is measured. Defaults to code points. */
	readonly unit?: LengthUnit;
}

/** ATX heading: up to three leading spaces, 1..6 hashes, then a space or end of line. */
const HEADING_LINE = /^ {0,3}(#{1,6})(?:[ \t]+|(?=\r?\n)|$)/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^\n]*)/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*(?:\r?\n)?$/;
const BLANK_LINE = /^[ \t]*(?:\r?\n)?$/;

interface FenceOpening {
	readonly marker: string;
	readonly info: string;
}

function splitLines(source: string): string[] {
	const lines: string[] = [];
	let start = 0;
	while (start < source.length) {
		const newline = source.indexOf("\n", start);
		if (newline === -1) {
			lines.push(source.slice(start));
			break;
		}
		lines.push(source.slice(start, newline + 1));
		start = newline + 1;
	}
	return lines;
}

function isHeadingLine(line: string): boolean {
	return HEADING_LINE.test(line);
}

function fenceOpening(line: string): FenceOpening | null {
	const match = FENCE_OPEN.exec(line);
	if (match === null) return null;
	const marker = match[1] as string;
	const info = match[2] ?? "";
	// CommonMark: a backtick fence's info string may not contain a backtick.
	// Without this, a paragraph that happens to start with ``` would swallow
	// everything after it as a code block.
	if (marker.startsWith("`") && info.includes("`")) return null;
	return { marker, info };
}

/** Index just past the closing fence, or the end of the document when unclosed. */
function findFenceEnd(lines: readonly string[], start: number, opening: FenceOpening): number {
	const character = opening.marker[0] as string;
	for (let index = start + 1; index < lines.length; index++) {
		const closer = FENCE_CLOSE.exec(lines[index] as string);
		if (closer === null) continue;
		const marker = closer[1] as string;
		if ((marker[0] as string) === character && marker.length >= opening.marker.length) return index + 1;
	}
	return lines.length;
}

/** Splits CommonMark into heading, fenced-code and text blocks, fence-aware. */
export function parseMarkdownBlocks(source: string): readonly MarkdownBlock[] {
	const lines = splitLines(source);
	const blocks: MarkdownBlock[] = [];

	const pushText = (raw: string): void => {
		if (raw.length === 0) return;
		const previous = blocks[blocks.length - 1];
		// A run of blank lines belongs to the block before it: that keeps a
		// heading and its blank separator in one unit, so the packer cannot cut
		// between a heading and the body that follows it.
		if (previous !== undefined && raw.trim().length === 0) {
			blocks[blocks.length - 1] = { ...previous, raw: previous.raw + raw };
			return;
		}
		blocks.push({ kind: "text", raw });
	};

	let index = 0;
	while (index < lines.length) {
		const line = lines[index] as string;

		const heading = HEADING_LINE.exec(line);
		if (heading !== null) {
			blocks.push({ kind: "heading", raw: line, level: (heading[1] as string).length });
			index++;
			continue;
		}

		const opening = fenceOpening(line);
		if (opening !== null) {
			const end = findFenceEnd(lines, index, opening);
			blocks.push({ kind: "fence", raw: lines.slice(index, end).join("") });
			index = end;
			continue;
		}

		let end = index;
		while (end < lines.length) {
			const candidate = lines[end] as string;
			if (end > index && (isHeadingLine(candidate) || fenceOpening(candidate) !== null)) break;
			end++;
			if (BLANK_LINE.test(candidate)) break;
		}
		pushText(lines.slice(index, end).join(""));
		index = end;
	}

	return blocks;
}

function joinBlocks(blocks: readonly MarkdownBlock[]): string {
	return blocks.map((block) => block.raw).join("");
}

function measureBlocks(blocks: readonly MarkdownBlock[], unit: LengthUnit): number {
	let total = 0;
	for (const block of blocks) total += measureLength(block.raw, unit);
	return total;
}

/** A heading starts a section; everything until the next heading is its body. */
function groupSections(blocks: readonly MarkdownBlock[]): MarkdownBlock[][] {
	const sections: MarkdownBlock[][] = [];
	for (const block of blocks) {
		const current = sections[sections.length - 1];
		if (current === undefined || block.kind === "heading") sections.push([block]);
		else current.push(block);
	}
	return sections;
}

/**
 * A heading whose section has no real body would be sent as a one-line message
 * whenever the next section is too large to share a message. Gluing it forward
 * keeps the headings together with the content that follows them.
 */
function glueBareHeadings(sections: readonly MarkdownBlock[][]): MarkdownBlock[][] {
	const glued: MarkdownBlock[][] = [];
	let pending: MarkdownBlock[] = [];
	for (const section of sections) {
		pending.push(...section);
		if (section.every((block) => block.kind === "heading" || block.raw.trim().length === 0)) continue;
		glued.push(pending);
		pending = [];
	}
	if (pending.length > 0) glued.push(pending);
	return glued;
}

/** Greedy packing: a cut always lands on a section start, never inside one. */
function packSections(sections: readonly MarkdownBlock[][], maxLength: number, unit: LengthUnit): MarkdownBlock[][] {
	const groups: MarkdownBlock[][] = [];
	let current: MarkdownBlock[] = [];
	let currentSize = 0;

	for (const section of sections) {
		if (current.length === 0) {
			current = [...section];
			currentSize = measureBlocks(section, unit);
			continue;
		}
		const size = measureBlocks(section, unit);
		if (currentSize + size <= maxLength) {
			current.push(...section);
			currentSize += size;
			continue;
		}
		groups.push(current);
		current = [...section];
		currentSize = size;
	}

	if (current.length > 0) groups.push(current);
	return groups;
}

/**
 * Packs blocks into runs, pulling trailing headings forward.
 *
 * A run that ends with a heading would deliver a bodyless heading whenever the
 * oversized run is split, so the heading opens the next run instead.
 */
function packBlocks(blocks: readonly MarkdownBlock[], maxLength: number, unit: LengthUnit): MarkdownBlock[][] {
	const runs: MarkdownBlock[][] = [];
	let current: MarkdownBlock[] = [];
	let size = 0;

	for (const block of blocks) {
		const blockSize = measureLength(block.raw, unit);
		if (current.length === 0) {
			current = [block];
			size = blockSize;
			continue;
		}
		if (size + blockSize <= maxLength) {
			current.push(block);
			size += blockSize;
			continue;
		}

		const carried: MarkdownBlock[] = [];
		while (current.length > 0 && (current[current.length - 1] as MarkdownBlock).kind === "heading") {
			carried.unshift(current.pop() as MarkdownBlock);
		}
		if (current.length > 0) runs.push(current);
		current = [...carried, block];
		size = measureBlocks(current, unit);
	}

	if (current.length > 0) runs.push(current);
	return runs;
}

/**
 * Re-wraps the pieces of a fence that does not fit one message, so every message
 * still opens and closes its own code block.
 *
 * Returns `null` when there is no room left for a body (for example an oversized
 * heading consumed the whole budget); the caller then falls back to plain size
 * chunking.
 */
function repairFence(block: MarkdownBlock, budget: number, unit: LengthUnit): string[] | null {
	const lines = splitLines(block.raw);
	const opening = lines[0];
	if (opening === undefined) return null;

	const spec = fenceOpening(opening);
	if (spec === null) return null;

	// The closing fence is the first line that CommonMark would accept as one.
	// Anything after it (the blank line the parser attached to this block) is
	// kept as a suffix on the last piece, never inside the body.
	let closeIndex = -1;
	for (let index = 1; index < lines.length; index++) {
		const closer = FENCE_CLOSE.exec(lines[index] as string);
		if (closer === null) continue;
		const marker = closer[1] as string;
		if ((marker[0] as string) === (spec.marker[0] as string) && marker.length >= spec.marker.length) {
			closeIndex = index;
			break;
		}
	}

	const closing = closeIndex === -1 ? `${spec.marker}\n` : (lines[closeIndex] as string);
	const body = (closeIndex === -1 ? lines.slice(1) : lines.slice(1, closeIndex)).join("");
	const suffix = closeIndex === -1 ? "" : lines.slice(closeIndex + 1).join("");

	// The closing fence needs a line of its own, hence the extra unit.
	const overhead =
		measureLength(opening, unit) + measureLength(closing, unit) + 1 + measureLength(suffix, unit);
	const inner = budget - overhead;
	if (inner < 1) return null;

	const pieces = chunkText(body, { maxLength: inner, unit });
	if (pieces.length === 0) return null;
	return pieces.map((piece, index) => {
		const wrapped = opening + (piece.endsWith("\n") ? piece : `${piece}\n`) + closing;
		return index === pieces.length - 1 ? wrapped + suffix : wrapped;
	});
}

/**
 * Splits a run that does not fit. An oversized run is always an oversized last
 * block plus the headings carried in front of it.
 */
function splitRun(run: readonly MarkdownBlock[], maxLength: number, unit: LengthUnit): string[] {
	const last = run[run.length - 1];
	const prefix: readonly MarkdownBlock[] = run.slice(0, -1);

	if (last !== undefined && last.kind === "fence") {
		const prefixSize = measureBlocks(prefix, unit);
		const repaired = repairFence(last, maxLength - prefixSize, unit);
		if (repaired !== null) return [joinBlocks(prefix) + (repaired[0] ?? ""), ...repaired.slice(1)];
	}

	const first = run[0];
	const heading = run.length > 1 && first !== undefined && first.kind === "heading" ? first.raw : null;
	const budget = maxLength - (heading === null ? 0 : measureLength(heading, unit));

	if (heading !== null && budget >= 1) {
		// Reserve the heading's width for the whole body so the heading can be
		// prepended to the first piece instead of becoming a message of its own.
		const inner = chunkText(joinBlocks(run.slice(1)), { maxLength: budget, unit });
		return [heading + (inner[0] ?? ""), ...inner.slice(1)];
	}

	return chunkText(joinBlocks(run), { maxLength, unit });
}

function emitGroup(blocks: readonly MarkdownBlock[], maxLength: number, unit: LengthUnit): string[] {
	if (measureBlocks(blocks, unit) <= maxLength) return [joinBlocks(blocks)];
	return packBlocks(blocks, maxLength, unit).flatMap((run) =>
		measureBlocks(run, unit) <= maxLength ? [joinBlocks(run)] : splitRun(run, maxLength, unit),
	);
}

/**
 * Splits CommonMark at structural boundaries, then by size where a single block
 * is still too large.
 */
export function chunkMarkdown(text: string, options: MarkdownChunkOptions): string[] {
	const { maxLength, unit = "chars" } = options;
	if (!Number.isInteger(maxLength) || maxLength < 1) {
		throw new RangeError(`chunkMarkdown: maxLength must be a positive integer, received ${maxLength}`);
	}
	if (text.length === 0) return [];
	if (measureLength(text, unit) <= maxLength) return [text];

	const sections = glueBareHeadings(groupSections(parseMarkdownBlocks(text)));
	return packSections(sections, maxLength, unit).flatMap((group) => emitGroup(group, maxLength, unit));
}
