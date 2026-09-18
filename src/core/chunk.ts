/**
 * Transport-agnostic, UTF-8-safe message chunking.
 *
 * Design goals:
 *  - never exceed the transport's limit (measured in chars or bytes)
 *  - never split a surrogate pair / code point
 *  - prefer readable break points (paragraph > line > sentence > space)
 *  - `chunks.join("") === text` so nothing is lost or duplicated
 */

export interface ChunkOptions {
	/** Maximum size of one chunk. Must be a positive integer. */
	readonly maxLength: number;
	/** How `maxLength` is measured. Defaults to code points. */
	readonly unit?: "chars" | "bytes";
	/** Break candidates, in descending preference order. Defaults to prose breaks. */
	readonly breakPoints?: readonly string[];
	/**
	 * Minimum fill ratio (0..1) required before a break point is accepted.
	 * Prevents degenerate one-word chunks when a break appears near the start
	 * of the window. Defaults to 0.5.
	 */
	readonly minFillRatio?: number;
}

const DEFAULT_BREAK_POINTS = ["\n\n", "\n", ". ", "! ", "? ", "; ", ", ", " "] as const;

function codePointByteLength(codePoint: string): number {
	const cp = codePoint.codePointAt(0) ?? 0;
	if (cp < 0x80) return 1;
	if (cp < 0x800) return 2;
	if (cp < 0x10000) return 3;
	return 4;
}

function matchesAt(codePoints: readonly string[], at: number, needle: readonly string[]): boolean {
	for (let i = 0; i < needle.length; i++) {
		if (codePoints[at + i] !== needle[i]) return false;
	}
	return true;
}

/** Prefer the highest-preference break whose cut offset is >= `minCut`. */
function findBreak(
	codePoints: readonly string[],
	start: number,
	end: number,
	breakPoints: readonly string[],
	minCut: number,
): number | null {
	for (const breakPoint of breakPoints) {
		const needle = Array.from(breakPoint);
		if (needle.length === 0) continue;
		for (let i = end - needle.length; i > start; i--) {
			if (i + needle.length < minCut) break;
			if (matchesAt(codePoints, i, needle)) return i + needle.length;
		}
	}
	return null;
}

export function chunkText(text: string, options: ChunkOptions): string[] {
	const { maxLength, unit = "chars", breakPoints = DEFAULT_BREAK_POINTS, minFillRatio = 0.5 } = options;

	if (!Number.isInteger(maxLength) || maxLength < 1) {
		throw new RangeError(`chunkText: maxLength must be a positive integer, received ${maxLength}`);
	}
	if (text.length === 0) return [];

	const codePoints = Array.from(text);
	const sizeOf = unit === "bytes" ? codePointByteLength : () => 1;

	const chunks: string[] = [];
	let start = 0;

	while (start < codePoints.length) {
		let used = 0;
		let end = start;
		while (end < codePoints.length) {
			const next = used + sizeOf(codePoints[end] as string);
			if (next > maxLength) break;
			used = next;
			end++;
		}

		// A single code point bigger than the limit still has to be emitted,
		// otherwise the loop would never advance.
		if (end === start) end = start + 1;

		if (end < codePoints.length) {
			const minCut = start + Math.max(1, Math.floor((end - start) * minFillRatio));
			const cut = findBreak(codePoints, start, end, breakPoints, minCut);
			if (cut !== null && cut > start) end = cut;
		}

		chunks.push(codePoints.slice(start, end).join(""));
		start = end;
	}

	return chunks;
}

/** Convenience wrapper for transports described by `TransportCapabilities`. */
export function chunkForTransport(
	text: string,
	capabilities: { maxMessageLength: number; lengthUnit: "chars" | "bytes" },
): string[] {
	return chunkText(text, {
		maxLength: capabilities.maxMessageLength,
		unit: capabilities.lengthUnit,
	});
}

export interface CappedChunks {
	readonly chunks: readonly string[];
	/** Chunks that did not fit the budget and were not sent. */
	readonly dropped: number;
}

/**
 * Bounds how many messages one outbound body may become. Without a cap a single
 * very long answer would post dozens of messages and hit platform rate limits;
 * the caller is expected to tell the user that the tail was dropped.
 */
export function capChunkCount(chunks: readonly string[], maxChunks: number): CappedChunks {
	if (!Number.isInteger(maxChunks) || maxChunks < 1) {
		throw new RangeError(`capChunkCount: maxChunks must be a positive integer, received ${maxChunks}`);
	}
	if (chunks.length <= maxChunks) return { chunks, dropped: 0 };
	return { chunks: chunks.slice(0, maxChunks), dropped: chunks.length - maxChunks };
}
