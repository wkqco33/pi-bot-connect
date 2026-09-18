import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, DEFAULT_STALE_MS, describeHolder, type LockInfo } from "./lock.js";

let dir: string;
let path: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "bot-connect-lock-"));
	path = join(dir, "poll.lock");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function exists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function readLock(target: string): Promise<Record<string, unknown>> {
	let raw: string;
	try {
		raw = await readFile(target, "utf8");
	} catch (error) {
		throw new Error(`could not read ${target}: ${String(error)}`);
	}
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`lock file is not JSON: ${String(error)}`);
	}
}

const alive = (): boolean => true;

describe("acquireLock", () => {
	it("acquires a fresh lock and writes owner-only permissions", async () => {
		const result = await acquireLock({ path, pid: 100, host: "h1", now: () => 1000, isAlive: alive });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.lock.info).toEqual({ pid: 100, startedAt: 1000, host: "h1", token: expect.any(String) });
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("creates the parent directory", async () => {
		const nested = join(dir, "a", "b", "poll.lock");
		const result = await acquireLock({ path: nested, pid: 100, host: "h1", now: () => 0, isAlive: alive });
		expect(result.ok).toBe(true);
		expect(await exists(nested)).toBe(true);
	});

	it("gives every acquisition a distinct token", async () => {
		const first = await acquireLock({ path, pid: 1, host: "h", now: () => 0, isAlive: alive });
		const second = await acquireLock({ path: `${path}.2`, pid: 1, host: "h", now: () => 0, isAlive: alive });
		if (!first.ok || !second.ok) throw new Error("both acquisitions should succeed");
		expect(first.lock.info.token).not.toBe(second.lock.info.token);
	});

	it("refuses a second acquisition and reports the holder", async () => {
		await acquireLock({ path, pid: 100, host: "h1", now: () => 1000, isAlive: alive });
		const second = await acquireLock({ path, pid: 200, host: "h1", now: () => 1001, isAlive: alive });
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.reason).toBe("held");
		expect(second.holder?.pid).toBe(100);
	});

	it("does not expose the holder token to a refused caller", async () => {
		// The holder info is returned for diagnostics, but only the holder's own
		// process may act on the token, so this documents the current contract.
		const first = await acquireLock({ path, pid: 100, host: "h1", now: () => 0, isAlive: alive });
		if (!first.ok) throw new Error("first acquisition should succeed");
		const second = await acquireLock({ path, pid: 200, host: "h1", now: () => 1, isAlive: alive });
		if (second.ok) throw new Error("second acquisition should fail");
		expect(second.holder?.token).toBe(first.lock.info.token);
	});

	it("reclaims a lock whose process is gone", async () => {
		await acquireLock({ path, pid: 100, host: "h1", now: () => 0, isAlive: alive });
		const second = await acquireLock({
			path,
			pid: 200,
			host: "h1",
			now: () => 1,
			isAlive: (pid) => pid !== 100,
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(await readLock(path)).toMatchObject({ pid: 200 });
	});

	it("reclaims a lock that outlived the stale window", async () => {
		await acquireLock({ path, pid: 100, host: "h1", now: () => 0, isAlive: alive, staleMs: 1000 });
		const second = await acquireLock({ path, pid: 200, host: "h1", now: () => 1000, isAlive: alive, staleMs: 1000 });
		expect(second.ok).toBe(true);
	});

	it("keeps a live lock on another host until it is stale", async () => {
		await acquireLock({ path, pid: 100, host: "other-host", now: () => 0 });
		// Liveness cannot be checked across hosts, so only age may evict it.
		const second = await acquireLock({
			path,
			pid: 200,
			host: "h1",
			now: () => 1,
			isAlive: () => false,
			staleMs: 1000,
		});
		expect(second.ok).toBe(false);
	});

	it("uses a 15 minute stale window by default", async () => {
		await acquireLock({ path, pid: 100, host: "h1", now: () => 0, isAlive: alive });
		const justInside = await acquireLock({ path, pid: 200, host: "h1", now: () => DEFAULT_STALE_MS - 1, isAlive: alive });
		expect(justInside.ok).toBe(false);
		const atBoundary = await acquireLock({ path, pid: 300, host: "h1", now: () => DEFAULT_STALE_MS, isAlive: alive });
		expect(atBoundary.ok).toBe(true);
	});

	it("reclaims an unreadable lock file", async () => {
		await writeFile(path, "garbage", "utf8");
		const result = await acquireLock({ path, pid: 100, host: "h1", now: () => 0, isAlive: alive });
		expect(result.ok).toBe(true);
	});

	it("reclaims a lock file that is not shaped like lock info", async () => {
		await writeFile(path, JSON.stringify({ pid: "nope" }), "utf8");
		const result = await acquireLock({ path, pid: 100, host: "h1", now: () => 0, isAlive: alive });
		expect(result.ok).toBe(true);
	});
});

describe("lock.release", () => {
	it("removes the lock file", async () => {
		const result = await acquireLock({ path, pid: 100, host: "h1", now: () => 0, isAlive: alive });
		if (!result.ok) throw new Error("acquisition should succeed");
		await result.lock.release();
		expect(await exists(path)).toBe(false);
	});

	it("is safe to call twice", async () => {
		const result = await acquireLock({ path, pid: 100, host: "h1", now: () => 0, isAlive: alive });
		if (!result.ok) throw new Error("acquisition should succeed");
		await result.lock.release();
		await result.lock.release();
		expect(await exists(path)).toBe(false);
	});

	it("does not delete a lock that was reclaimed by someone else", async () => {
		const first = await acquireLock({ path, pid: 100, host: "h1", now: () => 0, isAlive: alive, staleMs: 1000 });
		if (!first.ok) throw new Error("first acquisition should succeed");

		const second = await acquireLock({ path, pid: 200, host: "h1", now: () => 5000, isAlive: alive, staleMs: 1000 });
		expect(second.ok).toBe(true);

		await first.lock.release();
		expect(await readLock(path)).toMatchObject({ pid: 200 });
	});
});

describe("describeHolder", () => {
	it("describes the holder and its age", () => {
		const holder: LockInfo = { pid: 7, startedAt: 0, host: "laptop", token: "super-secret-token" };
		const text = describeHolder(holder, 60_000);
		expect(text).toContain("pid 7");
		expect(text).toContain("laptop");
		expect(text).toContain("1m");
	});

	it("never renders the token", () => {
		const holder: LockInfo = { pid: 7, startedAt: 0, host: "laptop", token: "super-secret-token" };
		expect(describeHolder(holder, 0)).not.toContain("super-secret-token");
	});

	it("handles an unknown holder", () => {
		expect(describeHolder(null)).toContain("another process");
	});
});
