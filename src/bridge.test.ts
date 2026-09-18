import { describe, expect, it } from "vitest";
import { Bridge, MemoryBridgeStore, type BridgeHost } from "./bridge.js";
import { measureLength } from "./core/chunk.js";
import { createLogger, MemoryLogSink } from "./core/logger.js";
import { ATTACHMENTS_UNSUPPORTED_NOTICE, ATTACHMENT_FETCH_FAILED_NOTICE, ATTACHMENT_NOT_AN_IMAGE_NOTICE, ATTACHMENT_TOO_LARGE_NOTICE, PAUSED_NOTICE } from "./core/notices.js";
import {
	noopLogger,
	type BridgeConfig,
	type FetchedAttachment,
	type InboundAttachment,
	type PromptImage,
	type PromptOptions,
	type SendReceipt,
	type Transport,
	type TransportCapabilities,
} from "./core/types.js";
import { FAKE_CAPABILITIES, FakeTransport } from "./transports/fake.js";

/** A transport that can resolve one small png. */
function attachmentResolver(data = "aGVsbG8="): (attachment: InboundAttachment) => Promise<FetchedAttachment> {
	return (attachment) => Promise.resolve({ mediaType: attachment.mediaType, data });
}

const PNG = { kind: "image", mediaType: "image/png", ref: "file-1" } as const;

class FakeHost implements BridgeHost {
	readonly cwd = "/work/project";
	sessionName: string | undefined = "test-session";
	logger = noopLogger;
	acceptsAttachments = false;
	readonly prompts: Array<{ text: string; deliverAs?: "steer" | "followUp"; images?: readonly PromptImage[] }> = [];
	readonly notifications: string[] = [];
	aborts = 0;
	idle = true;
	clock = 1_000;
	rng: () => number = () => 0;

	sendPrompt(text: string, options?: PromptOptions): void {
		const { deliverAs, images } = options ?? {};
		this.prompts.push({
			text,
			...(deliverAs === undefined ? {} : { deliverAs }),
			...(images === undefined ? {} : { images }),
		});
	}

	abort(): void {
		this.aborts++;
	}

	isIdle(): boolean {
		return this.idle;
	}

	notify(text: string): void {
		this.notifications.push(text);
	}

	now(): number {
		return this.clock;
	}

	random(): number {
		return this.rng();
	}
}

/** Fails to start, like a bad token or a held lock. */
class FailingTransport implements Transport {
	readonly id = "failing";
	readonly capabilities = FAKE_CAPABILITIES;

	constructor(private readonly message: string) {}

	start(): Promise<void> {
		return Promise.reject(new Error(this.message));
	}

	stop(): Promise<void> {
		return Promise.resolve();
	}

	send(): Promise<SendReceipt> {
		return Promise.reject(new Error("not started"));
	}
}

/** Starts fine but throws while shutting down. */
class FailingStopTransport implements Transport {
	readonly id = "failing-stop";
	readonly capabilities = FAKE_CAPABILITIES;

	start(): Promise<void> {
		return Promise.resolve();
	}

	stop(): Promise<void> {
		return Promise.reject(new Error("cannot stop"));
	}

	send(): Promise<SendReceipt> {
		return Promise.resolve({ messageId: "failing-stop-1" });
	}
}

/** Contributes health detail for `/connect doctor`. */
class DiagnosingTransport extends FakeTransport {
	constructor() {
		super({ id: "diagnosing" });
	}

	diagnose(): string {
		return "connected as bot#1";
	}
}

interface Harness {
	host: FakeHost;
	bridge: Bridge;
	transport: FakeTransport;
	store: MemoryBridgeStore;
}

async function setup(
	config: Partial<BridgeConfig> = {},
	capabilities: Partial<TransportCapabilities> = {},
	options: {
		pair?: boolean;
		attachmentResolver?: (attachment: InboundAttachment) => Promise<FetchedAttachment>;
		typing?: boolean;
	} = {},
): Promise<Harness> {
	const host = new FakeHost();
	const store = new MemoryBridgeStore();
	const bridge = new Bridge({ host, config, store });
	const transport = new FakeTransport({
		capabilities,
		...(options.attachmentResolver === undefined ? {} : { attachmentResolver: options.attachmentResolver }),
		...(options.typing === undefined ? {} : { typing: options.typing }),
	});
	await bridge.register(transport);
	if (options.pair !== false) {
		// Real flow: first contact issues a challenge, the operator reads the code
		// in the terminal, then the user types it.
		await transport.inject({ text: "hello" });
		await transport.inject({ text: "000000" });
		transport.sent.length = 0;
		host.notifications.length = 0;
	}
	return { host, bridge, transport, store };
}

