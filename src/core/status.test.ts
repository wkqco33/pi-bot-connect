import { describe, expect, it } from "vitest";
import { formatDoctorReport, formatStatusLabel, formatStatusReport, type TransportStatusEntry } from "./status.js";

const running = (id: string): TransportStatusEntry => ({ id, status: "running" });
const standby = (id: string, detail = "pid 42 on box owns this bot; retrying every 15s"): TransportStatusEntry => ({
	id,
	status: "standby",
	detail,
});
const failed = (id: string, detail = "bad token"): TransportStatusEntry => ({ id, status: "error", detail });

const report = {
	label: "bot-connect",
	extensionLine: "- extension: bot-connect 0.6.0",
	trusted: 1,
	conversations: 2,
	paused: [],
	pending: 0,
	availableTransports: ["discord", "telegram"],
	localCommand: "connect",
};

describe("formatStatusLabel", () => {
	it("lists a running transport", () => {
		expect(formatStatusLabel({ label: "bot-connect", transports: [running("discord")] })).toBe("bot-connect: discord");
	});

	it("lists several running transports", () => {
		expect(formatStatusLabel({ label: "bot-connect", transports: [running("discord"), running("telegram")] })).toBe(
			"bot-connect: discord,telegram",
		);
	});

	it("reports standby alone instead of pretending the transport runs", () => {
		expect(formatStatusLabel({ label: "bot-connect", transports: [standby("discord")] })).toBe(
			"bot-connect: standby (discord)",
		);
	});

	it("annotates standby next to a running transport", () => {
		expect(formatStatusLabel({ label: "bot-connect", transports: [running("discord"), standby("telegram")] })).toBe(
			"bot-connect: discord (+1 standby)",
		);
	});

	it("reports a failed transport instead of calling it running", () => {
		expect(formatStatusLabel({ label: "bot-connect", transports: [failed("discord")] })).toBe(
			"bot-connect: error (discord)",
		);
	});

	it("reports an empty registration", () => {
		expect(formatStatusLabel({ label: "bot-connect", transports: [] })).toBe("bot-connect: no transports");
	});
});

describe("formatStatusReport", () => {
	it("keeps the transport list explicit when nothing is configured", () => {
		const text = formatStatusReport({ ...report, transports: [] });
		expect(text).toContain("- transports: (none configured)");
		expect(text).toContain("Available transports: discord, telegram");
	});

	it("shows a standby transport with its holder", () => {
		const text = formatStatusReport({ ...report, transports: [standby("discord")] });
		expect(text).toContain("- transports: discord (standby — pid 42 on box owns this bot");
	});

	it("shows a running transport as running", () => {
		const text = formatStatusReport({ ...report, transports: [running("discord")] });
		expect(text).toContain("- transports: discord (running)");
	});

	it("lists the local subcommands", () => {
		const text = formatStatusReport({ ...report, transports: [] });
		expect(text).toContain("status|doctor|version|pair|digest|pause|resume|disconnect|config");
	});

	it("reports counts", () => {
		const text = formatStatusReport({ ...report, transports: [] });
		expect(text).toContain("- paired chats: 1");
		expect(text).toContain("- conversations: 2");
		expect(text).toContain("- pending codes: 0");
	});

	it("lists paused conversations by key", () => {
		const text = formatStatusReport({ ...report, transports: [], paused: ["discord:chan-1"] });
		expect(text).toContain("- paused: discord:chan-1");
	});
});

const doctor = {
	label: "bot-connect",
	extensionLine: "- extension: bot-connect 0.6.0",
	transports: [] as TransportStatusEntry[],
	sessionKey: "session-xyz",
	stateFile: "/tmp/state.json",
	persistent: true,
	trusted: 0,
	conversations: 0,
	pending: 0,
};

describe("formatDoctorReport", () => {
	it("reports a failed state write as unhealthy without leaking the error", () => {
		const result = formatDoctorReport({ ...doctor, stateWriteFailed: true });
		expect(result.healthy).toBe(false);
		expect(result.text).toContain("write failed");
	});

	it("shows stored startup diagnostics on demand", () => {
		expect(formatDoctorReport({ ...doctor, startupNotes: ["global config: unknown key"] }).text).toContain("- global config: unknown key");
	});

	it("reports when no transport is registered", () => {
		expect(formatDoctorReport(doctor).text).toContain("- transports: none registered");
	});

	it("reports the session key and the state file", () => {
		const text = formatDoctorReport(doctor).text;
		expect(text).toContain("- session key: session-xyz");
		expect(text).toContain("/tmp/state.json (persistent)");
	});

	it("is healthy when nothing is registered", () => {
		expect(formatDoctorReport(doctor).healthy).toBe(true);
	});

	it("shows a standby transport with its holder and the retry cadence", () => {
		const text = formatDoctorReport({ ...doctor, transports: [standby("discord")] }).text;
		expect(text).toContain("- discord: standby — pid 42 on box owns this bot; retrying every 15s");
	});

	it("stays healthy while a transport stands by", () => {
		expect(formatDoctorReport({ ...doctor, transports: [standby("discord")] }).healthy).toBe(true);
	});

	it("is unhealthy when a transport failed", () => {
		expect(formatDoctorReport({ ...doctor, transports: [failed("discord")] }).healthy).toBe(false);
	});

	it("keeps the ordered checklist", () => {
		const text = formatDoctorReport(doctor).text;
		expect(text).toContain("privileged intents");
		expect(text).toContain("no other pi process");
	});
});
