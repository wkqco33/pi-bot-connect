import { describe, expect, it } from "vitest";
import {
	createChallenge,
	decidePairing,
	formatChallengeCode,
	isFreshChallenge,
	normalizeChallengeInput,
	pairingCodeNotice,
	pairingPrompt,
	pairingSuccessPrompt,
	type PairingOptions,
} from "./pairing.js";

/** Deterministic RNG: yields the digits of the given strings in sequence. */
function digitSequence(...groups: string[]): () => number {
	const values: number[] = [];
	for (const group of groups) {
		for (const char of group) {
			values.push(Number(char) / 10 + 0.0001);
		}
	}
	let index = 0;
	return () => values[index++] ?? 0;
}

const OPTIONS: PairingOptions = { ttlMs: 300_000, digits: 6, maxAttempts: 3 };

describe("createChallenge", () => {
	it("builds a code of the requested length from the injected rng", () => {
		const challenge = createChallenge(1_000, { ttlMs: 60_000 }, digitSequence("123456"));
		expect(challenge.code).toBe("123456");
		expect(challenge.expiresAt).toBe(61_000);
		expect(challenge.attempts).toBe(0);
	});

	it("clamps an out-of-range rng into 0..9", () => {
		const challenge = createChallenge(0, { ttlMs: 1, digits: 3 }, () => 1.5);
		expect(challenge.code).toBe("999");
	});
});

describe("normalizeChallengeInput", () => {
	it("accepts spaced and hyphenated codes", () => {
		expect(normalizeChallengeInput("123 456")).toBe("123456");
		expect(normalizeChallengeInput("123-456")).toBe("123456");
		expect(normalizeChallengeInput(" code: 123456 ")).toBe("123456");
	});

	it("returns an empty string when there are no digits", () => {
		expect(normalizeChallengeInput("hello")).toBe("");
	});
});

describe("formatChallengeCode", () => {
	it("groups six digits for readability", () => {
		expect(formatChallengeCode("123456")).toBe("123 456");
	});

	it("leaves other lengths alone", () => {
		expect(formatChallengeCode("12345")).toBe("12345");
	});
});

describe("decidePairing", () => {
	it("issues a new challenge when nothing is pending", () => {
		const decision = decidePairing({
			pending: undefined,
			text: "hi",
			now: 0,
			options: OPTIONS,
			random: digitSequence("111111"),
		});
		expect(decision).toEqual({
			type: "ask",
			pending: { code: "111111", expiresAt: 300_000, attempts: 0 },
			reason: "new",
		});
	});

	it("trusts the correct code", () => {
		const pending = { code: "123456", expiresAt: 1000, attempts: 0 };
		const decision = decidePairing({ pending, text: "123-456", now: 10, options: OPTIONS, random: () => 0 });
		expect(decision).toEqual({ type: "trust" });
	});

	it("does not consume an attempt when the message has no digits", () => {
		const pending = { code: "123456", expiresAt: 1000, attempts: 0 };
		const decision = decidePairing({ pending, text: "hello?", now: 10, options: OPTIONS, random: () => 0 });
		expect(decision).toEqual({ type: "ask", pending, reason: "awaiting" });
	});

	it("counts a wrong code and keeps the same challenge", () => {
		const pending = { code: "123456", expiresAt: 1000, attempts: 0 };
		const decision = decidePairing({ pending, text: "000000", now: 10, options: OPTIONS, random: () => 0 });
		expect(decision).toEqual({ type: "ask", pending: { ...pending, attempts: 1 }, reason: "mismatch" });
	});

	it("rotates the code once attempts are exhausted", () => {
		const pending = { code: "123456", expiresAt: 1000, attempts: 2 };
		const decision = decidePairing({
			pending,
			text: "000000",
			now: 10,
			options: OPTIONS,
			random: digitSequence("987654"),
		});
		expect(decision).toEqual({
			type: "ask",
			pending: { code: "987654", expiresAt: 300_010, attempts: 0 },
			reason: "locked",
		});
	});

	it("reissues with reason expired when the ttl has passed", () => {
		const pending = { code: "123456", expiresAt: 100, attempts: 0 };
		const decision = decidePairing({
			pending,
			text: "123456",
			now: 500,
			options: OPTIONS,
			random: digitSequence("222222"),
		});
		expect(decision.type).toBe("ask");
		if (decision.type === "ask") {
			expect(decision.reason).toBe("expired");
			expect(decision.pending.code).toBe("222222");
		}
	});
});

describe("isFreshChallenge", () => {
	it("is true only for reasons that produce a new code", () => {
		expect(isFreshChallenge("new")).toBe(true);
		expect(isFreshChallenge("expired")).toBe(true);
		expect(isFreshChallenge("locked")).toBe(true);
		expect(isFreshChallenge("awaiting")).toBe(false);
		expect(isFreshChallenge("mismatch")).toBe(false);
	});
});

describe("pairingPrompt", () => {
	const options = { digits: 6, maxAttempts: 3, commandName: "connect" };
	const pending = { code: "123456", expiresAt: 0, attempts: 0 };
	const REASONS = ["new", "awaiting", "mismatch", "expired", "locked"] as const;

	it("never leaks the code to the messenger", () => {
		for (const reason of REASONS) {
			const text = pairingPrompt(pending, reason, options);
			expect(text).not.toContain("123");
			expect(text).not.toContain("123456");
		}
	});

	it("points the user at the local terminal", () => {
		for (const reason of REASONS) {
			expect(pairingPrompt(pending, reason, options)).toContain("local pi terminal");
		}
	});

	it("names the local command and the code length for a new challenge", () => {
		const text = pairingPrompt(pending, "new", options);
		expect(text).toContain("/connect");
		expect(text).toContain("6-digit");
	});

	it("reports remaining attempts on a mismatch", () => {
		expect(pairingPrompt({ ...pending, attempts: 1 }, "mismatch", options)).toContain("2 attempt(s) left");
	});

	it("produces a distinct message for every reason", () => {
		const texts = REASONS.map((reason) => pairingPrompt(pending, reason, options));
		expect(new Set(texts).size).toBe(REASONS.length);
	});
});

describe("pairingCodeNotice", () => {
	it("is the only renderer that contains the code", () => {
		const notice = pairingCodeNotice({ code: "123456", expiresAt: 0, attempts: 0 }, { ttlMs: 300_000 });
		expect(notice).toContain("123 456");
		expect(notice).toContain("5 min");
		expect(notice).toContain("chat");
	});
});

describe("pairingSuccessPrompt", () => {
	it("names the identity and the local command", () => {
		const text = pairingSuccessPrompt("telegram:42", "connect");
		expect(text).toContain("telegram:42");
		expect(text).toContain("/connect help");
	});
});