describe("Bridge — pairing gate", () => {
	it("challenges an unknown user and never forwards the prompt", async () => {
		const { host, transport, store } = await setup({}, {}, { pair: false });
		await transport.inject({ text: "deploy to production" });
		expect(transport.sent).toHaveLength(1);
		expect(transport.sent[0]?.text).toContain("not paired with a pi session");
		expect(host.prompts).toEqual([]);
		expect(store.isTrusted("fake:user-1")).toBe(false);
	});

	it("shows the pairing code locally and never in the chat", async () => {
		const { host, transport } = await setup({}, {}, { pair: false });
		await transport.inject({ text: "hello there" });
		const chatText = transport.allText.join("\n");
		expect(chatText).not.toContain("000000");
		expect(chatText).not.toContain("000 000");
		expect(host.notifications.join("\n")).toContain("000 000");
	});

	it("does not re-notify the operator while waiting for the code", async () => {
		const { host, transport } = await setup({}, {}, { pair: false });
		await transport.inject({ text: "hello" });
		const before = host.notifications.length;
		await transport.inject({ text: "are you there?" });
		expect(host.notifications.length).toBe(before);
	});

	it("pairs on the correct code, then forwards prompts", async () => {
		const { host, transport } = await setup({ pairingDigits: 6 }, {}, { pair: false });
		await transport.inject({ text: "hello" });
		await transport.inject({ text: "000-000" });
		expect(transport.sent.at(-1)?.text).toContain("Paired as fake:user-1");
		await transport.inject({ text: "run the tests" });
		expect(host.prompts).toEqual([{ text: "run the tests" }]);
	});

	it("does not trust a wrong code", async () => {
		const { transport, store } = await setup({}, {}, { pair: false });
		await transport.inject({ text: "hello" });
		await transport.inject({ text: "999999" });
		expect(transport.lastSent?.text).toContain("did not match");
		expect(store.isTrusted("fake:user-1")).toBe(false);
	});

	it("skips pairing for pre-trusted identities", async () => {
		const { host, transport } = await setup({ allowUsers: ["fake:user-1"] }, {}, { pair: false });
		await transport.inject({ text: "run the tests" });
		expect(host.prompts).toEqual([{ text: "run the tests" }]);
	});

	it("skips pairing entirely when requirePairing is disabled", async () => {
		const { host, transport } = await setup({ requirePairing: false }, {}, { pair: false });
		await transport.inject({ text: "run the tests" });
		expect(host.prompts).toEqual([{ text: "run the tests" }]);
	});
});

describe("Bridge — routing", () => {
	it("answers a command without invoking the model", async () => {
		const { host, transport } = await setup();
		await transport.inject({ text: "/status" });
		expect(transport.lastSent?.text).toContain("fake:user-1");
		expect(transport.lastSent?.text).toContain("- agent: idle");
		expect(host.prompts).toEqual([]);
	});

	it("uses followUp delivery while the agent is busy", async () => {
		const { host, transport } = await setup();
		host.idle = false;
		await transport.inject({ text: "one more thing" });
		expect(host.prompts).toEqual([{ text: "one more thing", deliverAs: "followUp" }]);
	});

	it("ignores unaddressed channel chatter", async () => {
		const { host, transport } = await setup({ botUsername: "piBot" });
		await transport.inject({ text: "just chatting", isDirect: false });
		expect(host.prompts).toEqual([]);
		expect(transport.sent).toEqual([]);
	});

	it("ignores unauthenticated channel chatter instead of challenging it", async () => {
		const { host, transport } = await setup({ botUsername: "piBot" }, {}, { pair: false });
		await transport.inject({ text: "just chatting", isDirect: false });
		expect(host.prompts).toEqual([]);
		expect(transport.sent).toEqual([]);
	});

	it("refuses an attachment whose real media type is not allowed", async () => {
		const { host, transport } = await setup({}, {}, {
			attachmentResolver: () => Promise.resolve({ mediaType: "text/html", data: "PGh0bWw+" }),
		});
		host.acceptsAttachments = true;
		await transport.inject({ text: "what is this?", attachments: [PNG] });

		expect(transport.lastSent?.text).toBe(ATTACHMENT_NOT_AN_IMAGE_NOTICE);
		expect(host.prompts).toEqual([]);
	});

	it("strips an addressing mention before forwarding", async () => {
		const { host, transport } = await setup({ botUsername: "piBot" });
		await transport.inject({ text: "@piBot tighten the retry loop", isDirect: false });
		expect(host.prompts).toEqual([{ text: "tighten the retry loop" }]);
	});
});

