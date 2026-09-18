/**
 * Replay transport: feed a recorded transcript through the real bridge.
 *
 * This is a development tool, not a platform adapter. It exists so a captured
 * session (`core/transcript.ts`) can drive `Bridge` end to end with no bot token,
 * no network and no timers — the regression harness the roadmap called for.
 */

import type {
	Envelope,
	EnvelopeHandler,
	OutboundMessage,
	SendReceipt,
	Transport,
	TransportCapabilities,
} from "../core/types.js";
import { FAKE_CAPABILITIES } from "./fake.js";

export interface ReplayTransportOptions {
	/** Must match the `transport` field of the recorded envelopes. */
	readonly id: string;
	readonly envelopes: readonly Envelope[];
	readonly capabilities?: Partial<TransportCapabilities>;
}

export class ReplayTransport implements Transport {
	readonly id: string;
	readonly capabilities: TransportCapabilities;
	/** Everything the bridge sent while replaying, in order. */
	readonly sent: OutboundMessage[] = [];

	private readonly envelopes: readonly Envelope[];
	private handler: EnvelopeHandler | null = null;
	private counter = 0;

	constructor(options: ReplayTransportOptions) {
		this.id = options.id;
		this.capabilities = { ...FAKE_CAPABILITIES, ...options.capabilities };
		this.envelopes = options.envelopes;
	}

	async start(handler: EnvelopeHandler): Promise<void> {
		if (this.handler !== null) throw new Error("ReplayTransport is already started");
		this.handler = handler;
		for (const envelope of this.envelopes) {
			await handler(envelope);
		}
	}

	async stop(): Promise<void> {
		this.handler = null;
	}

	async send(message: OutboundMessage): Promise<SendReceipt> {
		if (this.handler === null) throw new Error("ReplayTransport is not started");
		this.sent.push(message);
		this.counter++;
		const messageId = `${this.id}-r${this.counter}`;
		return this.capabilities.edit ? { messageId, editKey: messageId } : { messageId };
	}
}
