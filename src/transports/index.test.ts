import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noopLogger } from "../core/types.js";
import { createTransports, listTransportFactories } from "./index.js";

const TOKEN_ENV = "PI_DISCORD_TOKEN";
const CUSTOM_ENV = "PI_BOT_CONNECT_TEST_DISCORD_TOKEN";
const TELEGRAM_ENV = "PI_TELEGRAM_TOKEN";
const TELEGRAM_CUSTOM_ENV = "PI_BOT_CONNECT_TEST_TELEGRAM_TOKEN";
const ROBO_CLAW_TOKEN_ENV = "PI_ROBO_CLAW_TOKEN";
const originalToken = process.env[TOKEN_ENV];
const originalCustom = process.env[CUSTOM_ENV];
const originalTelegram = process.env[TELEGRAM_ENV];
const originalTelegramCustom = process.env[TELEGRAM_CUSTOM_ENV];
const originalRoboClawToken = process.env[ROBO_CLAW_TOKEN_ENV];

beforeEach(() => {
	delete process.env[TOKEN_ENV];
	delete process.env[CUSTOM_ENV];
	delete process.env[TELEGRAM_ENV];
	delete process.env[TELEGRAM_CUSTOM_ENV];
	delete process.env[ROBO_CLAW_TOKEN_ENV];
});

afterEach(() => {
	restore(TOKEN_ENV, originalToken);
	restore(CUSTOM_ENV, originalCustom);
	restore(TELEGRAM_ENV, originalTelegram);
	restore(TELEGRAM_CUSTOM_ENV, originalTelegramCustom);
	restore(ROBO_CLAW_TOKEN_ENV, originalRoboClawToken);
});

function restore(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function create(transportConfig: Record<string, unknown>) {
	return createTransports({ transportConfig, lockDir: "/tmp/bot-connect-locks", logger: noopLogger });
}

describe("transport registry", () => {
	it("registers the built-in factories", () => {
		expect(listTransportFactories().map((factory) => factory.id)).toEqual(["discord", "telegram", "robo_claw"]);
	});


	it("creates nothing when no credential is present", () => {
		expect(create({})).toEqual({ transports: [], skipped: [], errors: [] });
	});

	it("creates a Discord transport when the token is present", () => {
		process.env[TOKEN_ENV] = "token";
		const created = create({});
		expect(created.transports.map((transport) => transport.id)).toEqual(["discord"]);
		expect(created.errors).toEqual([]);
	});

	it("honors a custom tokenEnv name", () => {
		process.env[CUSTOM_ENV] = "token";
		const created = create({ discord: { tokenEnv: CUSTOM_ENV } });
		expect(created.transports.map((transport) => transport.id)).toEqual(["discord"]);
	});

	it("skips an explicitly disabled transport", () => {
		process.env[TOKEN_ENV] = "token";
		const created = create({ discord: { enabled: false } });
		expect(created.transports).toEqual([]);
		expect(created.skipped).toEqual(["discord"]);
	});

	it("reports an enabled transport with a missing credential as a config error", () => {
		const created = create({ discord: { enabled: true } });
		expect(created.transports).toEqual([]);
		expect(created.errors).toHaveLength(1);
		expect(created.errors[0]).toContain(TOKEN_ENV);
		expect(created.errors[0]).toContain("never put it in the config file");
	});

	it("creates a Telegram transport when its token is present", () => {
		process.env[TELEGRAM_ENV] = "token";
		const created = create({});
		expect(created.transports.map((transport) => transport.id)).toEqual(["telegram"]);
		expect(created.errors).toEqual([]);
	});

	it("honors a custom Telegram tokenEnv name", () => {
		process.env[TELEGRAM_CUSTOM_ENV] = "token";
		const created = create({ telegram: { tokenEnv: TELEGRAM_CUSTOM_ENV } });
		expect(created.transports.map((transport) => transport.id)).toEqual(["telegram"]);
	});

	it("reports an enabled Telegram transport with a missing credential", () => {
		const created = create({ telegram: { enabled: true } });
		expect(created.transports).toEqual([]);
		expect(created.errors[0]).toContain(TELEGRAM_ENV);
	});

	it("ignores configuration for an unknown transport", () => {
		process.env[TOKEN_ENV] = "token";
		const created = create({ matrix: { enabled: true } });
		expect(created.transports.map((transport) => transport.id)).toEqual(["discord"]);
		expect(created.errors).toEqual([]);
	});

	it("creates a RoboClaw transport when explicitly enabled", () => {
		const created = create({ robo_claw: { enabled: true } });
		expect(created.transports.map((transport) => transport.id)).toEqual(["robo_claw"]);
		expect(created.errors).toEqual([]);
	});

	it("creates a RoboClaw transport when PI_ROBO_CLAW_TOKEN is present", () => {
		process.env[ROBO_CLAW_TOKEN_ENV] = "secret";
		const created = create({});
		expect(created.transports.map((transport) => transport.id)).toEqual(["robo_claw"]);
		expect(created.errors).toEqual([]);
	});

	it("skips RoboClaw when explicitly disabled", () => {
		process.env[ROBO_CLAW_TOKEN_ENV] = "secret";
		const created = create({ robo_claw: { enabled: false } });
		expect(created.transports).toEqual([]);
		expect(created.skipped).toEqual(["robo_claw"]);
	});
});