describe("Bridge — commands with effects", () => {
	it("pauses and resumes delivery", async () => {
		const { host, transport } = await setup();
		await transport.inject({ text: "/pause" });
		expect(transport.lastSent?.text).toContain("paused");

		await transport.inject({ text: "do work" });
		expect(transport.lastSent?.text).toContain("Delivery is paused");
		expect(host.prompts).toEqual([]);

		await transport.inject({ text: "/resume" });
		await transport.inject({ text: "do work" });
		expect(host.prompts).toEqual([{ text: "do work" }]);
	});

	it("keeps answering commands while paused", async () => {
		const { transport } = await setup();
		await transport.inject({ text: "/pause" });
		await transport.inject({ text: "/status" });
		expect(transport.lastSent?.text).toContain("- delivery: paused");
	});

	it("revokes the pairing on disconnect", async () => {
		const { transport, store } = await setup();
		await transport.inject({ text: "/disconnect" });
		expect(store.isTrusted("fake:user-1")).toBe(false);
		await transport.inject({ text: "hello again" });
		expect(transport.lastSent?.text).toContain("not paired with a pi session");
	});

	it("requests an abort", async () => {
		const { host, transport } = await setup();
		await transport.inject({ text: "/abort" });
		expect(host.aborts).toBe(1);
	});
});

