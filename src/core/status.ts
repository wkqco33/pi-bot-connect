/**
 * Local reports: the footer label, `/connect status` and `/connect doctor`.
 *
 * These live in the core because they are formatting policy: which state counts
 * as healthy, what a standby transport says, what the operator is told to check.
 * `src/index.ts` only collects the data and hands it over.
 */

export type TransportStatusKind = "running" | "standby" | "error" | "stopped";

export interface TransportStatusEntry {
	readonly id: string;
	readonly status: TransportStatusKind;
	/** Short human detail (holder process, diagnosis). Never a secret. */
	readonly detail?: string;
}

export interface StatusLabelInput {
	readonly label: string;
	readonly transports: readonly TransportStatusEntry[];
}

function idsWith(entries: readonly TransportStatusEntry[], status: TransportStatusKind): string[] {
	return entries.filter((entry) => entry.status === status).map((entry) => entry.id);
}

function detailSuffix(entry: TransportStatusEntry): string {
	return entry.detail === undefined || entry.detail.length === 0 ? "" : ` — ${entry.detail}`;
}

/**
 * Footer label. A standby transport is never listed as if it were running: that
 * lie is what makes a user think remote messages are arriving in this terminal.
 */
export function formatStatusLabel(input: StatusLabelInput): string {
	const { label, transports } = input;
	const running = idsWith(transports, "running");
	const standby = idsWith(transports, "standby");
	const failed = idsWith(transports, "error");

	if (running.length > 0) {
		const standbyMark = standby.length > 0 ? ` (+${standby.length} standby)` : "";
		const errorMark = failed.length > 0 ? ` (+${failed.length} error)` : "";
		return `${label}: ${running.join(",")}${standbyMark}${errorMark}`;
	}
	if (standby.length > 0) return `${label}: standby (${standby.join(",")})`;
	if (failed.length > 0) return `${label}: error (${failed.join(",")})`;
	return `${label}: no transports`;
}

export interface StatusReportInput {
	readonly label: string;
	readonly extensionLine: string;
	readonly transports: readonly TransportStatusEntry[];
	readonly availableTransports: readonly string[];
	readonly trusted: number;
	readonly conversations: number;
	readonly paused: readonly string[];
	readonly pending: number;
	readonly localCommand: string;
}

export function formatStatusReport(input: StatusReportInput): string {
	const lines = [
		`${input.label} status`,
		input.extensionLine,
		`- transports: ${input.transports.length > 0 ? input.transports.map((entry) => `${entry.id} (${entry.status}${detailSuffix(entry)})`).join(", ") : "(none configured)"}`,
		`- paired chats: ${input.trusted}`,
		`- conversations: ${input.conversations}`,
		`- paused: ${input.paused.length > 0 ? input.paused.join(", ") : "none"}`,
		`- pending codes: ${input.pending}`,
	];

	if (input.transports.length === 0 && input.availableTransports.length > 0) {
		lines.push(
			"",
			`Available transports: ${input.availableTransports.join(", ")}. Configure one under "transports" in the config file.`,
		);
	}

	lines.push(
		"",
		`Local commands: /${input.localCommand} status|doctor|version|pair|digest|pause|resume|disconnect|config`,
	);
	return lines.join("\n");
}

export interface DoctorReportInput {
	readonly label: string;
	readonly extensionLine: string;
	readonly transports: readonly TransportStatusEntry[];
	readonly sessionKey: string;
	readonly stateFile: string;
	readonly persistent: boolean;
	readonly trusted: number;
	readonly conversations: number;
	readonly pending: number;
}

export interface DoctorReport {
	readonly text: string;
	readonly healthy: boolean;
}

/**
 * Standby is not a failure: the credential is in use by a process that is doing
 * the work. Only `error` makes the report unhealthy.
 */
export function formatDoctorReport(input: DoctorReportInput): DoctorReport {
	const lines = [`${input.label} doctor`, input.extensionLine];

	if (input.transports.length === 0) {
		lines.push("- transports: none registered");
	} else {
		for (const entry of input.transports) {
			lines.push(`- ${entry.id}: ${entry.status}${detailSuffix(entry)}`);
		}
	}

	lines.push(
		`- session key: ${input.sessionKey}`,
		`- state file: ${input.stateFile} (${input.persistent ? "persistent" : "in-memory"})`,
		`- paired chats: ${input.trusted}`,
		`- broadcast targets: ${input.conversations}`,
		`- pending codes: ${input.pending}`,
		"",
		"If a transport is not working, check in this order:",
		"1. credential present in the environment (never in the config file)",
		"2. bot invited/installed where you are talking to it",
		"3. privileged intents or message scopes enabled in the platform app settings",
		"4. no other pi process holds the same bot credential",
	);

	const healthy = !input.transports.some((entry) => entry.status === "error");
	return { text: lines.join("\n"), healthy };
}
