/** Small text helpers shared by the command parser and the router. */

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MentionStripResult {
	readonly text: string;
	readonly mentioned: boolean;
}

/**
 * Removes one leading `@bot` mention. Returns the original text (after trim)
 * plus whether a mention was present, so callers can use it for addressing.
 */
export function stripLeadingMention(text: string, botUsername: string | undefined): MentionStripResult {
	const trimmed = text.trim();
	if (!botUsername) return { text: trimmed, mentioned: false };

	const pattern = new RegExp(`^@${escapeRegExp(botUsername)}\\b[\\s,:-]*`, "i");
	const match = trimmed.match(pattern);
	if (!match) return { text: trimmed, mentioned: false };
	return { text: trimmed.slice(match[0].length).trim(), mentioned: true };
}

/** Case-insensitive `startsWith` over a list of prefixes. */
export function startsWithAny(text: string, prefixes: readonly string[]): boolean {
	const lowered = text.toLowerCase();
	for (const prefix of prefixes) {
		if (prefix.length === 0) continue;
		if (lowered.startsWith(prefix.toLowerCase())) return true;
	}
	return false;
}