describe("Bridge — outbound shaping", () => {
	it("chunks a long reply to the transport limit", async () => {
		const { bridge, transport } = await setup({}, { maxMessageLength: 40 });
		const text = "word ".repeat(50);
		await bridge.send({ transport: "fake", conversationId: "conv-1", kind: "reply", text });
		expect(transport.sent.length).toBeGreaterThan(1);
		for (const message of transport.sent) {
			expect(message.text.length).toBeLessThanOrEqual(40);
		}
		expect(transport.sent.map((message) => message.text).join("")).toBe(text);
	});

	it("delivers every chunk when the output fits the chunk budget", async () => {
		const { bridge, transport } = await setup({ maxChunks: 5 }, { maxMessageLength: 10 });
		await bridge.send({ transport: "fake", conversationId: "conv-1", kind: "reply", text: "abcde fghij" });
		expect(transport.sent.map((message) => message.text).join("")).toBe("abcde fghij");
		expect(transport.lastSent?.text).not.toContain("truncated");
	});

	it("stops at the chunk budget and says how much was dropped", async () => {
		const { bridge, transport } = await setup({ maxChunks: 2 }, { maxMessageLength: 5 });
		await bridge.send({ transport: "fake", conversationId: "conv-1", kind: "reply", text: "abcdefghijklmno" });
		expect(transport.sent.map((message) => message.text)).toEqual([
			"abcde",
			"fghij",
			"[truncated: 1 more message(s) were not sent]",
		]);
	});

	it("never truncates a single-chunk reply when the budget is one", async () => {
		const { bridge, transport } = await setup({ maxChunks: 1 }, { maxMessageLength: 40 });
		await bridge.send({ transport: "fake", conversationId: "conv-1", kind: "reply", text: "short" });
		expect(transport.sent.map((message) => message.text)).toEqual(["short"]);
	});

	it("cuts a long reply at a heading instead of orphaning it", async () => {
		const { bridge, transport } = await setup({}, { maxMessageLength: 100 });
		const text = `## A\n\n${"a".repeat(80)}\n\n## B\n\n${"b".repeat(60)}\n`;
		await bridge.send({ transport: "fake", conversationId: "conv-1", kind: "reply", text });
		expect(transport.sent.map((message) => message.text)).toEqual([
			`## A\n\n${"a".repeat(80)}\n\n`,
			`## B\n\n${"b".repeat(60)}\n`,
		]);
	});

	it("delivers the whole reply after a semantic split", async () => {
		const { bridge, transport } = await setup({}, { maxMessageLength: 100 });
		const text = `## A\n\n${"a".repeat(80)}\n\n## B\n\n${"b".repeat(60)}\n`;
		await bridge.send({ transport: "fake", conversationId: "conv-1", kind: "reply", text });
		expect(transport.sent.map((message) => message.text).join("")).toBe(text);
	});

	it("renders a heading in every semantic chunk for the transport's flavor", async () => {
		const host = new FakeHost();
		const bridge = new Bridge({ host, config: { requirePairing: false } });
		const htmlTransport = new FakeTransport({
			id: "html",
			capabilities: { markdown: "html", maxMessageLength: 50 },
		});
		await bridge.register(htmlTransport);
		const text = `## A\n\n${"x".repeat(30)}\n\n## B\n\n${"y".repeat(30)}\n`;
		await bridge.send({ transport: "html", conversationId: "conv-1", kind: "reply", text });
		expect(htmlTransport.sent.map((message) => message.text)).toEqual([
			`<b>A</b>\n\n${"x".repeat(30)}\n\n`,
			`<b>B</b>\n\n${"y".repeat(30)}\n`,
		]);
	});

	it("keeps a rendered chunk within the limit when html escaping grows it", async () => {
		const { bridge, transport } = await setup({}, { markdown: "html", maxMessageLength: 40 });
		const text = `## A\n\n${"<".repeat(40)}\n`;
		await bridge.send({ transport: "fake", conversationId: "conv-1", kind: "reply", text });
		for (const message of transport.sent) {
			expect(message.text.length).toBeLessThanOrEqual(40);
		}
		expect(transport.sent.map((message) => message.text).join("")).toBe(`<b>A</b>\n\n${"&lt;".repeat(40)}\n`);
	});

	it("counts UTF-16 units for a transport that declared them", async () => {
		const { bridge, transport } = await setup({}, { lengthUnit: "utf16", maxMessageLength: 40 });
		const text = `## A\n\n${"😀".repeat(40)}\n`;
		await bridge.send({ transport: "fake", conversationId: "conv-1", kind: "reply", text });
		for (const message of transport.sent) {
			expect(measureLength(message.text, "utf16")).toBeLessThanOrEqual(40);
		}
		expect(transport.sent.map((message) => message.text).join("")).toBe(text);
	});

	it("renders the flavor each transport asked for", async () => {
		const host = new FakeHost();
		const bridge = new Bridge({ host, config: { requirePairing: false } });
		const htmlTransport = new FakeTransport({ id: "html", capabilities: { markdown: "html" } });
		const slackTransport = new FakeTransport({ id: "slack-ish", capabilities: { markdown: "mrkdwn" } });
		await bridge.register(htmlTransport);
		await bridge.register(slackTransport);

		await htmlTransport.inject({ text: "go" });
		await slackTransport.inject({ text: "go" });
		await bridge.publish("progress", "**bold**");

		expect(htmlTransport.lastSent?.text).toContain("<b>bold</b>");
		expect(slackTransport.lastSent?.text).toContain("*bold*");
	});

	it("redacts secrets on the way out", async () => {
		const { bridge, transport } = await setup();
		await bridge.send({
			transport: "fake",
			conversationId: "conv-1",
			kind: "reply",
			text: "token is ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
		});
		expect(transport.lastSent?.text).not.toContain("ghp_ABCDEF");
		expect(transport.lastSent?.text).toContain("[redacted:github-token]");
	});

	it("never logs prompt text", async () => {
		const sink = new MemoryLogSink();
		const host = new FakeHost();
		host.logger = createLogger("test", sink, "debug");
		const bridge = new Bridge({ host, config: { requirePairing: false } });
		const transport = new FakeTransport();
		await bridge.register(transport);

		await transport.inject({ text: "secret plan ghp_ABCDEFGHIJKLMNOPQRSTUVWX" });
		expect(sink.lines.join("")).not.toContain("ghp_ABCDEF");
		expect(sink.lines.join("")).not.toContain("secret plan");
	});

	it("sends nothing when the transport is not registered", async () => {
		const { bridge, transport } = await setup();
		await bridge.send({ transport: "nope", conversationId: "conv-1", kind: "reply", text: "hello" });
		expect(transport.sent).toEqual([]);
	});

	it("refuses an attachment the host cannot forward", async () => {
		const { host, transport } = await setup();
		await transport.inject({
			text: "what is this?",
			attachments: [{ kind: "image", mediaType: "image/png", ref: "file-1" }],
		});
		expect(transport.lastSent?.text).toBe(ATTACHMENTS_UNSUPPORTED_NOTICE);
		expect(host.prompts).toEqual([]);
	});

	it("forwards the image bytes only when both sides support it", async () => {
		// Host can hand images to the model, but this transport has no fetchAttachment.
		const withoutFetcher = await setup();
		withoutFetcher.host.acceptsAttachments = true;
		await withoutFetcher.transport.inject({ text: "what is this?", attachments: [PNG] });
		expect(withoutFetcher.host.prompts).toEqual([]);
		expect(withoutFetcher.transport.lastSent?.text).toBe(ATTACHMENTS_UNSUPPORTED_NOTICE);

		const both = await setup({}, {}, { attachmentResolver: attachmentResolver("QUJD") });
		both.host.acceptsAttachments = true;
		await both.transport.inject({ text: "what is this?", attachments: [PNG] });
		expect(both.host.prompts).toEqual([
			{ text: "what is this?", images: [{ mediaType: "image/png", data: "QUJD" }] },
		]);
	});

	it("substitutes a fallback prompt for an image-only message", async () => {
		const { host, transport } = await setup({}, {}, { attachmentResolver: attachmentResolver() });
		host.acceptsAttachments = true;
		await transport.inject({ text: "", attachments: [PNG] });
		expect(host.prompts[0]?.text).toBe("Describe the attached image.");
	});

	it("reports a failed download instead of forwarding the caption alone", async () => {
		const { host, transport } = await setup({}, {}, {
			attachmentResolver: () => Promise.reject(new Error("403 from the CDN")),
		});
		host.acceptsAttachments = true;
		await transport.inject({ text: "what is this?", attachments: [PNG] });

		expect(host.prompts).toEqual([]);
		expect(transport.lastSent?.text).toBe(ATTACHMENT_FETCH_FAILED_NOTICE);
	});

	it("rejects an image that turns out too large after download", async () => {
		// The 8 MiB cap is re-checked against the fetched bytes, not just the
		// size the messenger declared.
		const oversized = "A".repeat(Math.ceil((9 * 1024 * 1024 * 4) / 3));
		const { host, transport } = await setup({}, {}, { attachmentResolver: attachmentResolver(oversized) });
		host.acceptsAttachments = true;
		await transport.inject({ text: "look", attachments: [PNG] });

		expect(host.prompts).toEqual([]);
		expect(transport.lastSent?.text).toBe(ATTACHMENT_TOO_LARGE_NOTICE);
	});

	it("uses the shared paused notice", async () => {
		const { transport } = await setup();
		await transport.inject({ text: "/pause" });
		await transport.inject({ text: "do work" });
		expect(transport.lastSent?.text).toBe(PAUSED_NOTICE);
	});
});

