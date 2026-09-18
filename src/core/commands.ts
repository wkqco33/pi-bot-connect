/**
 * Remote command surface.
 *
 * Parsing is deliberately conservative: a message becomes a command only when
 * it matches a configured prefix **and** the first word is a known command
 * (or alias). Everything else is a normal prompt, so channel chatter is never
 * swallowed by the bridge.
 */

import { stripLeadingMention } from "./text.js";
import type { BridgeConfig, TransportId } from "./types.js";

export interface RemoteCommandContext {
	readonly transport: TransportId;
	readonly identity: string;
	readonly conversationId: string;
	readonly config: BridgeConfig;
	readonly sessionName?: string;
	readonly cwd?: string;
	readonly busy: boolean;
	readonly paused: boolean;
	readonly now: number;
	readonly pairedAt?: number;
}

export type CommandEffect =
	| { readonly type: "pause" }
	| { readonly type: "resume" }
	| { readonly type: "disconnect" }
	| { readonly type: "abort" };

export interface RemoteCommandResult {
	readonly text: string;
	readonly effect?: CommandEffect;
}

export interface RemoteCommandSpec {
	readonly name: string;
	readonly summary: string;
	readonly usage?: string;
	readonly aliases?: readonly string[];
	readonly run: (args: string, ctx: RemoteCommandContext) => RemoteCommandResult;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

const ALIASES = {
	"?": "help",
	h: "help",
	commands: "help",
	s: "status",
	state: "status",
	who: "whoami",
	me: "whoami",
	stop: "abort",
	cancel: "abort",
	hold: "pause",
	unhold: "resume",
	continue: "resume",
	bye: "disconnect",
	unpair: "disconnect",
} as const;

const ALIAS_MAP: ReadonlyMap<string, string> = new Map(Object.entries(ALIASES));

export const REMOTE_COMMANDS: readonly RemoteCommandSpec[] = [
	{
		name: "help",
		summary: "Show the remote command list",
		run: () => ({ text: remoteHelpText() }),
	},
	{
		name: "status",
		summary: "Show bridge, session and agent state",
		run: (_args, ctx) => ({ text: statusText(ctx) }),
	},
	{
		name: "pause",
		summary: "Stop forwarding prompts; local session keeps running",
		run: () => ({ text: "Delivery paused. Send /resume to continue.", effect: { type: "pause" } }),
	},
	{
		name: "resume",
		summary: "Resume forwarding prompts",
		run: () => ({ text: "Delivery resumed.", effect: { type: "resume" } }),
	},
	{
		name: "abort",
		summary: "Abort the current agent turn",
		usage: "",
		run: () => ({ text: "Abort requested.", effect: { type: "abort" } }),
	},
	{
		name: "whoami",
		summary: "Show the paired identity for this chat",
		run: (_args, ctx) => ({ text: `${ctx.identity} (${ctx.transport})` }),
	},
	{
		name: "disconnect",
		summary: "Revoke this chat's pairing for the current session",
		run: () => ({ text: "This chat is no longer paired.", effect: { type: "disconnect" } }),
	},
];

export function remoteCommandNames(): string[] {
	const names = new Set<string>();
	for (const command of REMOTE_COMMANDS) {
		names.add(command.name);
		for (const alias of command.aliases ?? []) names.add(alias);
	}
	for (const alias of ALIAS_MAP.keys()) names.add(alias);
	return [...names];
}

/** Resolves a typed name (or alias) to the canonical command name. */
export function resolveRemoteCommandName(name: string): string | null {
	const normalized = name.trim().toLowerCase().replace(/^\/+/, "");
	if (normalized.length === 0) return null;
	const canonical = ALIAS_MAP.get(normalized) ?? normalized;
	return REMOTE_COMMANDS.some((command) => command.name === canonical) ? canonical : null;
}

export function findRemoteCommand(name: string): RemoteCommandSpec | null {
	const canonical = resolveRemoteCommandName(name);
	if (!canonical) return null;
	return REMOTE_COMMANDS.find((command) => command.name === canonical) ?? null;
}

export function executeRemoteCommand(
	name: string,
	args: string,
	ctx: RemoteCommandContext,
): RemoteCommandResult | null {
	const command = findRemoteCommand(name);
	if (!command) return null;
	return command.run(args, ctx);
}

function usageSuffix(command: RemoteCommandSpec): string {
	if (command.usage === undefined || command.usage.length === 0) return "";
	return ` ${command.usage}`;
}

export function remoteHelpText(): string {
	const lines = ["pi-bot-connect commands:"];
	for (const command of REMOTE_COMMANDS) {
		lines.push(`  /${command.name}${usageSuffix(command)} — ${command.summary}`);
	}
	lines.push("", "Anything that is not a command is sent to pi as a prompt.");
	return lines.join("\n");
}

function statusText(ctx: RemoteCommandContext): string {
	const lines = [
		"pi-bot-connect status",
		`- transport: ${ctx.transport}`,
		`- identity: ${ctx.identity}`,
		`- session: ${ctx.sessionName ?? "(unnamed)"}`,
		`- cwd: ${ctx.cwd ?? "(unknown)"}`,
		`- agent: ${ctx.busy ? "busy" : "idle"}`,
		`- delivery: ${ctx.paused ? "paused" : "active"}`,
	];
	if (ctx.pairedAt !== undefined) {
		lines.push(`- paired: ${formatDuration(ctx.now - ctx.pairedAt)} ago`);
	}
	return lines.join("\n");
}

export interface CommandParseOptions {
	readonly prefixes: readonly string[];
	readonly botUsername?: string;
	/** Names and aliases accepted as commands. */
	readonly knownCommands: readonly string[];
}

export interface ParsedRemoteCommand {
	readonly name: string;
	readonly args: string;
	readonly raw: string;
}

export function parseRemoteCommand(text: string, options: CommandParseOptions): ParsedRemoteCommand | null {
	const trimmed = text.trim();
	if (trimmed.length === 0) return null;

	let body: string | null = null;
	if (options.botUsername) {
		const stripped = stripLeadingMention(trimmed, options.botUsername);
		if (stripped.mentioned) body = stripped.text;
	}
	if (body === null) {
		for (const prefix of options.prefixes) {
			if (prefix.length === 0) continue;
			if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
				body = trimmed.slice(prefix.length).trim();
				break;
			}
		}
	}
	if (body === null) return null;

	// A bare prefix ("/" or "@bot") is a help request.
	if (body.length === 0) {
		return resolveRemoteCommandName("help") ? { name: "help", args: "", raw: trimmed } : null;
	}

	const spaceIndex = body.search(/\s/);
	const rawName = spaceIndex === -1 ? body : body.slice(0, spaceIndex);
	const canonical = resolveRemoteCommandName(rawName);
	if (!canonical) return null;

	const args = spaceIndex === -1 ? "" : body.slice(spaceIndex).trim();
	return { name: canonical, args, raw: trimmed };
}
