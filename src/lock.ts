/**
 * Single-instance lock for polling transports.
 *
 * Every messenger this bridge talks to allows exactly one live consumer per
 * credential: Telegram `getUpdates` returns 409, and Discord closes the older
 * gateway session. Two pi processes in two terminals is a normal thing to do,
 * so without this lock remote messages land in an unpredictable process.
 *
 * Design notes:
 *  - claim with `O_EXCL` so two processes cannot both win
 *  - a holder is only evicted when it is provably gone (pid dead on this host)
 *    or older than `staleMs`
 *  - release is token-checked, so a reclaimed lock is not deleted by its
 *    previous owner
 *
 * This module is I/O and lives outside `src/core/`.
 */

import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
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

function randomToken(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

async function readHolder(path: string): Promise<LockInfo | null> {
	try {
		const raw = await readFile(path, "utf8");
		try {
			const parsed = JSON.parse(raw) as unknown;
			return isLockInfo(parsed) ? parsed : null;
		} catch {
			return null;
		}
	} catch {
		return null;
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
		const info: LockInfo = { pid, startedAt: now(), host, token: randomToken() };
		try {
			const handle = await open(options.path, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(info)}\n`, "utf8");
				await handle.chmod(0o600);
			} finally {
				await handle.close();
			}
			return {
				ok: true,
				lock: {
					path: options.path,
					info,
					async release(): Promise<void> {
						const current = await readHolder(options.path);
						if (current?.token !== info.token) return;
						await unlink(options.path).catch(() => {});
					},
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		const holder = await readHolder(options.path);
		if (holder === null) {
			// Unreadable or corrupt: the writer crashed mid-write. Recovering is
			// safer than blocking the user forever on a file only we create.
			logger.warn("reclaiming unreadable lock file", { path: options.path });
			await unlink(options.path).catch(() => {});
			continue;
		}

		const sameHost = holder.host === host;
		const alive = sameHost ? isAlive(holder.pid) : true;
		const tooOld = now() - holder.startedAt >= staleMs;
		if (alive && !tooOld) return { ok: false, reason: "held", holder };

		logger.warn("reclaiming stale lock file", {
			path: options.path,
			holderPid: holder.pid,
			sameHost,
			tooOld,
		});
		await unlink(options.path).catch(() => {});
	}

	const holder = await readHolder(options.path);
	return { ok: false, reason: "held", holder };
}

/** Renders a held-lock explanation. Never includes the token. */
export function describeHolder(holder: LockInfo | null, now = Date.now()): string {
	if (holder === null) return "another process holds the lock";
	const ageMinutes = Math.max(0, Math.round((now - holder.startedAt) / 60_000));
	return `pid ${holder.pid} on ${holder.host} (held for ${ageMinutes}m)`;
}
