/**
 * The bridge: binds transports to the routing core and to a pi session.
 *
 * It owns no platform code. Everything platform-specific lives behind the
 * `Transport` contract; everything session-specific lives behind `BridgeHost`.
 * That is what makes the whole thing testable with `FakeTransport`.
 */

import { executeRemoteCommand, type RemoteCommandContext } from "./core/commands.js";
import { capChunkCount, chunkForTransport } from "./core/chunk.js";
import { chunkMarkdown } from "./core/markdown-blocks.js";
import { renderMarkdown } from "./core/markdown.js";
import {
	ATTACHMENTS_UNSUPPORTED_NOTICE,
	ATTACHMENT_FETCH_FAILED_NOTICE,
	ATTACHMENT_NOT_AN_IMAGE_NOTICE,
	ATTACHMENT_TOO_LARGE_NOTICE,
	ATTACHMENT_TOO_MANY_NOTICE,
	PAUSED_NOTICE,
	truncatedNotice,
	unknownCommandNotice,
} from "./core/notices.js";
import { isFreshChallenge, pairingCodeNotice, pairingPrompt, pairingSuccessPrompt, type PendingChallenge } from "./core/pairing.js";
import { thinkingLabel } from "./core/progress.js";
import { redactSecrets } from "./core/redact.js";
import { route, type UnsupportedFeature } from "./core/router.js";
import {
	conversationKey,
	identityKey,
	resolveConfig,
	type AttachmentPolicy,
	type BridgeConfig,
	type Envelope,
	type FetchedAttachment,
	type Logger,
	type OutboundKind,
	type PromptImage,
	type PromptOptions,
	type SendReceipt,
	type Transport,
	type TransportDiagnostics,
	type TransportId,
} from "./core/types.js";

export interface ConversationTarget {
	readonly transport: TransportId;
	readonly conversationId: string;
	readonly threadId?: string;
}

export interface SendRequest extends ConversationTarget {
	readonly kind: OutboundKind;
	readonly text: string;
	/** Update an existing message instead of posting a new one. */
	readonly editKey?: string;
}

export interface BridgeSnapshot {
	readonly transports: readonly TransportId[];
	readonly trusted: readonly string[];
	readonly paused: readonly string[];
	readonly pending: ReadonlyArray<{ readonly key: string; readonly code: string; readonly expiresAt: number }>;
	readonly conversations: number;
}

export interface BridgeStore {
	isTrusted(identity: string): boolean;
	trust(identity: string, at: number): void;
	revoke(identity: string): void;
	pairedAt(identity: string): number | undefined;
	listTrusted(): readonly string[];

	getPending(key: string): PendingChallenge | undefined;
	setPending(key: string, pending: PendingChallenge | undefined): void;
	listPending(): ReadonlyArray<{ readonly key: string; readonly pending: PendingChallenge }>;

	isPaused(key: string): boolean;
	setPaused(key: string, paused: boolean): void;

	rememberConversation(target: ConversationTarget): void;
	listConversations(): readonly ConversationTarget[];
}

export class MemoryBridgeStore implements BridgeStore {
	private readonly trusted = new Map<string, number>();
	private readonly pending = new Map<string, PendingChallenge>();
	private readonly paused = new Set<string>();
	private readonly conversations = new Map<string, ConversationTarget>();

	isTrusted(identity: string): boolean {
		return this.trusted.has(identity);
	}

	trust(identity: string, at: number): void {
		this.trusted.set(identity, at);
	}

	revoke(identity: string): void {
		this.trusted.delete(identity);
	}

	pairedAt(identity: string): number | undefined {
		return this.trusted.get(identity);
	}

	listTrusted(): readonly string[] {
		return [...this.trusted.keys()];
	}

	getPending(key: string): PendingChallenge | undefined {
		return this.pending.get(key);
	}

	setPending(key: string, pending: PendingChallenge | undefined): void {
		if (pending === undefined) this.pending.delete(key);
		else this.pending.set(key, pending);
	}

	listPending(): ReadonlyArray<{ readonly key: string; readonly pending: PendingChallenge }> {
		return [...this.pending.entries()].map(([key, pending]) => ({ key, pending }));
	}

	isPaused(key: string): boolean {
		return this.paused.has(key);
	}

