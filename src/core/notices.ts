/**
 * User-facing notices the bridge sends on its own behalf.
 *
 * Kept in one place so wording is reviewable and so that a message can never
 * accidentally claim a capability we do not have. The bridge must not tell the
 * model an image exists when the host cannot forward it.
 */

/** The host cannot forward attachment bytes at all. */
export const ATTACHMENTS_UNSUPPORTED_NOTICE =
	"Attachments are not supported yet. Please describe what you need in text instead.";

/** The attachment is not a media type the model can read. */
export const ATTACHMENT_NOT_AN_IMAGE_NOTICE =
	"Only images can be forwarded right now. Please describe that file in text instead.";

/** The attachment exceeds the configured size cap. */
export const ATTACHMENT_TOO_LARGE_NOTICE = "That image is too large to forward. Please send a smaller one.";

/** The message carried more attachments than the policy allows. */
export const ATTACHMENT_TOO_MANY_NOTICE =
	"Too many attachments in one message. Please send the images a few at a time.";

/** Downloading the attachment failed, so nothing was forwarded. */
export const ATTACHMENT_FETCH_FAILED_NOTICE =
	"I could not download that image, so I did not send it. Try again or describe it in text.";

/** Sent when one outbound body was longer than the configured chunk budget. */
export function truncatedNotice(dropped: number): string {
	return `[truncated: ${dropped} more message(s) were not sent]`;
}

/** Sent when a prompt arrives for a paused conversation. */
export const PAUSED_NOTICE = "Delivery is paused. Send /resume to continue.";

/** Sent once when an identity exceeds the configured remote rate limit. */
export const RATE_LIMITED_NOTICE = "Too many messages. Please wait a moment before sending more.";

/** Sent when the bridge cannot resolve a command the router approved. */
export function unknownCommandNotice(name: string): string {
	return `Unknown command '${name}'.`;
}
