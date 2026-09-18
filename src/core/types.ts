/**
 * Shared domain types for the bridge core.
 *
 * LAYERING RULE: everything in `src/core/` is pure TypeScript. It must not
 * import `node:*`, `@earendil-works/pi-coding-agent`, or any transport SDK.
 * I/O lives in `src/transports/` and the pi adapter (`src/index.ts`).
 */

export type LogMetaValue = string | number | boolean | null | undefined;
export type LogMeta = Record<string, LogMetaValue | readonly LogMetaValue[]>;

export interface Logger {
	debug(message: string, meta?: LogMeta): void;
	info(message: string, meta?: LogMeta): void;
	warn(message: string, meta?: LogMeta): void;
	error(message: string, meta?: LogMeta): void;
}

export const noopLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

/** Identifier of a transport implementation, e.g. "telegram" or "fake". */
export type TransportId = string;

export interface InboundAttachment {
	kind: "image" | "file";
	mediaType: string;
	/** Opaque transport-side reference. Transports resolve it to bytes on demand. */
	ref: string;
	name?: string;
	sizeBytes?: number;
}

/**
 * Normalized inbound message. Every transport must produce this shape and
 * nothing else — the bridge core never sees platform payloads.
 */
export interface Envelope {
	readonly transport: TransportId;
	/** Stable conversation key inside the transport (chat / DM / channel-thread). */
	readonly conversationId: string;
	/** Stable user key inside the transport. */
	readonly userId: string;
	/** Thread/reply anchor when the transport supports threads. */
	readonly threadId?: string;
	readonly timestamp: number;
	readonly text: string;
	/** True for a DM/private chat. Channel messages need explicit addressing. */
	readonly isDirect: boolean;
	readonly attachments?: readonly InboundAttachment[];
	/** True when the bot was explicitly addressed (@mention or DM). */
	readonly addressed?: boolean;
	/** Transport-native payload, kept only for adapter debugging/recording. */
	readonly raw?: unknown;
}

export type OutboundKind = "reply" | "progress" | "digest" | "system";

export interface OutboundMessage {
	readonly conversationId: string;
	readonly threadId?: string;
	readonly kind: OutboundKind;
	readonly text: string;
	/**
	 * When set, transports that support editing update the existing message
	 * instead of posting a new one. The value is a prior `SendReceipt.editKey`.
	 */
	readonly editKey?: string;
}

export interface SendReceipt {
	readonly messageId: string;
	readonly editKey?: string;
}

export type MarkdownFlavor = "plain" | "markdown" | "html" | "mrkdwn";

export interface TransportCapabilities {
	readonly threads: boolean;
	readonly edit: boolean;
	readonly reactions: boolean;
	readonly attachments: boolean;
	/** Maximum length of a single message, measured per `lengthUnit`. */
	readonly maxMessageLength: number;
	readonly lengthUnit: "chars" | "bytes";
	readonly markdown: MarkdownFlavor;
	/** Whether the transport can distinguish channels from direct messages. */
	readonly channels: boolean;
}

export type EnvelopeHandler = (envelope: Envelope) => void | Promise<void>;

/** The adapter contract. Implement this to add a messenger. */
export interface Transport {
	readonly id: TransportId;
	readonly capabilities: TransportCapabilities;
	start(handler: EnvelopeHandler): Promise<void>;
	stop(): Promise<void>;
	send(message: OutboundMessage): Promise<SendReceipt>;
}

export interface BridgeConfig {
	/** Local slash-command namespace, e.g. "connect" -> `/connect`. */
	readonly localCommand: string;
	/** Prefixes the remote user may type, e.g. "/" or "bot ". */
	readonly remotePrefixes: readonly string[];
	/** Bot handle used for `@handle` addressing, without the leading "@". */
	readonly botUsername?: string;
	/** Delivery mode for prompts that arrive while the agent is busy. */
	readonly busyDelivery: "steer" | "followUp";
	/** Pairing challenge lifetime. */
	readonly pairingTtlMs: number;
	/** Digits in the pairing challenge code. */
	readonly pairingDigits: number;
	/** Failed challenge attempts before the conversation is locked. */
	readonly pairingMaxAttempts: number;
	/** Pre-trusted `transport:userId` identities. */
	readonly allowUsers: readonly string[];
	/** When false, unknown users are trusted immediately (dev mode). */
	readonly requirePairing: boolean;
	/**
	 * When true, channel messages must address the bot (mention, prefix, or DM)
	 * to become prompts. Direct messages are always accepted.
	 */
	readonly requireAddressing: boolean;
	readonly digest: {
		readonly maxLength: number;
	};
}

export const DEFAULT_CONFIG: BridgeConfig = {
	localCommand: "connect",
	remotePrefixes: ["/", "connect ", "bot "],
	busyDelivery: "followUp",
	pairingTtlMs: 5 * 60 * 1000,
	pairingDigits: 6,
	pairingMaxAttempts: 3,
	allowUsers: [],
	requirePairing: true,
	requireAddressing: true,
	digest: { maxLength: 1500 },
};

export function resolveConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		...DEFAULT_CONFIG,
		...overrides,
		digest: { ...DEFAULT_CONFIG.digest, ...overrides.digest },
	};
}

/** `transport:userId` — the unit of trust. Never trust a bare userId. */
export function identityKey(transport: TransportId, userId: string): string {
	return `${transport}:${userId}`;
}

export function conversationKey(env: Envelope): string {
	return `${env.transport}:${env.conversationId}`;
}
