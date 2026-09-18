/**
 * The routing core: a pure function from (envelope, state) to actions.
 *
 * Everything user-visible about "what should happen to this message" lives
 * here, so it can be tested without a network, a clock, or a messenger.
 */

import { parseRemoteCommand, remoteCommandNames } from "./commands.js";
import { decidePairing, type PairingReason, type PendingChallenge } from "./pairing.js";
import { startsWithAny, stripLeadingMention } from "./text.js";
import type { BridgeConfig, Envelope } from "./types.js";

export type RouterAction =
	| { readonly type: "ignore"; readonly reason: "empty" | "unaddressed" }
	| { readonly type: "pair" }
	| { readonly type: "pair-required"; readonly pending: PendingChallenge; readonly reason: PairingReason }
	| { readonly type: "command"; readonly name: string; readonly args: string }
	| { readonly type: "prompt"; readonly text: string; readonly deliverAs?: "steer" | "followUp" };

export interface RouterInput {
	readonly envelope: Envelope;
	readonly config: BridgeConfig;
	readonly authenticated: boolean;
	readonly pendingChallenge?: PendingChallenge;
	readonly busy: boolean;
	readonly now: number;
	readonly random: () => number;
}

export interface IncomingText {
	/** Text with a leading bot mention removed. */
	readonly text: string;
	readonly addressed: boolean;
}

/** Used when a user sends only an attachment. */
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

export function route(input: RouterInput): RouterAction[] {
	const { envelope, config, authenticated, pendingChallenge, busy, now, random } = input;

	if (!authenticated) {
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

	const incoming = normalizeIncoming(envelope, config);

	const parsed = parseRemoteCommand(incoming.text, {
		prefixes: config.remotePrefixes,
		botUsername: config.botUsername,
		knownCommands: remoteCommandNames(),
	});
	if (parsed) return [{ type: "command", name: parsed.name, args: parsed.args }];

	if (incoming.text.length === 0 && (envelope.attachments?.length ?? 0) === 0) {
		return [{ type: "ignore", reason: "empty" }];
	}

	if (config.requireAddressing && !incoming.addressed) {
		return [{ type: "ignore", reason: "unaddressed" }];
	}

	const hasAttachments = (envelope.attachments?.length ?? 0) > 0;
	if (incoming.text.length === 0 && hasAttachments) {
		const fallback = busy
			? { type: "prompt" as const, text: ATTACHMENT_FALLBACK_PROMPT, deliverAs: config.busyDelivery }
			: { type: "prompt" as const, text: ATTACHMENT_FALLBACK_PROMPT };
		return [fallback];
	}

	if (busy) {
		return [{ type: "prompt", text: incoming.text, deliverAs: config.busyDelivery }];
	}
	return [{ type: "prompt", text: incoming.text }];
}
