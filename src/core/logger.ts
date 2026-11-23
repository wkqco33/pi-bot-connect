import { redactSecrets } from "./redact.js";
import { noopLogger, type LogMeta, type LogMetaValue, type Logger } from "./types.js";

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

const RUNTIME_FIELDS = new Set([
	"attempt", "code", "command", "delay", "deliverAs", "holderPid",
	"images", "intents", "kind", "mediaType", "policy", "port", "rules",
	"sameHost", "status", "tool", "tooOld", "transport",
]);

/** Keeps provider responses, exception text, usernames and local paths out of debug output. */
export function createRuntimeLogger(scope: string, sink: LogSink, enabled: boolean): Logger {
	if (!enabled) return noopLogger;
	const logger = createLogger(scope, sink, "debug");
	const wrap = (write: Logger["debug"]): Logger["debug"] => (message, meta) => {
		const safe: LogMeta = {};
		for (const [key, value] of Object.entries(meta ?? {})) {
			if (RUNTIME_FIELDS.has(key) && (value === null || typeof value !== "object")) {
				safe[key] = typeof value === "string" ? redactSecrets(value).slice(0, 160) : value;
			}
		}
		write(redactSecrets(message), Object.keys(safe).length === 0 ? undefined : safe);
	};
	return {
		debug: wrap(logger.debug),
		info: wrap(logger.info),
		warn: wrap(logger.warn),
		error: wrap(logger.error),
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