	setPaused(key: string, paused: boolean): void {
		if (paused) this.paused.add(key);
		else this.paused.delete(key);
	}

	rememberConversation(target: ConversationTarget): void {
		this.conversations.set(`${target.transport}:${target.conversationId}:${target.threadId ?? ""}`, target);
	}

	listConversations(): readonly ConversationTarget[] {
		return [...this.conversations.values()];
	}
}

/** Everything the bridge needs from the pi session, without importing pi. */
export interface BridgeHost {
	sendPrompt(text: string, options?: PromptOptions): void;
	abort(): void;
	isIdle(): boolean;
	notify(text: string, level?: "info" | "warning" | "error"): void;
	/** False until the host can forward attachment bytes to the model. */
	readonly acceptsAttachments: boolean;
	readonly cwd: string;
	readonly sessionName?: string;
	now(): number;
	random(): number;
	readonly logger: Logger;
}

/** Renders a router `unsupported` action for the user. */
const UNSUPPORTED_NOTICES: Record<UnsupportedFeature, string> = {
	attachments: ATTACHMENTS_UNSUPPORTED_NOTICE,
	"attachment-not-image": ATTACHMENT_NOT_AN_IMAGE_NOTICE,
	"attachment-too-large": ATTACHMENT_TOO_LARGE_NOTICE,
	"attachment-too-many": ATTACHMENT_TOO_MANY_NOTICE,
};

export interface BridgeOptions {
	readonly host: BridgeHost;
	readonly config?: Partial<BridgeConfig>;
	readonly store?: BridgeStore;
}

export class Bridge {
	readonly config: BridgeConfig;
	readonly store: BridgeStore;

	private readonly host: BridgeHost;
	private readonly transports = new Map<TransportId, Transport>();
	private readonly startErrors = new Map<TransportId, string>();
	/** Conversation key to the message id of the current turn's progress card. */
	private readonly progressKeys = new Map<string, string>();
	private lastProgressAt = Number.NEGATIVE_INFINITY;

	constructor(options: BridgeOptions) {
		this.host = options.host;
		this.config = resolveConfig(options.config);
		this.store = options.store ?? new MemoryBridgeStore();
	}

	/** Registers and starts a transport. */
	/**
	 * Registers and starts a transport.
	 *
	 * A transport that fails to start is recorded, not thrown: a bad token must
	 * not tear down the session or block other transports. `/connect doctor`
	 * surfaces the reason.
	 */
	async register(transport: Transport): Promise<void> {
		if (this.transports.has(transport.id)) {
			throw new Error(`Transport '${transport.id}' is already registered`);
		}
		this.transports.set(transport.id, transport);
		try {
			await transport.start((envelope) => this.onEnvelope(envelope));
			this.startErrors.delete(transport.id);
			this.host.logger.info("transport started", { transport: transport.id });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.startErrors.set(transport.id, message);
			this.host.logger.error("transport failed to start", { transport: transport.id, error: message });
			this.host.notify(`${transport.id} failed to start: ${message}`, "error");
		}
	}