describe("Bridge — progress card", () => {
	it("posts one card and edits it afterwards", async () => {
		const { bridge, transport, host } = await setup({}, { edit: true });
		await transport.inject({ text: "start" });
		transport.sent.length = 0;
		transport.edits.length = 0;

		bridge.beginTurn();
		await bridge.publishProgress("▶ bash");
		host.clock += 2_000;
		await bridge.publishProgress("✓ bash");

		expect(transport.sent.map((message) => message.text)).toEqual(["▶ bash"]);
		expect(transport.edits.map((message) => message.text)).toEqual(["✓ bash"]);

		// The handle stays the same across updates: that is the whole point.
		const firstEditKey = transport.edits[0]?.editKey;
		expect(firstEditKey).toMatch(/^fake-m\d+$/);
		host.clock += 2_000;
		await bridge.publishProgress("✓ read");
		expect(transport.edits[1]?.editKey).toBe(firstEditKey);
	});

	it("posts a new message when the transport cannot edit", async () => {
		const { bridge, transport, host } = await setup({}, { edit: false });
		await transport.inject({ text: "start" });
		transport.sent.length = 0;

		bridge.beginTurn();
		await bridge.publishProgress("▶ bash");
		host.clock += 2_000;
		await bridge.publishProgress("✓ bash");

		expect(transport.sent.map((message) => message.text)).toEqual(["▶ bash", "✓ bash"]);
	});

	it("throttles updates within a turn", async () => {
		const { bridge, transport, host } = await setup({ progressMinIntervalMs: 1_000 }, { edit: true });
		await transport.inject({ text: "start" });
		transport.sent.length = 0;

		bridge.beginTurn();
		expect(await bridge.publishProgress("▶ bash")).toBe(1);
		expect(await bridge.publishProgress("▶ read")).toBe(0);
		host.clock += 1_000;
		expect(await bridge.publishProgress("✓ read")).toBe(1);
	});

	it("always publishes the first update of a turn", async () => {
		const { bridge, host } = await setup({ progressMinIntervalMs: 60_000 }, { edit: true });
		bridge.beginTurn();
		host.clock += 10;
		expect(await bridge.publishProgress("▶ bash")).toBe(1);
	});

	it("starts a new card on the next turn", async () => {
		const { bridge, transport } = await setup({}, { edit: true });
		await transport.inject({ text: "start" });
		transport.sent.length = 0;
		transport.edits.length = 0;

		bridge.beginTurn();
		await bridge.publishProgress("▶ bash");
		bridge.beginTurn();
		await bridge.publishProgress("▶ bash");

		expect(transport.sent).toHaveLength(2);
		expect(transport.edits).toHaveLength(0);
	});

	it("falls back to a new message when the edit is rejected", async () => {
		const { bridge, transport, host } = await setup({}, { edit: true });
		await transport.inject({ text: "start" });
		transport.sent.length = 0;

		bridge.beginTurn();
		await bridge.publishProgress("▶ bash");
		transport.failEdits = true;
		host.clock += 2_000;
		await bridge.publishProgress("✓ bash");

		expect(transport.sent.map((message) => message.text)).toEqual(["▶ bash", "✓ bash"]);
		expect(transport.edits).toHaveLength(0);
	});

	it("never posts a progress card to a paused conversation", async () => {
		const { bridge, transport } = await setup({}, { edit: true });
		await transport.inject({ text: "start" });
		await transport.inject({ text: "/pause" });
		transport.sent.length = 0;

		bridge.beginTurn();
		expect(await bridge.publishProgress("▶ bash")).toBe(0);
		expect(transport.sent).toEqual([]);
	});
});

