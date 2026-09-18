/**
 * User-facing notices the bridge sends on its own behalf.
 *
 * Kept in one place so wording is reviewable and so that a message can never
 * accidentally claim a capability we do not have. The bridge must not tell the
 * model an image exists when the host cannot forward it.
 */

/** Sent when a remote user sends a file/image the bridge cannot forward yet. */
export const ATTACHMENTS_UNSUPPORTED_NOTICE =
	"Attachments are not supported yet. Please describe what you need in text instead.";

/** Sent when a prompt arrives for a paused conversation. */
export const PAUSED_NOTICE = "Delivery is paused. Send /resume to continue.";

/** Sent when the bridge cannot resolve a command the router approved. */
export function unknownCommandNotice(name: string): string {
	return `Unknown command '${name}'.`;
}
