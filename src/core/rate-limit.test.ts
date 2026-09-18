import { describe, expect, it } from "vitest";
import { takeToken, type RateLimitBucket, type RateLimitPolicy } from "./rate-limit.js";

/** 60 tokens per minute: one token per second. */
const POLICY: RateLimitPolicy = { capacity: 60, refillPerMs: 1 / 1000 };

describe("takeToken", () => {
	it("allows the first call from an empty state and spends one token", () => {
		const decision = takeToken(undefined, 1_000, POLICY);
		expect(decision.allowed).toBe(true);
		expect(decision.bucket.tokens).toBe(59);
	});

	it("allows up to the capacity in an instant", () => {
		let bucket: RateLimitBucket | undefined;
		for (let i = 0; i < POLICY.capacity; i++) {
			const decision = takeToken(bucket, 0, POLICY);
			expect(decision.allowed).toBe(true);
			bucket = decision.bucket;
		}
		expect(bucket?.tokens).toBe(0);
	});

	it("refuses the call that would exceed the capacity", () => {
		let bucket: RateLimitBucket | undefined;
		for (let i = 0; i < POLICY.capacity; i++) bucket = takeToken(bucket, 0, POLICY).bucket;
		const decision = takeToken(bucket, 0, POLICY);
		expect(decision.allowed).toBe(false);
	});

	it("reports how long to wait before the next token", () => {
		const empty: RateLimitBucket = { tokens: 0, updatedAt: 0 };
		const decision = takeToken(empty, 0, POLICY);
		expect(decision.allowed).toBe(false);
		expect(decision.retryAfterMs).toBe(1_000);
	});

	it("refills tokens as time passes", () => {
		const empty: RateLimitBucket = { tokens: 0, updatedAt: 0 };
		const decision = takeToken(empty, 1_000, POLICY);
		expect(decision.allowed).toBe(true);
	});

	it("never refills beyond the capacity", () => {
		const bucket: RateLimitBucket = { tokens: 0, updatedAt: 0 };
		const decision = takeToken(bucket, 10 * 60_000, POLICY);
		expect(decision.bucket.tokens).toBe(POLICY.capacity - 1);
	});

	it("does not refill when the clock goes backwards", () => {
		const bucket: RateLimitBucket = { tokens: 5, updatedAt: 1_000 };
		const decision = takeToken(bucket, 500, POLICY);
		expect(decision.allowed).toBe(true);
		expect(decision.bucket.tokens).toBe(4);
	});

	it("does not accumulate retry debt while tokens are available", () => {
		const decision = takeToken({ tokens: 3, updatedAt: 0 }, 0, POLICY);
		expect(decision.retryAfterMs).toBe(0);
	});
});
