/**
 * Why a transport did not start, and how the operator should hear about it.
 *
 * Two very different situations looked identical before: a credential the user
 * has to fix, and a credential another pi process legitimately owns. The second
 * one is not an error — it is a standby state — and telling them apart keeps the
 * second terminal from showing a red wall of text on every start.
 *
 * The classification is structural (`name` plus a `holder` shape) so the core
 * still does not import the file-system lock module.
 */

import { redactSecrets } from "./redact.js";

/** Matches the `name` of `LockHeldError` in `src/lock.ts`. */
export const LOCK_HELD_ERROR_NAME = "LockHeldError";

/** Upper bound for a one-line failure notice. Notifications must not flood the TUI. */
export const MAX_FAILURE_NOTICE_LENGTH = 160;

export interface LockHolder {
	readonly pid: number;
	readonly host: string;
}

export type StartFailure =
	| { readonly kind: "standby"; readonly holder: LockHolder | null }
	| { readonly kind: "error"; readonly detail: string };

function holderOf(error: unknown): LockHolder | null {
	if (typeof error !== "object" || error === null) return null;
	const raw = (error as { holder?: unknown }).holder;
	if (typeof raw !== "object" || raw === null) return null;
	const { pid, host } = raw as Record<string, unknown>;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
	if (typeof host !== "string" || host.length === 0) return null;
	return { pid, host };
}

/**
 * One line, redacted, bounded. A startup failure can carry a URL with a token or
 * a stack trace, and it ends up in a notification and in `/connect doctor`.
 */
export function boundFailureMessage(message: string): string {
	const flat = redactSecrets(message).replace(/\s+/g, " ").trim();
	if (flat.length <= MAX_FAILURE_NOTICE_LENGTH) return flat;
	return `${flat.slice(0, MAX_FAILURE_NOTICE_LENGTH - 1).trimEnd()}…`;
}

export function classifyStartFailure(error: unknown): StartFailure {
	const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
	if (name === LOCK_HELD_ERROR_NAME) return { kind: "standby", holder: holderOf(error) };
	const message = error instanceof Error ? error.message : String(error);
	return { kind: "error", detail: boundFailureMessage(message) };
}

function who(holder: LockHolder | null): string {
	return holder === null ? "another pi process" : `pid ${holder.pid} on ${holder.host}`;
}

/** Short enough to survive a TUI notification without swallowing the screen. */
export function standbyNotice(transportId: string, holder: LockHolder | null): string {
	return `${transportId}: standby — ${who(holder)} owns this bot`;
}

/** `/connect doctor` detail: the same fact plus when we will try again. */
export function standbyDetail(holder: LockHolder | null, retryMs: number): string {
	return `${who(holder)} owns this bot; retrying every ${formatCadence(retryMs)}`;
}

export function startFailureNotice(transportId: string, detail: string): string {
	return `${transportId} failed to start: ${detail}`;
}

/** Sent once when a standby transport finally earns the credential. */
export function takeoverNotice(transportId: string): string {
	return `${transportId}: took over from the previous pi process`;
}

function formatCadence(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}
