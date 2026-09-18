/**
 * Config file parsing.
 *
 * The config file is untrusted input: it may be hand-edited, shared, or come
 * from a project directory. Every field is validated and every problem is
 * reported with its path instead of being silently ignored.
 *
 * Secrets are never stored here. Transport config may only reference
 * environment variable names (e.g. `tokenEnv`), never token values.
 */

import { DEFAULT_CONFIG, type BridgeConfig } from "./core/types.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface ParsedConfigFile {
	readonly config: Partial<BridgeConfig>;
	readonly transports: Readonly<Record<string, unknown>>;
	readonly errors: readonly string[];
	readonly warnings: readonly string[];
}

const BRIDGE_KEYS = new Set([
	"localCommand",
	"remotePrefixes",
	"botUsername",
	"busyDelivery",
	"pairingTtlMs",
	"pairingDigits",
	"pairingMaxAttempts",
	"allowUsers",
	"requirePairing",
	"requireAddressing",
	"digest",
	"attachments",
	"broadcast",
	"rateLimit",
	"progressMinIntervalMs",
	"remoteToolPolicy",
	"remoteToolApproval",
	"maxChunks",
]);

const TOP_LEVEL_KEYS = new Set(["bridge", "transports"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Context {
	readonly errors: string[];
	readonly warnings: string[];
}

function readString(ctx: Context, source: Record<string, unknown>, key: string, path: string): string | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		ctx.errors.push(`${path}.${key}: expected a string, received ${typeof value}`);
		return undefined;
	}
	return value;
}

function readBoolean(ctx: Context, source: Record<string, unknown>, key: string, path: string): boolean | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		ctx.errors.push(`${path}.${key}: expected a boolean, received ${typeof value}`);
		return undefined;
	}
	return value;
}

function readNumber(ctx: Context, source: Record<string, unknown>, key: string, path: string): number | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		ctx.errors.push(`${path}.${key}: expected a finite number`);
		return undefined;
	}
	return value;
}

function readIntegerInRange(
	ctx: Context,
	source: Record<string, unknown>,
	key: string,
	path: string,
	min: number,
	max: number,
): number | undefined {
	const value = readNumber(ctx, source, key, path);
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < min || value > max) {
		ctx.errors.push(`${path}.${key}: expected an integer between ${min} and ${max}, received ${value}`);
		return undefined;
	}
	return value;
}

function readStringArray(ctx: Context, source: Record<string, unknown>, key: string, path: string): string[] | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		ctx.errors.push(`${path}.${key}: expected an array of strings`);
		return undefined;
	}
	return value as string[];
}

