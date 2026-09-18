/**
 * Token-bucket rate limiting for remote input.
 *
 * A leaked or shared bot token paired with the session is a flood vector: the
 * messenger can drive an unbounded number of turns. This is a pure, injectable
 * limiter so the policy is testable without a clock.
 */

export interface RateLimitBucket {
	/** Tokens remaining at `updatedAt`. */
	readonly tokens: number;
	readonly updatedAt: number;
}

export interface RateLimitPolicy {
	/** Maximum burst, and the ceiling tokens refill toward. */
	readonly capacity: number;
	/** Tokens added per millisecond. */
	readonly refillPerMs: number;
}

export interface RateLimitDecision {
	readonly allowed: boolean;
	readonly bucket: RateLimitBucket;
	/** Milliseconds until the next token when `allowed` is false. */
	readonly retryAfterMs: number;
}

export function takeToken(
	previous: RateLimitBucket | undefined,
	now: number,
	policy: RateLimitPolicy,
): RateLimitDecision {
	const start = previous ?? { tokens: policy.capacity, updatedAt: now };
	// A backwards clock (NTP step, test) must not mint tokens.
	const elapsed = Math.max(0, now - start.updatedAt);
	const refilled = Math.min(policy.capacity, start.tokens + elapsed * policy.refillPerMs);

	if (refilled >= 1) {
		return { allowed: true, bucket: { tokens: refilled - 1, updatedAt: now }, retryAfterMs: 0 };
	}

	const deficit = 1 - refilled;
	const retryAfterMs = policy.refillPerMs > 0 ? Math.ceil(deficit / policy.refillPerMs) : Number.POSITIVE_INFINITY;
	return { allowed: false, bucket: { tokens: refilled, updatedAt: now }, retryAfterMs };
}