describe("Bridge — turn start", () => {
	it("posts a thinking card and still lets the first tool update through", async () => {
		const { bridge, transport } = await setup({ progressMinIntervalMs: 60_000 }, { edit: true });
		await transport.inject({ text: "start" });
		transport.sent.length = 0;
		transport.edits.length = 0;

		bridge.beginTurn();
		expect(await bridge.publishTurnStart()).toBe(1);
		expect(await bridge.publishProgress("▶ bash")).toBe(1);

		expect(transport.sent.map((message) => message.text)).toEqual(["thinking…"]);
		expect(transport.edits.map((message) => message.text)).toEqual(["▶ bash"]);
	});

	it("does not post a turn-start card to a paused conversation", async () => {
		const { bridge, transport } = await setup({}, { edit: true });
		await transport.inject({ text: "start" });
		await transport.inject({ text: "/pause" });
		transport.sent.length = 0;

		bridge.beginTurn();
		expect(await bridge.publishTurnStart()).toBe(0);
		expect(transport.sent).toEqual([]);
	});
});

describe("Bridge — typing hint", () => {
	it("hints typing when a prompt is forwarded", async () => {
		const { transport } = await setup();
		await transport.inject({ text: "do work" });
		expect(transport.typingCalls).toEqual(["conv-1"]);
	});

	it("hints typing on every delivered progress update", async () => {
		const { bridge, transport } = await setup();
		await transport.inject({ text: "start" });
		transport.typingCalls.length = 0;

		bridge.beginTurn();
		await bridge.publishProgress("▶ bash");
		expect(transport.typingCalls).toEqual(["conv-1"]);
	});

	it("does not hint typing when the transport has no indicator", async () => {
		const { host, transport } = await setup({}, {}, { typing: false });
		expect(transport.typing).toBeUndefined();
		await transport.inject({ text: "do work" });
		expect(host.prompts).toEqual([{ text: "do work" }]);
	});

	it("keeps delivering when the typing hint rejects", async () => {
		const { host, transport } = await setup();
		transport.typing = () => Promise.reject(new Error("rate limited"));
		await transport.inject({ text: "do work" });
		expect(host.prompts).toEqual([{ text: "do work" }]);
		expect(host.notifications).toEqual([]);
	});
});

