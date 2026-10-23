/**
 * Durable `BridgeStore` backed by a single JSON file.
 *
 * Why: trust, pending challenges and broadcast targets used to live only in
 * memory, so every `/reload` or pi restart forced the user to pair again.
 *
 * State is scoped per session id: pairing with one live session must not grant a
 * chat broadcast rights on another. `pi --continue` keeps the same session id,
 * which is why trust survives a restart. The file shape is documented in
 * `docs/architecture.md` §7.
 *
 * This module is I/O, so it lives outside `src/core/`. Validation of the file
 * contents is pure (`parseStoreSnapshot`) and unit-tested.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { BridgeStore, ConversationTarget } from "./bridge.js";
import type { PendingChallenge } from "./core/pairing.js";
import { noopLogger, type Logger } from "./core/types.js";

export const STORE_VERSION = 1;
export const DEFAULT_MAX_SESSIONS = 20;

export interface SessionState {
	readonly trusted: Record<string, number>;
	readonly pending: Record<string, PendingChallenge>;
	readonly paused: readonly string[];
	readonly conversations: readonly ConversationTarget[];
	readonly updatedAt: number;
}

export interface StoreSnapshot {
	readonly version: number;
	readonly sessions: Record<string, SessionState>;
}

export function emptySessionState(now = 0): SessionState {
	return { trusted: {}, pending: {}, paused: [], conversations: [], updatedAt: now };
}

export interface ParseSnapshotResult {
	readonly snapshot: StoreSnapshot;
	readonly warnings: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTrusted(raw: unknown, path: string, warnings: string[]): Record<string, number> {
	const trusted: Record<string, number> = {};
	if (raw === undefined) return trusted;
	if (!isRecord(raw)) {
		warnings.push(`${path}.trusted: expected an object, ignored`);
		return trusted;
	}
	for (const [identity, value] of Object.entries(raw)) {
		if (typeof value === "number" && Number.isFinite(value)) trusted[identity] = value;
		else warnings.push(`${path}.trusted.${identity}: expected a timestamp, ignored`);
	}
	return trusted;
}

function parsePending(raw: unknown, path: string, warnings: string[]): Record<string, PendingChallenge> {
	const pending: Record<string, PendingChallenge> = {};
	if (raw === undefined) return pending;
	if (!isRecord(raw)) {
		warnings.push(`${path}.pending: expected an object, ignored`);
		return pending;
	}
	for (const [key, value] of Object.entries(raw)) {
		if (
			isRecord(value) &&
			typeof value.code === "string" &&
			value.code.length > 0 &&
			typeof value.expiresAt === "number" &&
			Number.isFinite(value.expiresAt) &&
			typeof value.attempts === "number" &&
			Number.isInteger(value.attempts)
		) {
			pending[key] = { code: value.code, expiresAt: value.expiresAt, attempts: value.attempts };
		} else {
			warnings.push(`${path}.pending.${key}: malformed challenge, ignored`);
		}
	}
	return pending;
}

function parseStringArray(raw: unknown, path: string, warnings: string[]): string[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
		warnings.push(`${path}: expected an array of strings, ignored`);
		return [];
	}
	return raw as string[];
}

function parseConversations(raw: unknown, path: string, warnings: string[]): ConversationTarget[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		warnings.push(`${path}.conversations: expected an array, ignored`);
		return [];
	}
	const conversations: ConversationTarget[] = [];
	for (const [index, entry] of raw.entries()) {
		if (
			isRecord(entry) &&
			typeof entry.transport === "string" &&
			entry.transport.length > 0 &&
			typeof entry.conversationId === "string" &&
			entry.conversationId.length > 0
		) {
			conversations.push({
				transport: entry.transport,
				conversationId: entry.conversationId,
				...(typeof entry.threadId === "string" ? { threadId: entry.threadId } : {}),
			});
		} else {
			warnings.push(`${path}.conversations[${index}]: malformed target, ignored`);
		}
	}
	return conversations;
}

function parseSessionState(raw: unknown, path: string, warnings: string[]): SessionState {
	if (!isRecord(raw)) {
		warnings.push(`${path}: expected an object, ignored`);
		return emptySessionState();
	}
	const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
	return {
		trusted: parseTrusted(raw.trusted, path, warnings),
		pending: parsePending(raw.pending, path, warnings),
		paused: parseStringArray(raw.paused, `${path}.paused`, warnings),
		conversations: parseConversations(raw.conversations, path, warnings),
		updatedAt,
	};
}

/**
 * Validates an untrusted store file. Unknown or malformed entries are dropped
 * with a warning instead of failing: losing a pairing is recoverable, crashing
 * pi on startup is not.
 */
