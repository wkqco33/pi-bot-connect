/**
 * Extraction of display text from pi message content.
 *
 * Kept pure and defensive: message shapes come from the host, and a messenger
 * bridge must never crash because a message had an unexpected part.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Returns only the visible text of an assistant message, in order. */
export function extractAssistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type !== "text") continue;
		if (typeof part.text === "string" && part.text.length > 0) parts.push(part.text);
	}
	return parts.join("\n\n");
}

/** Collapses a message into a short single-line summary for chat notifications. */
export function summarize(text: string, maxLength = 400): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxLength) return collapsed;
	return `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Pulls display text out of a tool result.
 *
 * The exact shape differs per tool and per pi version, so every plausible
 * location is checked and the longest candidate wins. Returning "" is always
 * acceptable: callers fall back to the tool's exit status.
 */
export function extractToolText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!isRecord(result)) return "";

	const candidates: string[] = [extractAssistantText(result.content)];
	if (typeof result.output === "string") candidates.push(result.output);

	const details = result.details;
	if (isRecord(details)) {
		for (const key of ["output", "stdout", "text"]) {
			const value = details[key];
			if (typeof value === "string") candidates.push(value);
		}
	}

	let longest = "";
	for (const candidate of candidates) {
		if (candidate.length > longest.length) longest = candidate;
	}
	return longest;
}
