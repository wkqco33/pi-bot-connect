/**
 * Remote-turn tool policy (G1: prompt-injection defense).
 *
 * A remote prompt is untrusted input. It can ask the agent to read a local file
 * and post it back to the chat. The only structural defense is to restrict what
 * the agent may *do* on a turn that a messenger started, without touching local
 * turns.
 *
 * The decision is a pure function of (policy, tool name) so it is testable here
 * and the pi adapter stays a thin shell around `pi.on("tool_call")`.
 */

export type RemoteToolPolicy = "unrestricted" | "read-only" | "no-tools";

/** Tools that can only observe the workspace. Everything else can mutate or exfiltrate. */
export const READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

export type ToolAccess = "allow" | "block";

export function decideRemoteToolAccess(policy: RemoteToolPolicy, toolName: string): ToolAccess {
	if (policy === "unrestricted") return "allow";
	if (policy === "no-tools") return "block";
	// Unknown tools are blocked rather than assumed safe.
	return READ_ONLY_TOOLS.includes(toolName) ? "allow" : "block";
}

/** Reason handed to pi's `tool_call` handler. Names the tool; never echoes arguments. */
export function remoteToolBlockReason(policy: RemoteToolPolicy, toolName: string): string {
	if (policy === "no-tools") {
		return `Tool '${toolName}' is blocked because this turn came from a messenger. Ask the operator to run it locally.`;
	}
	return `Tool '${toolName}' is not allowed for messenger-originated turns (read-only mode). Ask the operator to run it locally.`;
}

/** Operator-facing approval mode for remote turns. */
export type RemoteToolApproval = "off" | "each";

export interface RemoteToolApprovalPrompt {
	readonly title: string;
	readonly message: string;
}

/**
 * Local terminal confirmation for a single remote tool call.
 * Renders the tool *name* only; arguments routinely carry paths and secrets.
 */
export function remoteToolApprovalPrompt(toolName: string): RemoteToolApprovalPrompt {
	return {
		title: `Remote tool call: ${toolName}`,
		message: `A messenger-originated turn wants to run '${toolName}'. Allow it?`,
	};
}

/** Reason handed to pi when the operator declines the approval prompt. */
export function remoteToolDeclinedReason(toolName: string): string {
	return `The operator declined '${toolName}' for this messenger-originated turn.`;
}