export function parseStoreSnapshot(input: unknown): ParseSnapshotResult {
	const warnings: string[] = [];

	if (!isRecord(input)) {
		return { snapshot: { version: STORE_VERSION, sessions: {} }, warnings: ["store file: expected an object"] };
	}

	const version = typeof input.version === "number" ? input.version : STORE_VERSION;
	if (version !== STORE_VERSION) {
		warnings.push(`store file: unsupported version ${version}, starting empty`);
		return { snapshot: { version: STORE_VERSION, sessions: {} }, warnings };
	}

	const sessions: Record<string, SessionState> = {};
	if (input.sessions !== undefined) {
		if (!isRecord(input.sessions)) {
			warnings.push("store file: 'sessions' must be an object, starting empty");
		} else {
			for (const [sessionId, value] of Object.entries(input.sessions)) {
				sessions[sessionId] = parseSessionState(value, `sessions.${sessionId}`, warnings);
			}
		}
	}

	return { snapshot: { version: STORE_VERSION, sessions }, warnings };
}

export interface FileBridgeStoreOptions {
	readonly path: string;
	readonly sessionId: string;
	readonly logger?: Logger;
	/** Emitted only when durable writes change from healthy to failed or back. */
	readonly onPersistenceChange?: (healthy: boolean) => void;
	/** Older sessions beyond this count are pruned on write. */
	readonly maxSessions?: number;
	/** Injected for determinism in tests. */
	readonly now?: () => number;
}

/**
 * One write queue per state file, shared by every store in this process.
 *
 * Two live stores (a `/reload` overlap, or a future multi-session broker) would
 * otherwise interleave read-merge-write and drop each other's sessions. Separate
 * processes cannot share this queue, so their writes stay last-writer-wins;
 * `mergeForeignSessions` is what keeps that from erasing another session.
 */
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(path: string, task: () => Promise<void>): Promise<void> {
	const previous = writeQueues.get(path) ?? Promise.resolve();
	// `then(task, task)`: a failed write must not block the next one.
	const next = previous.then(task, task);
	const settled = next.catch(() => undefined);
	writeQueues.set(path, settled);
	void settled.then(() => {
		if (writeQueues.get(path) === settled) writeQueues.delete(path);
	});
	return next;
}

export class FileBridgeStore implements BridgeStore {
	private readonly path: string;
	private readonly sessionId: string;
	private readonly logger: Logger;
	private readonly maxSessions: number;
	private readonly now: () => number;
	private readonly onPersistenceChange: ((healthy: boolean) => void) | undefined;
	private failedWrite = false;

	private readonly all: Record<string, SessionState>;
	/** Makes this instance's temp file unique, even against a sibling in-process store. */
	private readonly writeId = randomUUID();
	private queue: Promise<void> = Promise.resolve();
	private dirty = false;

	private constructor(options: FileBridgeStoreOptions, all: Record<string, SessionState>) {
		this.path = options.path;
		this.sessionId = options.sessionId;
		this.logger = options.logger ?? noopLogger;
		this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
		this.now = options.now ?? Date.now;
		this.onPersistenceChange = options.onPersistenceChange;
		this.all = all;
	}

	static async open(options: FileBridgeStoreOptions): Promise<FileBridgeStore> {
		const logger = options.logger ?? noopLogger;
		let all: Record<string, SessionState> = {};

		try {
			const raw = await readFile(options.path, "utf8");
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw) as unknown;
			} catch (error) {
				logger.warn("store file is not valid JSON, starting empty", { error: String(error) });
				parsed = undefined;
			}
			if (parsed !== undefined) {
				const result = parseStoreSnapshot(parsed);
				all = result.snapshot.sessions;
				for (const warning of result.warnings) logger.warn("store file dropped an entry", { warning });
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		const store = new FileBridgeStore(options, all);
		if (!store.all[options.sessionId]) store.all[options.sessionId] = emptySessionState(store.now());
		store.schedule();
		return store;
	}

	get writeFailed(): boolean {
		return this.failedWrite;
	}

	/** Waits until every scheduled write has landed. Call on shutdown. */
	async flush(): Promise<void> {
		await this.queue;
	}

	private state(): SessionState {
		const existing = this.all[this.sessionId];
		if (existing) return existing;
		const created = emptySessionState(this.now());
		this.all[this.sessionId] = created;
		return created;
	}

	private update(patch: Partial<SessionState>, schedule = true): void {
		const current = this.state();
		this.all[this.sessionId] = { ...current, ...patch, updatedAt: this.now() };
		if (schedule) this.schedule();
	}

