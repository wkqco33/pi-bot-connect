import { describe, expect, it } from "vitest";
import { ATTACHMENT_FALLBACK_PROMPT, normalizeIncoming, route, type RouterInput } from "./router.js";
import { resolveConfig } from "./types.js";
import type { Envelope } from "./types.js";

function envelope(overrides: Partial<Envelope> = {}): Envelope {
	return {
		transport: "fake",
		conversationId: "c1",
		userId: "u1",
		timestamp: 0,
		text: "",
		isDirect: true,
		...overrides,
	};
}

const CONFIG = resolveConfig({
	botUsername: "piBot",
	remotePrefixes: ["/", "connect ", "bot "],
});

type RouteState = Pick<RouterInput, "authenticated" | "busy" | "acceptsAttachments"> & {
	pendingChallenge?: RouterInput["pendingChallenge"];
};

function routeEnvelope(text: string, overrides: Partial<Envelope> = {}, state: Partial<RouteState> = {}) {
	return route({
		envelope: envelope({ text, ...overrides }),
		config: CONFIG,
		authenticated: state.authenticated ?? true,
		busy: state.busy ?? false,
		acceptsAttachments: state.acceptsAttachments ?? false,
		...(state.pendingChallenge === undefined ? {} : { pendingChallenge: state.pendingChallenge }),
		now: 1_000,
		random: () => 0,
	});
}

describe("normalizeIncoming", () => {
	it("strips a leading mention and reports it as addressing", () => {
		expect(normalizeIncoming(envelope({ text: "@piBot fix it", isDirect: false }), CONFIG)).toEqual({
			text: "fix it",
			addressed: true,
		});
	});

	it("treats a direct message as addressed without a mention", () => {
		expect(normalizeIncoming(envelope({ text: "fix it", isDirect: true }), CONFIG)).toEqual({
			text: "fix it",
			addressed: true,
		});
	});

	it("treats a command prefix as addressing", () => {
		expect(normalizeIncoming(envelope({ text: "/status", isDirect: false }), CONFIG).addressed).toBe(true);
		expect(normalizeIncoming(envelope({ text: "bot status", isDirect: false }), CONFIG).addressed).toBe(true);
	});

	it("leaves unaddressed channel chatter alone", () => {
		expect(normalizeIncoming(envelope({ text: "just chatting", isDirect: false }), CONFIG)).toEqual({
			text: "just chatting",
			addressed: false,
		});
	});
});

describe("route — pairing", () => {
	it("issues a challenge to an unknown user", () => {
		const actions = routeEnvelope("hello", {}, { authenticated: false });
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ type: "pair-required", reason: "new" });
	});

	it("pairs on the correct code", () => {
		const actions = routeEnvelope("000000", {}, {
			authenticated: false,
			pendingChallenge: { code: "000000", expiresAt: 2_000, attempts: 0 },
		});
		expect(actions).toEqual([{ type: "pair" }]);
	});

	it("counts a wrong code against the challenge", () => {
		const actions = routeEnvelope("999999", {}, {
			authenticated: false,
			pendingChallenge: { code: "000000", expiresAt: 2_000, attempts: 0 },
		});
		expect(actions[0]).toMatchObject({ type: "pair-required", reason: "mismatch" });
		expect(actions[0]).toMatchObject({ pending: { attempts: 1 } });
	});

	it("never routes prompts before pairing", () => {
		const actions = routeEnvelope("delete everything", {}, { authenticated: false });
		expect(actions.every((action) => action.type !== "prompt")).toBe(true);
	});
});

describe("route — commands and prompts", () => {
	it("routes a known command", () => {
		expect(routeEnvelope("/status")).toEqual([{ type: "command", name: "status", args: "" }]);
	});

	it("routes a command alias", () => {
		expect(routeEnvelope("/stop")).toEqual([{ type: "command", name: "abort", args: "" }]);
	});

	it("routes a plain direct message as an idle prompt", () => {
		expect(routeEnvelope("run the tests")).toEqual([{ type: "prompt", text: "run the tests" }]);
	});

	it("uses followUp delivery while the agent is busy", () => {
		expect(routeEnvelope("run the tests", {}, { busy: true })).toEqual([
			{ type: "prompt", text: "run the tests", deliverAs: "followUp" },
		]);
	});

	it("honors a steer busy policy", () => {
		const actions = route({
			envelope: envelope({ text: "stop that" }),
			config: resolveConfig({ busyDelivery: "steer" }),
			authenticated: true,
			busy: true,
			acceptsAttachments: false,
			now: 0,
			random: () => 0,
		});
		expect(actions).toEqual([{ type: "prompt", text: "stop that", deliverAs: "steer" }]);
	});

	it("commands are still routed while the agent is busy", () => {
		expect(routeEnvelope("/status", {}, { busy: true })).toEqual([{ type: "command", name: "status", args: "" }]);
	});
});

describe("route — addressing policy", () => {
	it("ignores unaddressed channel chatter", () => {
		expect(routeEnvelope("just chatting", { isDirect: false })).toEqual([
			{ type: "ignore", reason: "unaddressed" },
		]);
	});

	it("accepts channel messages that mention the bot and strips the mention", () => {
		expect(routeEnvelope("@piBot run the tests", { isDirect: false })).toEqual([
			{ type: "prompt", text: "run the tests" },
		]);
	});

	it("accepts unaddressed chatter when requiring addressing is disabled", () => {
		const actions = route({
			envelope: envelope({ text: "just chatting", isDirect: false }),
			config: resolveConfig({ requireAddressing: false }),
			authenticated: true,
			busy: false,
			acceptsAttachments: false,
			now: 0,
			random: () => 0,
		});
		expect(actions).toEqual([{ type: "prompt", text: "just chatting" }]);
	});
});

describe("route — empty messages", () => {
	it("ignores an empty message", () => {
		expect(routeEnvelope("   ")).toEqual([{ type: "ignore", reason: "empty" }]);
	});
});

describe("route — attachments", () => {
	const image = { kind: "image", mediaType: "image/png", ref: "file-1" } as const;

	it("rejects an attachment-only message when the host cannot forward it", () => {
		expect(routeEnvelope("", { attachments: [image] })).toEqual([{ type: "unsupported", feature: "attachments" }]);
	});

	it("rejects an attachment even when it carries a caption", () => {
		// Forwarding the caption alone would silently drop the image the user sent.
		expect(routeEnvelope("what is this?", { attachments: [image] })).toEqual([
			{ type: "unsupported", feature: "attachments" },
		]);
	});

	it("substitutes a fallback prompt when forwarding is supported", () => {
		const actions = routeEnvelope("", { attachments: [image] }, { acceptsAttachments: true });
		expect(actions).toEqual([{ type: "prompt", text: ATTACHMENT_FALLBACK_PROMPT }]);
	});

	it("keeps the caption when forwarding is supported", () => {
		const actions = routeEnvelope(
			"what does this error mean?",
			{ attachments: [image] },
			{ acceptsAttachments: true },
		);
		expect(actions).toEqual([{ type: "prompt", text: "what does this error mean?" }]);
	});

	it("still ignores an unaddressed channel attachment", () => {
		expect(routeEnvelope("look", { attachments: [image], isDirect: false })).toEqual([
			{ type: "ignore", reason: "unaddressed" },
		]);
	});
});
