import type { LogMeta, LogMetaValue, Logger } from "./types.js";

export interface LogSink {
	write(line: string): void;
}

export function createLogger(
	scope: string,
	sink: LogSink,
	minLevel: "debug" | "info" | "warn" | "error" = "info",
): Logger {
	const order = ["debug", "info", "warn", "error"] as const;
	const min = order.indexOf(minLevel);

	const emit = (level: (typeof order)[number], message: string, meta?: LogMeta) => {
		if (order.indexOf(level) < min) return;
		const entry: Record<string, LogMetaValue | LogMeta> = {
			ts: new Date().toISOString(),
			level,
			scope,
			msg: message,
		};
		if (meta) entry.meta = meta;
		sink.write(`${JSON.stringify(entry)}\n`);
	};

	return {
		debug: (m, meta) => emit("debug", m, meta),
		info: (m, meta) => emit("info", m, meta),
		warn: (m, meta) => emit("warn", m, meta),
		error: (m, meta) => emit("error", m, meta),
	};
}

/**
 * Collects log entries in memory. Test-only helper: asserts that the core
 * never logs secrets or raw payloads.
 */
export class MemoryLogSink implements LogSink {
	readonly lines: string[] = [];
	write(line: string): void {
		this.lines.push(line);
	}
	get entries(): Array<Record<string, LogMetaValue | LogMeta>> {
		const parsed: Array<Record<string, LogMetaValue | LogMeta>> = [];
		for (const line of this.lines) {
			try {
				parsed.push(JSON.parse(line) as Record<string, LogMetaValue | LogMeta>);
			} catch {
				throw new Error(`MemoryLogSink received a malformed log line: ${line}`);
			}
		}
		return parsed;
	}
}
