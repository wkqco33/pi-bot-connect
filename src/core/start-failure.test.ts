import { describe, expect, it } from "vitest";
import {
	boundFailureMessage,
	classifyStartFailure,
	MAX_FAILURE_NOTICE_LENGTH,
	standbyDetail,
	standbyNotice,
	takeoverNotice,
} from "./start-failure.js";

/** Shaped like `src/lock.ts`'s error without importing the file-system module. */
function lockHeldError(holder: { pid: number; host: string } | null): Error {
	const error = new Error("lock held");
	error.name = "LockHeldError";
	Object.assign(error, { holder });
	return error;
}

describe("classifyStartFailure — standby", () => {
	it("treats a held lock as standby instead of an error", () => {
		expect(classifyStartFailure(lockHeldError({ pid: 42, host: "box" }))).toEqual({
			kind: "standby",
			holder: { pid: 42, host: "box" },
		});
	});

	it("keeps standby when the holder could not be read", () => {
		expect(classifyStartFailure(lockHeldError(null))).toEqual({ kind: "standby", holder: null });
	});

	it("drops a holder that is not pid/host shaped", () => {
		const error = new Error("lock held");
		error.name = "LockHeldError";
		Object.assign(error, { holder: { pid: "42", host: 1 } });
		expect(classifyStartFailure(error)).toEqual({ kind: "standby", holder: null });
	});
});

describe("classifyStartFailure — real errors", () => {
	it("keeps a normal error as an error", () => {
		expect(classifyStartFailure(new Error("bad token"))).toEqual({ kind: "error", detail: "bad token" });
	});

	it("classifies a thrown non-Error by its string form", () => {
		expect(classifyStartFailure("boom")).toEqual({ kind: "error", detail: "boom" });
	});

	it("keeps standby but forgets a malformed holder", () => {
		const error = new Error("no holder");
		error.name = "LockHeldError";
		expect(classifyStartFailure(error)).toEqual({ kind: "standby", holder: null });
	});
});

describe("boundFailureMessage", () => {
	it("collapses newlines so one notice stays one line", () => {
		expect(boundFailureMessage("first\nsecond\r\nthird")).toBe("first second third");
	});

	it("trims surrounding whitespace", () => {
		expect(boundFailureMessage("  spaces  ")).toBe("spaces");
	});

	it("bounds a long message", () => {
		expect(boundFailureMessage("x".repeat(500)).length).toBeLessThanOrEqual(MAX_FAILURE_NOTICE_LENGTH);
	});

	it("marks a bounded message as truncated", () => {
		expect(boundFailureMessage("x".repeat(500))).toContain("…");
	});

	it("leaves a short message untouched", () => {
		expect(boundFailureMessage("bad token")).toBe("bad token");
	});

	it("redacts a secret that leaked into an error message", () => {
		const message = "connect failed for https://api.telegram.org/bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/getMe";
		expect(boundFailureMessage(message)).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
	});
});

describe("standbyNotice", () => {
	it("names the owning process in one short line", () => {
		expect(standbyNotice("discord", { pid: 86946, host: "gram15" })).toBe(
			"discord: standby — pid 86946 on gram15 owns this bot",
		);
	});

	it("stays honest when the holder is unknown", () => {
		expect(standbyNotice("discord", null)).toBe("discord: standby — another pi process owns this bot");
	});

	it("never mentions the lock token or the file path", () => {
		const notice = standbyNotice("telegram", { pid: 7, host: "box" });
		expect(notice).not.toContain(".lock");
		expect(notice).not.toContain("/home");
	});
});

describe("standbyDetail", () => {
	it("explains that this session will take the bot over", () => {
		expect(standbyDetail({ pid: 7, host: "box" }, 15_000)).toBe(
			"pid 7 on box owns this bot; retrying every 15s",
		);
	});

	it("formats a cadence of a minute or more in minutes", () => {
		expect(standbyDetail(null, 120_000)).toBe("another pi process owns this bot; retrying every 2m");
	});
});

describe("takeoverNotice", () => {
	it("says which transport now owns the bot", () => {
		expect(takeoverNotice("discord")).toBe("discord: took over from the previous pi process");
	});
});
