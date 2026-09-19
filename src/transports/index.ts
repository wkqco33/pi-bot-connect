/**
 * Transport registry.
 *
 * Adding a messenger means adding a factory here that returns a `Transport`.
 * Nothing else changes: the adapter inherits routing, pairing, redaction,
 * chunking and digest behaviour for free, and must satisfy the conformance
 * checklist in `docs/architecture.md` §5.
 */

import type { Logger, Transport } from "../core/types.js";
import { DiscordTransport } from "./discord/index.js";
import { TelegramTransport } from "./telegram/index.js";
import { RoboClawTransport } from "./robo_claw/index.js";

export interface TransportFactoryContext {
	readonly transportConfig: Readonly<Record<string, unknown>>;
	/** Directory for single-instance lock files. Never contains credentials. */
	readonly lockDir: string;
	readonly logger: Logger;
}

export interface TransportFactory {
	readonly id: string;
	/** Returns null when the transport is not configured; throws on bad config. */
	create(context: TransportFactoryContext): Transport | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Readonly<Record<string, unknown>>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

const discordFactory: TransportFactory = {
	id: "discord",
	create(context) {
		const raw = context.transportConfig.discord;
		const config = isRecord(raw) ? raw : {};
		const explicitlyEnabled = config.enabled === true;
		const tokenEnv = readString(config, "tokenEnv") ?? "PI_DISCORD_TOKEN";
		const token = process.env[tokenEnv];

		if (token === undefined || token.length === 0) {
			// Auto-detected transports stay quiet; an explicitly enabled one that
			// cannot possibly work is a configuration error worth surfacing.
			if (explicitlyEnabled) {
				throw new Error(
					`Discord is enabled but $${tokenEnv} is not set. Export the bot token in the environment; never put it in the config file.`,
				);
			}
			return null;
		}

		const lockStaleMs = typeof config.lockStaleMs === "number" ? config.lockStaleMs : undefined;
		return new DiscordTransport({
			token,
			lockDir: context.lockDir,
			logger: context.logger,
			...(lockStaleMs === undefined ? {} : { lockStaleMs }),
		});
	},
};

const telegramFactory: TransportFactory = {
	id: "telegram",
	create(context) {
		const raw = context.transportConfig.telegram;
		const config = isRecord(raw) ? raw : {};
		const explicitlyEnabled = config.enabled === true;
		const tokenEnv = readString(config, "tokenEnv") ?? "PI_TELEGRAM_TOKEN";
		const token = process.env[tokenEnv];

		if (token === undefined || token.length === 0) {
			if (explicitlyEnabled) {
				throw new Error(
					`Telegram is enabled but $${tokenEnv} is not set. Export the bot token in the environment; never put it in the config file.`,
				);
			}
			return null;
		}

		const lockStaleMs = typeof config.lockStaleMs === "number" ? config.lockStaleMs : undefined;
		return new TelegramTransport({
			token,
			lockDir: context.lockDir,
			logger: context.logger,
			...(lockStaleMs === undefined ? {} : { lockStaleMs }),
		});
	},
};

const roboClawFactory: TransportFactory = {
	id: "robo_claw",
	create(context) {
		const raw = context.transportConfig.robo_claw;
		const config = isRecord(raw) ? raw : {};
		const explicitlyEnabled = config.enabled === true;
		const tokenEnv = readString(config, "tokenEnv") ?? "PI_ROBO_CLAW_TOKEN";
		const token = process.env[tokenEnv];

		const autoDetected =
			(token !== undefined && token.length > 0) ||
			process.env.PI_ROBO_CLAW_ENABLED === "1" ||
			process.env.PI_ROBO_CLAW_ENABLED === "true";

		if (!explicitlyEnabled && !autoDetected) {
			return null;
		}

		const port = typeof config.port === "number" ? config.port : undefined;
		const host = readString(config, "host");
		const lockStaleMs = typeof config.lockStaleMs === "number" ? config.lockStaleMs : undefined;

		return new RoboClawTransport({
			lockDir: context.lockDir,
			logger: context.logger,
			...(port !== undefined ? { port } : {}),
			...(host !== undefined ? { host } : {}),
			...(token !== undefined ? { token } : {}),
			...(lockStaleMs !== undefined ? { lockStaleMs } : {}),
		});
	},
};

const FACTORIES: readonly TransportFactory[] = [discordFactory, telegramFactory, roboClawFactory];


export function listTransportFactories(): readonly TransportFactory[] {
	return FACTORIES;
}

export interface CreateTransportsOptions {
	readonly transportConfig: Readonly<Record<string, unknown>>;
	readonly lockDir: string;
	readonly logger: Logger;
}

export interface CreatedTransports {
	readonly transports: Transport[];
	readonly skipped: string[];
	/** Configuration problems, surfaced to the user instead of thrown. */
	readonly errors: string[];
}

export function createTransports(options: CreateTransportsOptions): CreatedTransports {
	const transports: Transport[] = [];
	const skipped: string[] = [];
	const errors: string[] = [];
	const { transportConfig, lockDir, logger } = options;

	for (const factory of FACTORIES) {
		// An entry may be disabled explicitly with `{ enabled: false }`.
		const entry = transportConfig[factory.id];
		if (isRecord(entry) && entry.enabled === false) {
			skipped.push(factory.id);
			continue;
		}

		try {
			const transport = factory.create({ transportConfig, lockDir, logger });
			if (transport) transports.push(transport);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}

	return { transports, skipped, errors };
}
