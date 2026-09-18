/**
 * In-memory transport for tests and offline development.
 *
 * It performs no formatting, chunking or redaction on purpose: those belong to
 * the bridge, and the transport contract says a transport only moves bytes.
 */

import type {
	Envelope,
	EnvelopeHandler,
	OutboundMessage,
	SendReceipt,
	Transport,
	TransportCapabilities,
} from "../core/types.js";

export const FAKE_CAPABILITIES: TransportCapabilities = {
	threads: false,
	edit: false,
	reactions: false,
	attachments: true,
	maxMessageLength: 4000,
	lengthUnit: "chars",
	markdown: "markdown",
	channels: false,
};

export interface FakeTransportOptions {
	readonly id?: string;
	readonly capabilities?: Partial<TransportCapabilities>;
}

export class FakeTransport implements Transport {
	readonly id: string;
	readonly capabilities: TransportCapabilities;
	/** Messages posted as new messages. */
	readonly sent: OutboundMessage[] = [];
	/** Messages that updated an existing message. */
	readonly edits: OutboundMessage[] = [];
	started = false;

	private handler: EnvelopeHandler | null = null;
	private counter = 0;

	constructor(options: FakeTransportOptions = {}) {
		this.id = options.id ?? "fake";
		this.capabilities = { ...FAKE_CAPABILITIES, ...options.capabilities };
	}

	async start(handler: EnvelopeHandler): Promise<void> {
		this.handler = handler;
		this.started = true;
	}

	async stop(): Promise<void> {
		this.handler = null;
		this.started = false;
	}

	async send(message: OutboundMessage): Promise<SendReceipt> {
		if (message.editKey !== undefined) {
			this.edits.push(message);
		} else {
			this.sent.push(message);
		}
		this.counter++;
		const messageId = `${this.id}-m${this.counter}`;
		return this.capabilities.edit ? { messageId, editKey: messageId } : { messageId };
	}

	/** Test/dev hook: deliver an inbound message as if the messenger sent it. */
	async inject(partial: Partial<Envelope> & { text: string }): Promise<void> {
		if (!this.handler) {
			throw new Error(`FakeTransport(${this.id}) is not started`);
		}
		const envelope: Envelope = {
			transport: this.id,
			conversationId: "conv-1",
			userId: "user-1",
			timestamp: 0,
			isDirect: true,
			...partial,
		};
		await this.handler(envelope);
	}

	get lastSent(): OutboundMessage | undefined {
		return this.sent.at(-1);
	}

	get allText(): string[] {
		return this.sent.map((message) => message.text);
	}
}