function parseBridgeSection(raw: unknown, ctx: Context): Partial<BridgeConfig> {
	if (!isPlainObject(raw)) {
		ctx.errors.push("bridge: expected an object");
		return {};
	}

	const path = "bridge";
	for (const key of Object.keys(raw)) {
		if (!BRIDGE_KEYS.has(key)) ctx.warnings.push(`${path}.${key}: unknown key, ignored`);
	}

	const config: Mutable<Partial<BridgeConfig>> = {};

	const localCommand = readString(ctx, raw, "localCommand", path);
	if (localCommand !== undefined) {
		if (/^[a-z][a-z0-9-]*$/i.test(localCommand)) config.localCommand = localCommand;
		else ctx.errors.push(`${path}.localCommand: must start with a letter and contain only letters, digits or '-'`);
	}

	const remotePrefixes = readStringArray(ctx, raw, "remotePrefixes", path);
	if (remotePrefixes !== undefined) {
		if (remotePrefixes.some((prefix) => prefix.length === 0)) {
			ctx.errors.push(`${path}.remotePrefixes: entries must not be empty`);
		} else {
			config.remotePrefixes = remotePrefixes;
		}
	}

	const botUsername = readString(ctx, raw, "botUsername", path);
	if (botUsername !== undefined) config.botUsername = botUsername.replace(/^@/, "");

	const busyDelivery = readString(ctx, raw, "busyDelivery", path);
	if (busyDelivery !== undefined) {
		if (busyDelivery === "steer" || busyDelivery === "followUp") config.busyDelivery = busyDelivery;
		else ctx.errors.push(`${path}.busyDelivery: expected "steer" or "followUp", received "${busyDelivery}"`);
	}

	const ttl = readNumber(ctx, raw, "pairingTtlMs", path);
	if (ttl !== undefined) {
		if (ttl >= 10_000 && ttl <= 24 * 60 * 60 * 1000) config.pairingTtlMs = ttl;
		else ctx.errors.push(`${path}.pairingTtlMs: expected between 10000 and 86400000 ms`);
	}

	const digits = readIntegerInRange(ctx, raw, "pairingDigits", path, 4, 10);
	if (digits !== undefined) config.pairingDigits = digits;

	const attempts = readIntegerInRange(ctx, raw, "pairingMaxAttempts", path, 1, 10);
	if (attempts !== undefined) config.pairingMaxAttempts = attempts;

	const allowUsers = readStringArray(ctx, raw, "allowUsers", path);
	if (allowUsers !== undefined) {
		const invalid = allowUsers.filter((entry) => !/^[^:\s]+:\S+$/.test(entry));
		if (invalid.length > 0) {
			ctx.errors.push(`${path}.allowUsers: entries must look like "transport:userId" (invalid: ${invalid.join(", ")})`);
		} else {
			config.allowUsers = allowUsers;
		}
	}

	const requirePairing = readBoolean(ctx, raw, "requirePairing", path);
	if (requirePairing !== undefined) config.requirePairing = requirePairing;

	const requireAddressing = readBoolean(ctx, raw, "requireAddressing", path);
	if (requireAddressing !== undefined) config.requireAddressing = requireAddressing;

	if (raw.digest !== undefined) {
		if (!isPlainObject(raw.digest)) {
			ctx.errors.push(`${path}.digest: expected an object`);
		} else {
			for (const key of Object.keys(raw.digest)) {
				if (key !== "maxLength") ctx.warnings.push(`${path}.digest.${key}: unknown key, ignored`);
			}
			const maxLength = readIntegerInRange(ctx, raw.digest, "maxLength", `${path}.digest`, 100, 10_000);
			if (maxLength !== undefined) config.digest = { maxLength };
		}
	}

	const progressMinIntervalMs = readIntegerInRange(ctx, raw, "progressMinIntervalMs", path, 0, 60_000);
	if (progressMinIntervalMs !== undefined) config.progressMinIntervalMs = progressMinIntervalMs;

	const remoteToolPolicy = readString(ctx, raw, "remoteToolPolicy", path);
	if (remoteToolPolicy !== undefined) {
		if (remoteToolPolicy === "unrestricted" || remoteToolPolicy === "read-only" || remoteToolPolicy === "no-tools") {
			config.remoteToolPolicy = remoteToolPolicy;
		} else {
			ctx.errors.push(
				`${path}.remoteToolPolicy: expected "unrestricted", "read-only" or "no-tools", received "${remoteToolPolicy}"`,
			);
		}
	}

	const remoteToolApproval = readString(ctx, raw, "remoteToolApproval", path);
	if (remoteToolApproval !== undefined) {
		if (remoteToolApproval === "off" || remoteToolApproval === "each") {
			config.remoteToolApproval = remoteToolApproval;
		} else {
			ctx.errors.push(`${path}.remoteToolApproval: expected "off" or "each", received "${remoteToolApproval}"`);
		}
	}

	const maxChunks = readIntegerInRange(ctx, raw, "maxChunks", path, 1, 50);
	if (maxChunks !== undefined) config.maxChunks = maxChunks;

	if (raw.broadcast !== undefined) {
		const broadcastPath = `${path}.broadcast`;
		if (!isPlainObject(raw.broadcast)) {
			ctx.errors.push(`${broadcastPath}: expected an object`);
		} else {
			for (const key of Object.keys(raw.broadcast)) {
				if (key !== "progress" && key !== "replies") {
					ctx.warnings.push(`${broadcastPath}.${key}: unknown key, ignored`);
				}
			}
			// Built from defaults so a partial section never yields a half policy.
			const broadcast = { ...DEFAULT_CONFIG.broadcast };
			const progress = readBoolean(ctx, raw.broadcast, "progress", broadcastPath);
			if (progress !== undefined) broadcast.progress = progress;
			const replies = readBoolean(ctx, raw.broadcast, "replies", broadcastPath);
			if (replies !== undefined) broadcast.replies = replies;
			config.broadcast = broadcast;
		}
	}

	if (raw.rateLimit !== undefined) {
		const ratePath = `${path}.rateLimit`;
		if (!isPlainObject(raw.rateLimit)) {
			ctx.errors.push(`${ratePath}: expected an object`);
		} else {
			for (const key of Object.keys(raw.rateLimit)) {
				if (key !== "promptsPerMinute" && key !== "commandsPerMinute") {
					ctx.warnings.push(`${ratePath}.${key}: unknown key, ignored`);
				}
			}
			// Built from defaults so a partial section never yields a half policy.
			const rateLimit = { ...DEFAULT_CONFIG.rateLimit };
			const prompts = readIntegerInRange(ctx, raw.rateLimit, "promptsPerMinute", ratePath, 0, 600);
			if (prompts !== undefined) rateLimit.promptsPerMinute = prompts;
			const commands = readIntegerInRange(ctx, raw.rateLimit, "commandsPerMinute", ratePath, 0, 600);
			if (commands !== undefined) rateLimit.commandsPerMinute = commands;
			config.rateLimit = rateLimit;
		}
	}

	if (raw.attachments !== undefined) {
		const attachmentPath = `${path}.attachments`;
		if (!isPlainObject(raw.attachments)) {
			ctx.errors.push(`${attachmentPath}: expected an object`);
		} else {
			for (const key of Object.keys(raw.attachments)) {
				if (!["allowedMediaTypes", "maxCount", "maxBytes"].includes(key)) {
					ctx.warnings.push(`${attachmentPath}.${key}: unknown key, ignored`);
				}
			}

			// Built from defaults because the policy is validated as a whole: a
			// partially invalid section must not produce a half-applied policy.
			const attachments = { ...DEFAULT_CONFIG.attachments };
			let valid = true;

			const mediaTypes = readStringArray(ctx, raw.attachments, "allowedMediaTypes", attachmentPath);
			if (mediaTypes !== undefined) {
				if (mediaTypes.length === 0 || mediaTypes.some((entry) => entry.trim().length === 0)) {
					ctx.errors.push(`${attachmentPath}.allowedMediaTypes: entries must not be empty`);
					valid = false;
				} else {
					attachments.allowedMediaTypes = mediaTypes;
				}
			}

			const maxCount = readIntegerInRange(ctx, raw.attachments, "maxCount", attachmentPath, 1, 10);
			if (maxCount !== undefined) attachments.maxCount = maxCount;

			const maxBytes = readIntegerInRange(ctx, raw.attachments, "maxBytes", attachmentPath, 1024, 50 * 1024 * 1024);
			if (maxBytes !== undefined) attachments.maxBytes = maxBytes;

			if (valid) config.attachments = attachments;
		}
	}

	return config;
}

export function parseConfigFile(input: unknown): ParsedConfigFile {
	const ctx: Context = { errors: [], warnings: [] };

	if (!isPlainObject(input)) {
		return {
			config: {},
			transports: {},
			errors: ["config: expected a JSON object at the top level"],
			warnings: [],
		};
	}

	for (const key of Object.keys(input)) {
		if (!TOP_LEVEL_KEYS.has(key)) ctx.warnings.push(`${key}: unknown top-level key, ignored`);
	}

	const config = input.bridge === undefined ? {} : parseBridgeSection(input.bridge, ctx);

	let transports: Readonly<Record<string, unknown>> = {};
	if (input.transports !== undefined) {
		if (isPlainObject(input.transports)) transports = input.transports;
		else ctx.errors.push("transports: expected an object");
	}

	return { config, transports, errors: ctx.errors, warnings: ctx.warnings };
}
