/**
 * Single-instance lock for polling transports.
 *
 * Every messenger this bridge talks to allows exactly one live consumer per
 * credential: Telegram `getUpdates` returns 409, and Discord closes the older
 * gateway session. Two pi processes in two terminals is a normal thing to do,
 * so without this lock remote messages land in an unpredictable process.
 *
 * Design notes:
 *  - claim with an exclusive hard link from a complete owner file
 *  - a holder is only evicted when it is provably gone (pid dead on this host)
 *    or (on a foreign host where pid liveness cannot be checked) older than `staleMs`
 *  - release is token-checked, so a reclaimed lock is not deleted by its
 *    previous owner
 *
 * This module is I/O and lives outside `src/core/`.
 */

import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hostname as osHostname } from "node:os";
import { noopLogger, type Logger } from "./core/types.js";

export interface LockInfo {
	readonly pid: number;
	readonly startedAt: number;
	readonly host: string;
	/** Random per-acquisition token, used to make release safe. */
	readonly token: string;
}

export interface LockHandle {
	readonly path: string;
	readonly info: LockInfo;
	release(): Promise<void>;
}

export type AcquireResult =
	| { readonly ok: true; readonly lock: LockHandle }
	| { readonly ok: false; readonly reason: "held"; readonly holder: LockInfo | null };

/**
 * Raised by a transport that lost the race for a bot credential.
 *
 * It carries the holder instead of a paragraph of prose, so the bridge (which
 * never imports this module) can decide how to tell the operator. `name` is the
 * contract the core classifies on: see `core/start-failure.ts`.
 */
export class LockHeldError extends Error {
	readonly holder: LockInfo | null;
	/** Kept for diagnostics only: it names the credential's bot id. */
	readonly lockPath: string;

	constructor(path: string, holder: LockInfo | null) {
		// The lock path is deliberately absent from the message.
		super(`lock held by ${describeHolder(holder)}`);
		this.name = "LockHeldError";
		this.holder = holder;
		this.lockPath = path;
	}
}

export interface AcquireOptions {
	readonly path: string;
	/** A lock older than this is reclaimed even if the pid looks alive. */
	readonly staleMs?: number;
	readonly now?: () => number;
	readonly pid?: number;
	readonly host?: string;
	/** Injected in tests. Defaults to a signal-0 liveness probe. */
	readonly isAlive?: (pid: number) => boolean;
	readonly logger?: Logger;
}

export const DEFAULT_STALE_MS = 15 * 60 * 1000;

function defaultIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isLockInfo(value: unknown): value is LockInfo {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.pid === "number" &&
		Number.isInteger(record.pid) &&
		typeof record.startedAt === "number" &&
		typeof record.host === "string" &&
		typeof record.token === "string"
	);
}

async function readHolder(path: string): Promise<LockInfo | null | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		try {
			const parsed = JSON.parse(raw) as unknown;
			return isLockInfo(parsed) ? parsed : null;
		} catch {
			return null;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Serializes reclamation of a particular owner so a second reaper can't unlink its successor. */
async function reclaimLock(options: AcquireOptions, holder: LockInfo | null): Promise<boolean> {
	const id = createHash("sha256").update(basename(options.path)).update("\0").update(holder?.token ?? "invalid").digest("hex");
	const guard = await acquireLock({ ...options, path: join(dirname(options.path), `.pi-lock-reclaim-${id}`) });
	if (!guard.ok) return false;
	try {
		const current = await readHolder(options.path);
		if (current !== undefined && current?.token === holder?.token) await removeLockFile(options.path);
		return true;
	} finally {
		await guard.lock.release();
	}
}

export async function acquireLock(options: AcquireOptions): Promise<AcquireResult> {
	const now = options.now ?? Date.now;
	const pid = options.pid ?? process.pid;
	const host = options.host ?? osHostname();
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	const isAlive = options.isAlive ?? defaultIsAlive;
	const logger = options.logger ?? noopLogger;

	await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });

	for (let attempt = 0; attempt < 2; attempt++) {
		const info: LockInfo = { pid, startedAt: now(), host, token: randomUUID() };
		const temporary = `${options.path}.claim-${info.token}`;
		try {
			await writeFile(temporary, `${JSON.stringify(info)}\n`, { flag: "wx", mode: 0o600 });
			await link(temporary, options.path);
			let releasing: Promise<void> | undefined;
			return {
				ok: true,
				lock: {
					path: options.path,
					info,
					release(): Promise<void> {
						releasing ??= (async () => {
							const current = await readHolder(options.path);
							if (current?.token === info.token) await removeLockFile(options.path);
						})();
						return releasing;
					},
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		} finally {
			await removeLockFile(temporary).catch((error: unknown) => {
				logger.warn("could not clean up lock candidate", { error: String(error) });
			});
		}

		const holder = await readHolder(options.path);
		if (holder === undefined) continue;
		if (holder === null) {
			// Unreadable or corrupt: the writer crashed mid-write. Recovering is
			// safer than blocking the user forever on a file only we create.
			logger.warn("reclaiming unreadable lock file", { path: options.path });
			if (!(await reclaimLock(options, holder))) return { ok: false, reason: "held", holder };
			continue;
		}

		const sameHost = holder.host === host;
		const alive = sameHost ? isAlive(holder.pid) : true;
		const tooOld = now() - holder.startedAt >= staleMs;
		// On the same host we can verify PID liveness directly; never evict a live
		// local session just because it has been running longer than `staleMs`.
		if (sameHost ? alive : !tooOld) return { ok: false, reason: "held", holder };

		logger.warn("reclaiming stale lock file", {
			path: options.path,
			holderPid: holder.pid,
			sameHost,
			tooOld,
		});
		if (!(await reclaimLock(options, holder))) return { ok: false, reason: "held", holder };
	}

	const holder = await readHolder(options.path);
	return { ok: false, reason: "held", holder: holder ?? null };
}

async function removeLockFile(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** Renders a held-lock explanation. Never includes the token. */
export function describeHolder(holder: LockInfo | null, now = Date.now()): string {
	if (holder === null) return "another process holds the lock";
	const ageMinutes = Math.max(0, Math.round((now - holder.startedAt) / 60_000));
	return `pid ${holder.pid} on ${holder.host} (held for ${ageMinutes}m)`;
}
