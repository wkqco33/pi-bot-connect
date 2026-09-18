/**
 * Progress-card labels.
 *
 * Only the tool *name* ever appears: arguments routinely carry paths, tokens and
 * file contents, and a progress card is visible in a messenger. Kept pure so the
 * wording is testable and the pi adapter stays free of formatting policy.
 */

function normalizeToolName(toolName: string): string {
	return toolName.replace(/\s+/g, " ").trim();
}

/** Shown before any tool runs, so a long reasoning phase is still visible. */
export function thinkingLabel(): string {
	return "thinking…";
}

export function toolStartLabel(toolName: string): string {
	return `▶ ${normalizeToolName(toolName)}`;
}

export function toolEndLabel(toolName: string, ok: boolean): string {
	return `${ok ? "✓" : "✕"} ${normalizeToolName(toolName)}`;
}