describe("Bridge — publish", () => {
	it("delivers progress to remembered conversations", async () => {
		const { bridge, transport } = await setup();
		await transport.inject({ text: "start" });
		transport.sent.length = 0;

		const delivered = await bridge.publish("progress", "working…");
		expect(delivered).toBe(1);
		expect(transport.lastSent?.text).toBe("working…");
		expect(transport.lastSent?.kind).toBe("progress");
	});

	it("skips paused conversations", async () => {
		const { bridge, transport } = await setup();
		await transport.inject({ text: "start" });
		await transport.inject({ text: "/pause" });
		transport.sent.length = 0;

		expect(await bridge.publish("progress", "working…")).toBe(0);
		expect(transport.sent).toEqual([]);
	});

	it("does not deliver anywhere before the first authenticated message", async () => {
		const { bridge, transport } = await setup({}, {}, { pair: false });
		expect(await bridge.publish("progress", "nobody is listening")).toBe(0);
		expect(transport.sent).toEqual([]);
	});
});

describe("Bridge — lifecycle", () => {
	it("rejects a duplicate transport id", async () => {
		const { bridge } = await setup();
		await expect(bridge.register(new FakeTransport())).rejects.toThrow(/already registered/);
	});

	it("starts and stops registered transports", async () => {
		const { bridge, transport } = await setup();
		expect(transport.started).toBe(true);
		await bridge.stop();
		expect(transport.started).toBe(false);
		expect(bridge.transportIds).toEqual([]);
	});

	it("records a transport that fails to start instead of throwing", async () => {
		const host = new FakeHost();
		const bridge = new Bridge({ host });
		await bridge.register(new FailingTransport("bad token"));

		expect(bridge.transportIds).toEqual(["failing"]);
		expect(host.notifications.join("\n")).toContain("failing failed to start: bad token");
		expect(bridge.diagnostics()).toEqual([{ id: "failing", status: "error", detail: "bad token" }]);
	});

	it("keeps running when one transport fails to stop", async () => {
		const host = new FakeHost();
		const bridge = new Bridge({ host });
		const healthy = new FakeTransport();
		await bridge.register(healthy);
		await bridge.register(new FailingStopTransport());

		await bridge.stop();
		expect(healthy.started).toBe(false);
		expect(bridge.transportIds).toEqual([]);
	});

	it("reports running transports and their own diagnostics", async () => {
		const host = new FakeHost();
		const bridge = new Bridge({ host });
		await bridge.register(new DiagnosingTransport());
		expect(bridge.diagnostics()).toEqual([{ id: "diagnosing", status: "running", detail: "connected as bot#1" }]);
	});

	it("reports a running transport with no diagnostics detail", async () => {
		const { bridge } = await setup();
		expect(bridge.diagnostics()).toEqual([{ id: "fake", status: "running" }]);
	});
});

describe("Bridge — snapshot", () => {
	it("describes transports, trust, pause state and pending pairings", async () => {
		const { bridge, transport } = await setup({}, {}, { pair: false });
		let snapshot = bridge.snapshot();
		expect(snapshot).toEqual({ transports: ["fake"], trusted: [], paused: [], pending: [], conversations: 0 });

		await transport.inject({ text: "hello" });
		snapshot = bridge.snapshot();
		expect(snapshot.pending).toHaveLength(1);
		expect(snapshot.pending[0]?.key).toBe("fake:conv-1");
		expect(snapshot.pending[0]?.code).toBe("000000");

		await transport.inject({ text: "000000" });
		await transport.inject({ text: "/pause" });
		snapshot = bridge.snapshot();
		expect(snapshot.trusted).toEqual(["fake:user-1"]);
		expect(snapshot.paused).toEqual(["fake:conv-1"]);
		expect(snapshot.pending).toEqual([]);
		expect(snapshot.conversations).toBe(1);
	});
});
