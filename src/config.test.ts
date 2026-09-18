import { describe, expect, it } from "vitest";
import { parseConfigFile } from "./config.js";

describe("parseConfigFile — accepted input", () => {
	it("parses a complete, valid file", () => {
		const result = parseConfigFile({
			bridge: {
				localCommand: "connect",
				remotePrefixes: ["/", "bot "],
				botUsername: "piBot",
				busyDelivery: "steer",
				pairingTtlMs: 120_000,
				pairingDigits: 8,
				pairingMaxAttempts: 5,
				allowUsers: ["telegram:42", "discord:99"],
				requirePairing: true,
				requireAddressing: false,
				digest: { maxLength: 900 },
			},
			transports: { telegram: { tokenEnv: "PI_TELEGRAM_TOKEN" } },
		});

		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.config).toEqual({
			localCommand: "connect",
			remotePrefixes: ["/", "bot "],
			botUsername: "piBot",
			busyDelivery: "steer",
			pairingTtlMs: 120_000,
			pairingDigits: 8,
			pairingMaxAttempts: 5,
			allowUsers: ["telegram:42", "discord:99"],
			requirePairing: true,
			requireAddressing: false,
			digest: { maxLength: 900 },
		});
		expect(result.transports).toEqual({ telegram: { tokenEnv: "PI_TELEGRAM_TOKEN" } });
	});

	it("accepts an empty object and returns defaults-free partial config", () => {
		const result = parseConfigFile({});
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.config).toEqual({});
		expect(result.transports).toEqual({});
	});

	it("strips a leading @ from botUsername", () => {
		expect(parseConfigFile({ bridge: { botUsername: "@piBot" } }).config.botUsername).toBe("piBot");
	});

	it("normalizes a digest section that only sets maxLength", () => {
		expect(parseConfigFile({ bridge: { digest: { maxLength: 400 } } }).config.digest).toEqual({ maxLength: 400 });
	});
});

describe("parseConfigFile — rejected input", () => {
	it("rejects a non-object top level", () => {
		expect(parseConfigFile("nope").errors).toEqual(["config: expected a JSON object at the top level"]);
		expect(parseConfigFile(null).errors).toHaveLength(1);
		expect(parseConfigFile([]).errors).toHaveLength(1);
	});

	it("rejects a non-object bridge section", () => {
		expect(parseConfigFile({ bridge: 3 }).errors).toContain("bridge: expected an object");
	});

	it("rejects a non-object transports section", () => {
		expect(parseConfigFile({ transports: [] }).errors).toContain("transports: expected an object");
	});

	it("reports a wrong type with its path", () => {
		const result = parseConfigFile({ bridge: { localCommand: 5, requirePairing: "yes" } });
		expect(result.errors).toContain("bridge.localCommand: expected a string, received number");
		expect(result.errors).toContain("bridge.requirePairing: expected a boolean, received string");
	});

	it("rejects a localCommand that would break the slash namespace", () => {
		expect(parseConfigFile({ bridge: { localCommand: "1 bad command" } }).errors).toHaveLength(1);
	});

	it("rejects an unknown busyDelivery value", () => {
		expect(parseConfigFile({ bridge: { busyDelivery: "queue" } }).errors).toContain(
			'bridge.busyDelivery: expected "steer" or "followUp", received "queue"',
		);
	});

	it("enforces pairing ranges", () => {
		expect(parseConfigFile({ bridge: { pairingTtlMs: 5 } }).errors).toHaveLength(1);
		expect(parseConfigFile({ bridge: { pairingTtlMs: 10_000 } }).config.pairingTtlMs).toBe(10_000);
		expect(parseConfigFile({ bridge: { pairingDigits: 6.5 } }).errors).toHaveLength(1);
		expect(parseConfigFile({ bridge: { pairingDigits: 2 } }).errors).toHaveLength(1);
		expect(parseConfigFile({ bridge: { pairingMaxAttempts: 0 } }).errors).toHaveLength(1);
	});

	it("rejects allowUsers entries that are not transport-scoped", () => {
		const result = parseConfigFile({ bridge: { allowUsers: ["telegram:42", "just-a-name"] } });
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("just-a-name");
		expect(result.config.allowUsers).toBeUndefined();
	});

	it("rejects empty remote prefixes", () => {
		expect(parseConfigFile({ bridge: { remotePrefixes: ["/", ""] } }).errors).toHaveLength(1);
	});

	it("rejects a non-array remote prefix list", () => {
		expect(parseConfigFile({ bridge: { remotePrefixes: "/" } }).errors).toContain(
			"bridge.remotePrefixes: expected an array of strings",
		);
	});

	it("enforces the digest maxLength range", () => {
		expect(parseConfigFile({ bridge: { digest: { maxLength: 10 } } }).errors).toHaveLength(1);
		expect(parseConfigFile({ bridge: { digest: { maxLength: 20_000 } } }).errors).toHaveLength(1);
		expect(parseConfigFile({ bridge: { digest: 5 } }).errors).toContain("bridge.digest: expected an object");
	});
});

describe("parseConfigFile — warnings", () => {
	it("warns about unknown top-level keys without failing", () => {
		const result = parseConfigFile({ bridgey: {} });
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual(["bridgey: unknown top-level key, ignored"]);
	});

	it("warns about unknown bridge keys without failing", () => {
		const result = parseConfigFile({ bridge: { loki: true } });
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual(["bridge.loki: unknown key, ignored"]);
	});

	it("warns about unknown digest keys", () => {
		const result = parseConfigFile({ bridge: { digest: { maxLength: 200, maxFiles: 3 } } });
		expect(result.warnings).toEqual(["bridge.digest.maxFiles: unknown key, ignored"]);
	});
});
