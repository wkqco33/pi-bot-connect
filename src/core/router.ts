/**
 * The routing core: a pure function from (envelope, state) to actions.
 *
 * Everything user-visible about "what should happen to this message" lives
 * here, so it can be tested without a network, a clock, or a messenger.
 *
 * Attachment policy belongs here too: deciding whether an attachment may be
 * forwarded is a rule, not a transport detail, and a rejected attachment must
 * never reach the model as a prompt about something that is not there.
 */

import { parseRemoteCommand, remoteCommandNames } from "./commands.js";
import { decidePairing, type PairingReason, type PendingChallenge } from "./pairing.js";
import { startsWithAny, stripLeadingMention } from "./text.js";
import type { AttachmentPolicy, BridgeConfig, Envelope, InboundAttachment } from "./types.js";

/** Things a messenger can send that the current configuration cannot accept. */
export type UnsupportedFeature =
	| "attachments"
	| "attachment-not-image"
	| "attachment-too-large"
	| "attachment-too-many";

export type RouterAction =
	| { readonly type: "ignore"; readonly reason: "empty" | "unaddressed" }
	| { readonly type: "pair" }
	| { readonly type: "pair-required"; readonly pending: PendingChallenge; readonly reason: PairingReason }
	| { readonly type: "unsupported"; readonly feature: UnsupportedFeature }
	| { readonly type: "command"; readonly name: string; readonly args: string }
	| {
			readonly type: "prompt";
			readonly text: string;
			readonly deliverAs?: "steer" | "followUp";
			readonly attachments?: readonly InboundAttachment[];
	  };

export interface RouterInput {
	readonly envelope: Envelope;
	readonly config: BridgeConfig;
	readonly authenticated: boolean;
	readonly pendingChallenge?: PendingChallenge;
	readonly busy: boolean;
	/** Whether this transport can actually hand attachment bytes to the host. */
	readonly attachmentPolicy: AttachmentPolicy;
	readonly now: number;
	readonly random: () => number;
}

export interface IncomingText {
	/** Text with a leading bot mention removed. */
	readonly text: string;
	readonly addressed: boolean;
}

/** Used when a user sends only a forwardable attachment. */
export const ATTACHMENT_FALLBACK_PROMPT = "Describe the attached image.";

/**
 * Normalizes raw inbound text: strips a leading `@bot` mention and reports
 * whether the message was addressed to the bot (mention, command prefix, or DM).
 */
export function normalizeIncoming(envelope: Envelope, config: BridgeConfig): IncomingText {
	const stripped = stripLeadingMention(envelope.text, config.botUsername);
	const addressed =
		envelope.isDirect ||
		envelope.addressed === true ||
		stripped.mentioned ||
		startsWithAny(envelope.text.trim(), config.remotePrefixes);
	return { text: stripped.text, addressed };
}

/** Returns the first policy violation, in the order the user can act on it. */
export function findAttachmentProblem(
	attachments: readonly InboundAttachment[],
	policy: AttachmentPolicy,
): UnsupportedFeature | null {
	if (!policy.accepts) return "attachments";
	if (attachments.length > policy.maxCount) return "attachment-too-many";
	for (const attachment of attachments) {
		if (!policy.allowedMediaTypes.includes(attachment.mediaType)) return "attachment-not-image";
		// Size is checked again after download; the declared size is a cheap early out.
		if (attachment.sizeBytes !== undefined && attachment.sizeBytes > policy.maxBytes) {
			return "attachment-too-large";
		}
	}
	return null;
}

function routePairing(input: RouterInput): RouterAction[] {
	const { envelope, config, pendingChallenge, now, random } = input;

	const decision = decidePairing({
		pending: pendingChallenge,
		text: envelope.text,
		now,
		options: {
			ttlMs: config.pairingTtlMs,
			digits: config.pairingDigits,
			maxAttempts: config.pairingMaxAttempts,
		},
		random,
	});

	if (decision.type === "trust") return [{ type: "pair" }];
	return [{ type: "pair-required", pending: decision.pending, reason: decision.reason }];
}

function routeAuthenticated(input: RouterInput): RouterAction[] {
	const { envelope, config, busy, attachmentPolicy } = input;
	const incoming = normalizeIncoming(envelope, config);

	const parsed = parseRemoteCommand(incoming.text, {
		prefixes: config.remotePrefixes,
		botUsername: config.botUsername,
		knownCommands: remoteCommandNames(),
	});
	if (parsed) return [{ type: "command", name: parsed.name, args: parsed.args }];

	const attachments = envelope.attachments ?? [];
	const hasAttachments = attachments.length > 0;

	if (incoming.text.length === 0 && !hasAttachments) {
		return [{ type: "ignore", reason: "empty" }];
	}
	if (config.requireAddressing && !incoming.addressed) {
		return [{ type: "ignore", reason: "unaddressed" }];
	}

	if (hasAttachments) {
		const problem = findAttachmentProblem(attachments, attachmentPolicy);
		if (problem !== null) return [{ type: "unsupported", feature: problem }];
	}

	// Only reachable with attachments, because an empty text without them
	// already returned "empty".
	const text = incoming.text.length > 0 ? incoming.text : ATTACHMENT_FALLBACK_PROMPT;
	const base = hasAttachments ? { type: "prompt" as const, text, attachments } : { type: "prompt" as const, text };

	if (busy) return [{ ...base, deliverAs: config.busyDelivery }];
	return [base];
}

export function route(input: RouterInput): RouterAction[] {
	return input.authenticated ? routeAuthenticated(input) : routePairing(input);
}
