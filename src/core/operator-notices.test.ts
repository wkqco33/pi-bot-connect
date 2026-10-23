import { describe, expect, it } from "vitest";
import { OperatorNotices, consoleLogEnabled, summarizeStartupNotes } from "./operator-notices.js";

describe("operator notices", () => {
	it("keeps console output disabled by default at every level", () => {
		expect(["debug", "info", "warn", "error"].map((level) => consoleLogEnabled(false, level))).toEqual([false, false, false, false]);
	});

	it("allows detailed console output when debug is enabled", () => {
		expect(consoleLogEnabled(true, "warn")).toBe(true);
	});

	it("notifies once per failure episode and resets after recovery", () => {
		const notices = new OperatorNotices();
		expect([notices.fail("discord", "connection"), notices.fail("discord", "connection"), notices.fail("telegram", "connection")]).toEqual([true, false, true]);
		notices.recover("discord", "connection");
		expect(notices.fail("discord", "connection")).toBe(true);
	});

	it("summarizes multiline startup diagnostics without including details", () => {
		expect(summarizeStartupNotes(["bad config secret", "another warning"])).toBe("[bot-connect] 2 startup warnings; run /connect doctor for details.");
	});
});
