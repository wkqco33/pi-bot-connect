/**
 * Pairing: proving that a remote identity is allowed to steer the local session.
 *
 * Security model
 * --------------
 * The challenge code is shown **only in the local pi terminal** and never sent
 * to the messenger. Sending it to the same chat that must prove its identity
 * would make the check meaningless. Anyone with terminal access approves the
 * remote user; the messenger only proves it can read what the operator typed.
 *
 * The strong control is `allowUsers` pre-trust. The code exists so that a
 * shared or leaked bot token is not, by itself, remote control.
 */

export interface PendingChallenge {
	readonly code: string;
	readonly expiresAt: number;
	/** Failed attempts against the current code. */
	readonly attempts: number;
}

export interface PairingOptions {
	readonly ttlMs: number;
	readonly digits: number;
	readonly maxAttempts: number;
}

export type PairingReason = "new" | "mismatch" | "expired" | "locked" | "awaiting";

export type PairingDecision =
	| { readonly type: "trust" }
	| { readonly type: "ask"; readonly pending: PendingChallenge; readonly reason: PairingReason };

const DEFAULT_DIGITS = 6;

function digit(random: () => number): string {
	const value = random();
	const clamped = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999) : 0;
	return Math.floor(clamped * 10).toString();
}

export function createChallenge(
	now: number,
	options: { ttlMs: number; digits?: number },
	random: () => number,
): PendingChallenge {
	const digits = options.digits ?? DEFAULT_DIGITS;
	let code = "";
	for (let i = 0; i < digits; i++) code += digit(random);
	return { code, expiresAt: now + options.ttlMs, attempts: 0 };
}

/** Accepts "123456", "123 456", "123-456". */
export function normalizeChallengeInput(input: string): string {
	return input.replace(/\D/g, "");
}

export function formatChallengeCode(code: string): string {
	return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** True when the reason implies a brand new code that must be surfaced locally. */
export function isFreshChallenge(reason: PairingReason): boolean {
	return reason === "new" || reason === "expired" || reason === "locked";
}

export interface DecidePairingParams {
	readonly pending: PendingChallenge | undefined;
	readonly text: string;
	readonly now: number;
	readonly options: PairingOptions;
	readonly random: () => number;
}

/**
 * Pure pairing transition. `maxAttempts` is per code: exhausting it rotates the
 * code and reports `locked` so the reply can tell the user to ask locally.
 */
export function decidePairing(params: DecidePairingParams): PairingDecision {
	const { pending, text, now, options, random } = params;
	const provided = normalizeChallengeInput(text);

	const isLive = pending !== undefined && now < pending.expiresAt && pending.attempts < options.maxAttempts;

	if (isLive && pending) {
		if (provided.length === 0) {
			return { type: "ask", pending, reason: "awaiting" };
		}
		// A guess must look like a code. Unrelated chatter that merely contains a
		// few digits ("meeting at 3pm") must not burn an attempt: in a channel
		// that would otherwise let anyone lock the challenge by typing numbers.
		if (provided.length !== pending.code.length) {
			return { type: "ask", pending, reason: "awaiting" };
		}
		if (provided === pending.code) {
			return { type: "trust" };
		}
		const attempts = pending.attempts + 1;
		if (attempts >= options.maxAttempts) {
			return { type: "ask", pending: createChallenge(now, options, random), reason: "locked" };
		}
		return { type: "ask", pending: { ...pending, attempts }, reason: "mismatch" };
	}

	let reason: PairingReason = "new";
	if (pending) {
		reason = now >= pending.expiresAt ? "expired" : "locked";
	}
	return { type: "ask", pending: createChallenge(now, options, random), reason };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface PairingPromptOptions {
	readonly digits: number;
	readonly maxAttempts: number;
	/** Local slash command name, e.g. "connect" -> `/connect`. */
	readonly commandName: string;
}

interface PromptContext {
	readonly digits: number;
	readonly remaining: number;
	readonly commandName: string;
}

/** Messenger-facing text. Never contains the code. */
const PAIRING_MESSAGES: Record<PairingReason, (ctx: PromptContext) => string> = {
	new: (ctx) =>
		`This chat is not paired with a pi session yet.\nIn the local pi terminal, run /${ctx.commandName} to see the ${ctx.digits}-digit code, then send it here.`,
	awaiting: () => "Waiting for the pairing code. Check the local pi terminal.",
	mismatch: (ctx) =>
		`That code did not match. ${ctx.remaining} attempt(s) left. Check the local pi terminal.`,
	expired: () => "The pairing code expired. A new code is shown in the local pi terminal.",
	locked: (ctx) =>
		`Too many wrong attempts. A new code is shown in the local pi terminal, or run /${ctx.commandName} there again.`,
};

export function pairingPrompt(
	pending: PendingChallenge,
	reason: PairingReason,
	options: PairingPromptOptions,
): string {
	return PAIRING_MESSAGES[reason]({
		digits: pending.code.length,
		remaining: Math.max(0, options.maxAttempts - pending.attempts),
		commandName: options.commandName,
	});
}

export interface PairingNoticeOptions {
	readonly ttlMs: number;
}

/** Terminal-facing text. This is the only place the code is rendered. */
export function pairingCodeNotice(pending: PendingChallenge, options: PairingNoticeOptions): string {
	const minutes = Math.max(1, Math.round(options.ttlMs / 60_000));
	return `Messenger pairing code: ${formatChallengeCode(pending.code)} (valid ${minutes} min). Type it in the chat to pair.`;
}

export function pairingSuccessPrompt(identity: string, commandName: string): string {
	return `Paired as ${identity}.\nSend a message to steer this pi session, or send /${commandName} help for commands.`;
}
