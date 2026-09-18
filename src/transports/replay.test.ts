import { describe, expect, it } from "vitest";
import { Bridge, type BridgeHost } from "../bridge.js";
import { parseTranscript, serializeTranscript } from "../core/transcript.js";
import { noopLogger, type Envelope, type PromptOptions } from "../core/types.js";
import { ReplayTransport } from "./replay.js";

class ReplayHost implements BridgeHost {
	readonly cwd = "/work/project";
	sessionName: string | undefined = "replay";
	readonly logger = noopLogger;
	readonly acceptsAttachments = false;
	readonly prompts: string[] = [];
	idle = true;
	clock = 0;

	sendPrompt(text: string, _options?: PromptOptions): void {
		this.prompts.push(text);
	}

	abort(): void {}
	isIdle(): boolean {
		return this.idle;
	}
	notify(): void {}
	now(): number {
		return this.clock;
	}
	random(): number {
		return 0;
	}
}

function recorded(overrides: Partial<Envelope> = {}): Envelope {
	return {
		transport: "replay",
		conversationId: "c1",
		userId: "u1",
		timestamp: 0,
		text: "hello",
		isDirect: true,
		...overrides,
	};
}

describe("ReplayTransport", () => {
	it("delivers every recorded envelope in order", async () => {
		const transport = new ReplayTransport({
			id: "replay",
			envelopes: [recorded({ text: "first" }), recorded({ text: "second" })],
		});
		const seen: string[] = [];
		await transport.start((envelope) => {
			seen.push(envelope.text);
		});
		expect(seen).toEqual(["first", "second"]);
	});

	it("throws when send() is called before start()", async () => {
		const transport = new ReplayTransport({ id: "replay", envelopes: [] });
		await expect(transport.send({ conversationId: "c1", kind: "reply", text: "hi" })).rejects.toThrow();
	});
});

describe("transcript replay through the bridge", () => {
	it("turns a recorded session into the same prompts", async () => {
		const transcript = serializeTranscript([
			recorded({ text: "first" }),
			recorded({ text: "second" }),
			recorded({ text: "/status" }),
		]);
		const { envelopes, warnings } = parseTranscript(transcript);
		expect(warnings).toEqual([]);

		const host = new ReplayHost();
		const bridge = new Bridge({ host, config: { requirePairing: false } });
		const transport = new ReplayTransport({ id: "replay", envelopes });
		await bridge.register(transport);

		expect(host.prompts).toEqual(["first", "second"]);
		// The command was answered, not forwarded as a prompt.
		expect(transport.sent.some((message) => message.text.includes("pi-bot-connect status"))).toBe(true);
	});

	it("does not leak a recorded secret back out on replay", async () => {
		const transcript = serializeTranscript([recorded({ text: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWX" })]);
		const { envelopes } = parseTranscript(transcript);

		const host = new ReplayHost();
		const bridge = new Bridge({ host, config: { requirePairing: false } });
		await bridge.register(new ReplayTransport({ id: "replay", envelopes }));

		expect(host.prompts.join("")).not.toContain("ABCDEF");
	});
});