	private schedule(): void {
		this.dirty = true;
		this.queue = this.queue
			.then(async () => {
				if (!this.dirty) return;
				this.dirty = false;
				await this.writeOnce();
				if (this.failedWrite) {
					this.failedWrite = false;
					this.onPersistenceChange?.(true);
				}
			})
			.catch((error: unknown) => {
				this.logger.error("failed to persist bridge state", { error: String(error) });
				if (!this.failedWrite) {
					this.failedWrite = true;
					this.onPersistenceChange?.(false);
				}
			});
	}

	private prune(): void {
		const ids = Object.keys(this.all);
		if (ids.length <= this.maxSessions) return;
		const oldestFirst = ids.sort((a, b) => (this.all[a]?.updatedAt ?? 0) - (this.all[b]?.updatedAt ?? 0));
		for (const id of oldestFirst.slice(0, ids.length - this.maxSessions)) {
			delete this.all[id];
		}
	}

	/**
	 * Two pi processes share one file. Loading once is not enough: the other
	 * process may pair after this one loaded, and a blind rewrite would erase it.
	 * Foreign sessions are adopted when the file's copy is newer; this session's
	 * own state always stays authoritative (last writer wins per session).
	 */
	private async mergeForeignSessions(): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch {
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch (error) {
			this.logger.warn("store file is not valid JSON, writing this session only", { error: String(error) });
			return;
		}

		for (const [sessionId, state] of Object.entries(parseStoreSnapshot(parsed).snapshot.sessions)) {
			if (sessionId === this.sessionId) continue;
			const mine = this.all[sessionId];
			// `>=`: on a timestamp tie the file's copy was persisted later, and this
			// store's copy is the older one. Strict `>` loses same-millisecond updates.
			if (mine === undefined || state.updatedAt >= mine.updatedAt) this.all[sessionId] = state;
		}
	}

	private async writeOnce(): Promise<void> {
		await enqueueWrite(this.path, () => this.writeFileAtomic());
	}

	private async writeFileAtomic(): Promise<void> {
		// Merge inside the queue: the file may have moved on since this store read it.
		await this.mergeForeignSessions();
		this.prune();
		const snapshot: StoreSnapshot = { version: STORE_VERSION, sessions: this.all };
		const data = `${JSON.stringify(snapshot, null, "\t")}\n`;
		const directory = dirname(this.path);
		// pid + instance id: a sibling store in this process must not share it.
		const temporary = `${this.path}.tmp-${process.pid}-${this.writeId}`;

		await mkdir(directory, { recursive: true, mode: 0o700 });

		const handle = await open(temporary, "w", 0o600);
		try {
			await handle.writeFile(data, "utf8");
			await handle.chmod(0o600);
		} finally {
			await handle.close();
		}

		try {
			await rename(temporary, this.path);
		} catch (error) {
			await unlink(temporary).catch(() => {});
			throw error;
		}
	}

	// --- BridgeStore ---------------------------------------------------------

	isTrusted(identity: string): boolean {
		return Object.prototype.hasOwnProperty.call(this.state().trusted, identity);
	}

	trust(identity: string, at: number): void {
		this.update({ trusted: { ...this.state().trusted, [identity]: at } });
	}

	revoke(identity: string): void {
		const trusted = { ...this.state().trusted };
		delete trusted[identity];
		// Pending challenges are keyed by conversation, not by user, so there is
		// nothing to map here; they expire on their own.
		this.update({ trusted });
	}

	pairedAt(identity: string): number | undefined {
		return this.state().trusted[identity];
	}

	listTrusted(): readonly string[] {
		return Object.keys(this.state().trusted);
	}

	getPending(key: string): PendingChallenge | undefined {
		return this.state().pending[key];
	}

	setPending(key: string, pending: PendingChallenge | undefined): void {
		const next = { ...this.state().pending };
		if (pending === undefined) delete next[key];
		else next[key] = pending;
		this.update({ pending: next });
	}

	listPending(): ReadonlyArray<{ readonly key: string; readonly pending: PendingChallenge }> {
		return Object.entries(this.state().pending).map(([key, pending]) => ({ key, pending }));
	}

	isPaused(key: string): boolean {
		return this.state().paused.includes(key);
	}

	setPaused(key: string, paused: boolean): void {
		const current = this.state().paused;
		const next = paused ? [...new Set([...current, key])] : current.filter((entry) => entry !== key);
		this.update({ paused: next });
	}

	rememberConversation(target: ConversationTarget): void {
		const current = this.state().conversations;
		const same = (a: ConversationTarget, b: ConversationTarget): boolean =>
			a.transport === b.transport && a.conversationId === b.conversationId && (a.threadId ?? "") === (b.threadId ?? "");
		if (current.some((entry) => same(entry, target))) return;
		this.update({ conversations: [...current, target] });
	}

	listConversations(): readonly ConversationTarget[] {
		return this.state().conversations;
	}
}
