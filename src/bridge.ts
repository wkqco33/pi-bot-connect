/**
 * The bridge: binds transports to the routing core and to a pi session.
 *
 * It owns no platform code. Everything platform-specific lives behind the
 * `Transport` contract; everything session-specific lives behind `BridgeHost`.
 * That is what makes the whole thing testable with `FakeTransport`.
 */

import { executeRemoteCommand, type RemoteCommandContext } from "./core/commands.js";
import { chunkForTransport } from "./core/chunk.js";
import { renderMarkdown } from "./core/markdown.js";
import { ATTACHMENTS_UNSUPPORTED_NOTICE, PAUSED_NOTICE, unknownCommandNotice } from "./core/notices.js";
import { isFreshChallenge, pairingCodeNotice, pairingPrompt, pairingSuccessPrompt, type PendingChallenge } from "./core/pairing.js";
import { redactSecrets } from "./core/redact.js";
import { route, type UnsupportedFeature } from "./core/router.js";
import {
	conversationKey,
	identityKey,
	resolveConfig,
	type BridgeConfig,
	type Envelope,
	type Logger,
	type OutboundKind,
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
	sendPrompt(text: string, options?: { deliverAs?: "steer" | "followUp" }): void;
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
			acceptsAttachments: this.host.acceptsAttachments,
			now: this.host.now(),
			random: () => this.host.random(),
		});

		for (const action of actions) {
			await this.applyAction(action, envelope, identity, key);
		}
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

		const options = action.deliverAs === undefined ? undefined : { deliverAs: action.deliverAs };
		this.host.sendPrompt(action.text, options);
		this.host.logger.info("prompt forwarded", {
			transport: envelope.transport,
			deliverAs: action.deliverAs ?? "immediate",
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
	async send(request: SendRequest): Promise<void> {
		const transport = this.transports.get(request.transport);
		if (!transport) {
			this.host.logger.warn("cannot send: transport not registered", { transport: request.transport });
			return;
		}

		const rendered = renderMarkdown(redactSecrets(request.text), transport.capabilities.markdown);
		const chunks = chunkForTransport(rendered, transport.capabilities);
		for (const chunk of chunks) {
			await transport.send({
				conversationId: request.conversationId,
				kind: request.kind,
				text: chunk,
				...(request.threadId === undefined ? {} : { threadId: request.threadId }),
			});
		}
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