	async stop(): Promise<void> {
		for (const transport of this.transports.values()) {
			try {
				await transport.stop();
			} catch (error) {
				this.host.logger.warn("transport failed to stop", {
					transport: transport.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		this.transports.clear();
	}

	/** Health view for `/connect doctor`. Never contains secrets. */
	diagnostics(): readonly TransportDiagnostics[] {
		return [...this.transports.values()].map((transport) => {
			const error = this.startErrors.get(transport.id);
			const detail = error ?? transport.diagnose?.();
			return {
				id: transport.id,
				status: error !== undefined ? "error" : "running",
				...(detail === undefined ? {} : { detail }),
			};
		});
	}

	get transportIds(): readonly TransportId[] {
		return [...this.transports.keys()];
	}

	async onEnvelope(envelope: Envelope): Promise<void> {
		const identity = identityKey(envelope.transport, envelope.userId);
		const key = conversationKey(envelope);
		const authenticated = this.isAuthenticated(identity);

		const actions = route({
			envelope,
			config: this.config,
			authenticated,
			pendingChallenge: this.store.getPending(key),
			busy: !this.host.isIdle(),
			attachmentPolicy: this.attachmentPolicy(envelope.transport),
			now: this.host.now(),
			random: () => this.host.random(),
		});

		for (const action of actions) {
			await this.applyAction(action, envelope, identity, key);
		}
	}

	/**
	 * Attachment acceptance is a *pair* of capabilities: the host must be able to
	 * give the model image content, and this transport must be able to produce the
	 * bytes. Either one missing means the message is refused, not guessed at.
	 */
	private attachmentPolicy(transportId: TransportId): AttachmentPolicy {
		const transport = this.transports.get(transportId);
		return {
			accepts: this.host.acceptsAttachments && transport?.fetchAttachment !== undefined,
			allowedMediaTypes: this.config.attachments.allowedMediaTypes,
			maxCount: this.config.attachments.maxCount,
			maxBytes: this.config.attachments.maxBytes,
		};
	}

	private isAuthenticated(identity: string): boolean {
		if (this.config.allowUsers.includes(identity)) return true;
		if (!this.config.requirePairing) return true;
		return this.store.isTrusted(identity);
	}

	private async applyAction(
		action: ReturnType<typeof route>[number],
		envelope: Envelope,
		identity: string,
		key: string,
	): Promise<void> {
		if (action.type === "ignore") {
			this.host.logger.debug("ignored message", { reason: action.reason, transport: envelope.transport });
			return;
		}

		if (action.type === "pair") {
			this.store.trust(identity, this.host.now());
			this.store.setPending(key, undefined);
			this.remember(envelope);
			this.host.notify(`Paired ${identity}`, "info");
			await this.reply(envelope, pairingSuccessPrompt(identity, this.config.localCommand));
			return;
		}

		if (action.type === "pair-required") {
			this.store.setPending(key, action.pending);
			// The code belongs in the terminal, never in the chat that must prove itself.
			if (isFreshChallenge(action.reason)) {
				this.host.notify(pairingCodeNotice(action.pending, { ttlMs: this.config.pairingTtlMs }), "info");
			}
			await this.reply(
				envelope,
				pairingPrompt(action.pending, action.reason, {
					digits: action.pending.code.length,
					maxAttempts: this.config.pairingMaxAttempts,
					commandName: this.config.localCommand,
				}),
			);
			return;
		}

		this.remember(envelope);

		if (action.type === "unsupported") {
			await this.reply(envelope, UNSUPPORTED_NOTICES[action.feature]);
			return;
		}

		if (action.type === "command") {
			await this.runCommand(action.name, action.args, envelope, identity, key);
			return;
		}

		if (this.store.isPaused(key)) {
			await this.reply(envelope, PAUSED_NOTICE);
			return;
		}

		await this.forwardPrompt(action, envelope);
	}

	/** Downloads any attachments, then hands the prompt to the session. */
	private async forwardPrompt(
		action: Extract<ReturnType<typeof route>[number], { type: "prompt" }>,
		envelope: Envelope,
	): Promise<void> {
		const attachments = action.attachments ?? [];
		let images: PromptImage[] | undefined;

		if (attachments.length > 0) {
			const transport = this.transports.get(envelope.transport);
			const fetchAttachment = transport?.fetchAttachment?.bind(transport);
			if (fetchAttachment === undefined) {
				await this.reply(envelope, UNSUPPORTED_NOTICES.attachments);
				return;
			}

			const fetched: PromptImage[] = [];
			for (const attachment of attachments) {
				let result: FetchedAttachment;
				try {
					result = await fetchAttachment(attachment);
				} catch (error) {
					this.host.logger.warn("attachment download failed", { error: String(error) });
					await this.reply(envelope, ATTACHMENT_FETCH_FAILED_NOTICE);
					return;
				}
				// The declared media type is a hint; the transport reports what was
				// actually served. Re-check the real type before the model sees it.
				if (!this.config.attachments.allowedMediaTypes.includes(result.mediaType)) {
					this.host.logger.warn("attachment rejected after download", { mediaType: result.mediaType });
					await this.reply(envelope, ATTACHMENT_NOT_AN_IMAGE_NOTICE);
					return;
				}
				// Base64 is 4/3 of the byte length. Re-checked here because the size the
				// messenger declared is a hint, not a guarantee.
				if (Math.ceil((result.data.length * 3) / 4) > this.config.attachments.maxBytes) {
					await this.reply(envelope, ATTACHMENT_TOO_LARGE_NOTICE);
					return;
				}
				fetched.push({ mediaType: result.mediaType, data: result.data });
			}
			if (fetched.length > 0) images = fetched;
		}

		const options: PromptOptions = {
			...(action.deliverAs === undefined ? {} : { deliverAs: action.deliverAs }),
			...(images === undefined ? {} : { images }),
		};
		this.host.sendPrompt(action.text, Object.keys(options).length > 0 ? options : undefined);
		await this.notifyTyping({
			transport: envelope.transport,
			conversationId: envelope.conversationId,
			...(envelope.threadId === undefined ? {} : { threadId: envelope.threadId }),
		});
		this.host.logger.info("prompt forwarded", {
			transport: envelope.transport,
			deliverAs: action.deliverAs ?? "immediate",
			images: images?.length ?? 0,
		});
	}

	private async runCommand(
		name: string,
		args: string,
		envelope: Envelope,
		identity: string,
		key: string,
	): Promise<void> {
		const context: RemoteCommandContext = {
			transport: envelope.transport,
			identity,
			conversationId: envelope.conversationId,
			config: this.config,
			sessionName: this.host.sessionName,
			cwd: this.host.cwd,
			busy: !this.host.isIdle(),
			paused: this.store.isPaused(key),
			now: this.host.now(),
			pairedAt: this.store.pairedAt(identity),
		};

		const result = executeRemoteCommand(name, args, context);
		if (!result) {
			await this.reply(envelope, unknownCommandNotice(name));
			return;
		}

		const effect = result.effect;
		if (effect?.type === "pause") this.store.setPaused(key, true);
		if (effect?.type === "resume") this.store.setPaused(key, false);
		if (effect?.type === "abort") this.host.abort();
		if (effect?.type === "disconnect") {
			this.store.revoke(identity);
			this.store.setPaused(key, false);
			this.store.setPending(key, undefined);
		}

		await this.reply(envelope, result.text);
	}

	private remember(envelope: Envelope): void {
		const target: ConversationTarget = {
			transport: envelope.transport,
			conversationId: envelope.conversationId,
			...(envelope.threadId === undefined ? {} : { threadId: envelope.threadId }),
		};
		this.store.rememberConversation(target);
	}

	private async reply(envelope: Envelope, text: string): Promise<void> {
		await this.send({
			transport: envelope.transport,
			conversationId: envelope.conversationId,
			kind: "reply",
			text,
			...(envelope.threadId === undefined ? {} : { threadId: envelope.threadId }),
		});
	}

	/** Sends text to one conversation, rendering and chunking for that transport. */
	async send(request: SendRequest): Promise<SendReceipt | null> {
		const transport = this.transports.get(request.transport);
		if (!transport) {
			this.host.logger.warn("cannot send: transport not registered", { transport: request.transport });
			return null;
		}

		const capabilities = transport.capabilities;
		// Structure-aware split first: it has to see the CommonMark source, because
		// transports that rewrite headings (`<b>`, `*`) would hide them. The
		// limit-safe chunker then stays the hard guarantee for whatever rendering
		// does to the size (html escaping grows, mrkdwn links shrink).
		const budget = capChunkCount(
			chunkMarkdown(redactSecrets(request.text), {
				maxLength: capabilities.maxMessageLength,
				unit: capabilities.lengthUnit,
			}).flatMap((piece) => chunkForTransport(renderMarkdown(piece, capabilities.markdown), capabilities)),
			this.config.maxChunks,
		);
		let first: SendReceipt | null = null;

		for (const [index, chunk] of budget.chunks.entries()) {
			const receipt = await transport.send({
				conversationId: request.conversationId,
				kind: request.kind,
				text: chunk,
				// Only the first chunk carries the edit handle; editing a continuation
				// would leave the earlier chunks stale.
				...(index === 0 && request.editKey !== undefined ? { editKey: request.editKey } : {}),
				...(request.threadId === undefined ? {} : { threadId: request.threadId }),
			});
			if (first === null) first = receipt;
		}

		if (budget.dropped > 0) {
			// Posted as its own message, without the edit handle: editing it would
			// replace the first chunk and leave the delivered tail stale.
			await transport.send({
				conversationId: request.conversationId,
				kind: request.kind,
				text: truncatedNotice(budget.dropped),
				...(request.threadId === undefined ? {} : { threadId: request.threadId }),
			});
		}

		return first;
	}

	/**
	 * Starts a new turn. The next progress update posts a fresh message instead of
	 * editing the previous turn's card, and the throttle is reset so the first
	 * update of a turn always lands.
	 */
	beginTurn(): void {
		this.progressKeys.clear();
		this.lastProgressAt = Number.NEGATIVE_INFINITY;
	}

	/**
	 * Posts the first card of a turn ("thinking…").
	 *
	 * It deliberately does not consume the throttle budget: the first tool event
	 * of the turn must still land, and on an editable transport both update the
	 * same card.
	 */
	async publishTurnStart(): Promise<number> {
		const delivered = await this.publishProgressToConversations(thinkingLabel());
		this.lastProgressAt = Number.NEGATIVE_INFINITY;
		return delivered;
	}

	/**
	 * Publishes a coalesced progress update, throttled and edited in place on
	 * transports that support editing. Without this a long turn would post one
	 * chat message per tool call.
	 */
	async publishProgress(text: string): Promise<number> {
		const now = this.host.now();
		if (now - this.lastProgressAt < this.config.progressMinIntervalMs) return 0;
		this.lastProgressAt = now;
		return this.publishProgressToConversations(text);
	}

	private async publishProgressToConversations(text: string): Promise<number> {
		let delivered = 0;
		for (const target of this.store.listConversations()) {
			const key = `${target.transport}:${target.conversationId}`;
			if (this.store.isPaused(key)) continue;
			const transport = this.transports.get(target.transport);
			if (!transport) continue;
			await this.notifyTyping(target);
			await this.sendProgress(target, transport, text);
			delivered++;
		}
		return delivered;
	}

	/**
	 * Best-effort "the bot is working" hint. A transport without an indicator, or
	 * one that rejects, must never turn a progress update into a failed turn.
	 */
	private async notifyTyping(target: ConversationTarget): Promise<void> {
		const transport = this.transports.get(target.transport);
		const typing = transport?.typing?.bind(transport);
		if (typing === undefined) return;
		try {
			await typing(target.conversationId);
		} catch (error) {
			this.host.logger.debug("typing hint failed", { transport: target.transport, error: String(error) });
		}
	}

	private async sendProgress(target: ConversationTarget, transport: Transport, text: string): Promise<void> {
		const key = `${target.transport}:${target.conversationId}`;
		const editKey = this.progressKeys.get(key);

		if (editKey !== undefined && transport.capabilities.edit) {
			try {
				await this.send({ ...target, kind: "progress", text, editKey });
				return;
			} catch (error) {
				// The message may have been deleted, or the edit may be rate limited.
				this.host.logger.debug("progress edit failed, posting a new message", { error: String(error) });
				this.progressKeys.delete(key);
			}
		}

		const receipt = await this.send({ ...target, kind: "progress", text });
		if (receipt?.editKey !== undefined) this.progressKeys.set(key, receipt.editKey);
	}

	/** Sends a progress update to every remembered, non-paused conversation. */
	async publish(kind: OutboundKind, text: string): Promise<number> {
		let delivered = 0;
		for (const target of this.store.listConversations()) {
			const key = `${target.transport}:${target.conversationId}`;
			if (this.store.isPaused(key)) continue;
			if (!this.transports.has(target.transport)) continue;
			await this.send({ ...target, kind, text });
			delivered++;
		}
		return delivered;
	}

	/** Plain-data view of the bridge for local commands and diagnostics. */
	snapshot(): BridgeSnapshot {
		return {
			transports: this.transportIds,
			trusted: this.store.listTrusted(),
			paused: this.store
				.listConversations()
				.map((target) => `${target.transport}:${target.conversationId}`)
				.filter((key) => this.store.isPaused(key)),
			pending: this.store.listPending().map(({ key, pending }) => ({
				key,
				code: pending.code,
				expiresAt: pending.expiresAt,
			})),
			conversations: this.store.listConversations().length,
		};
	}
}
