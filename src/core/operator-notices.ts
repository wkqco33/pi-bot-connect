/* Operator-visible output policy; transport errors are never printed raw to the TUI. */

export function consoleLogEnabled(debug: boolean, _level: string): boolean {
	return debug;
}

/** A failure episode ends only when its operation succeeds again. */
export class OperatorNotices {
	private readonly active = new Set<string>();

	fail(transport: string, kind: string): boolean {
		const key = `${transport}:${kind}`;
		if (this.active.has(key)) return false;
		this.active.add(key);
		return true;
	}

	recover(transport: string, kind: string): void {
		this.active.delete(`${transport}:${kind}`);
	}

	clear(): void {
		this.active.clear();
	}

	failed(transport: string, kind: string): boolean {
		return this.active.has(`${transport}:${kind}`);
	}
}

export function summarizeStartupNotes(notes: readonly string[]): string {
	return `[bot-connect] ${notes.length} startup warning${notes.length === 1 ? "" : "s"}; run /connect doctor for details.`;
}
