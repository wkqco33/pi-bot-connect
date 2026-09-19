import { describe, expect, it } from "vitest";
import {
	ROBO_CLAW_TRANSPORT_ID,
	extractAuthToken,
	normalizeInbound,
	normalizeOutbound,
	type RoboClawChatMessage,
} from "./normalize.js";

describe("RoboClaw normalize — inbound", () => {
	it("normalizes a standard user message into an Envelope", () => {
		const raw: RoboClawChatMessage = {
			sender_id: "user-123",
			content: "hello pi",
			timestamp: 1700000000000,
			metadata: { room_id: "room-abc" },
		};

		const result = normalizeInbound(raw, { conversationId: "room-abc" });
		expect(result).toEqual({
			kind: "envelope",
			envelope: {
				transport: ROBO_CLAW_TRANSPORT_ID,
				conversationId: "room-abc",
				userId: "user-123",
				timestamp: 1700000000000,
				text: "hello pi",
				isDirect: true,
				addressed: true,
				raw,
			},
		});
	});

	it("skips messages sent by the robot itself", () => {
		const raw: RoboClawChatMessage = {
			sender_id: "robot",
			content: "task finished",
			timestamp: 1700000000000,
			metadata: {},
		};

		const result = normalizeInbound(raw);
		expect(result).toEqual({ kind: "skip", reason: "self" });
	});

	it("skips messages matching configured selfSenderId", () => {
		const raw: RoboClawChatMessage = {
			sender_id: "my-pi-bot",
			content: "echo",
			timestamp: 1700000000000,
			metadata: {},
		};

		const result = normalizeInbound(raw, { selfSenderId: "my-pi-bot" });
		expect(result).toEqual({ kind: "skip", reason: "self" });
	});

	it("skips empty content without attachments", () => {
		const raw: RoboClawChatMessage = {
			sender_id: "user-1",
			content: "   ",
			timestamp: 1700000000000,
			metadata: {},
		};

		const result = normalizeInbound(raw);
		expect(result).toEqual({ kind: "skip", reason: "empty" });
	});

	it("extracts attachment when metadata contains file_id", () => {
		const raw: RoboClawChatMessage = {
			sender_id: "user-1",
			content: "check this image",
			timestamp: 1700000000000,
			metadata: {
				file_id: "file-999",
				filename: "screenshot.png",
				type: "image/png",
			},
		};

		const result = normalizeInbound(raw, { conversationId: "room-1" });
		expect(result.kind).toBe("envelope");
		if (result.kind === "envelope") {
			expect(result.envelope.attachments).toEqual([
				{
					kind: "image",
					mediaType: "image/png",
					ref: "file-999",
					name: "screenshot.png",
				},
			]);
		}
	});

	it("defaults non-image file type to file kind", () => {
		const raw: RoboClawChatMessage = {
			sender_id: "user-1",
			content: "log file",
			timestamp: 1700000000000,
			metadata: {
				file_id: "file-123",
				filename: "build.log",
				type: "text/plain",
			},
		};

		const result = normalizeInbound(raw, { conversationId: "room-1" });
		expect(result.kind).toBe("envelope");
		if (result.kind === "envelope") {
			expect(result.envelope.attachments).toEqual([
				{
					kind: "file",
					mediaType: "text/plain",
					ref: "file-123",
					name: "build.log",
				},
			]);
		}
	});
});

describe("RoboClaw normalize — outbound", () => {
	it("normalizes OutboundMessage to ChatMessage proto shape", () => {
		const outbound = {
			conversationId: "room-1",
			kind: "reply" as const,
			text: "I fixed the bug.",
		};

		const chatMsg = normalizeOutbound(outbound, { now: 1700000500000 });
		expect(chatMsg).toEqual({
			sender_id: "robot",
			content: "I fixed the bug.",
			timestamp: 1700000500000,
			metadata: {},
		});
	});

	it("allows custom senderId for robot", () => {
		const outbound = {
			conversationId: "room-1",
			kind: "reply" as const,
			text: "done",
		};

		const chatMsg = normalizeOutbound(outbound, {
			senderId: "custom-agent",
			now: 1700000500000,
		});
		expect(chatMsg.sender_id).toBe("custom-agent");
	});
});

describe("RoboClaw auth token extraction", () => {
	it("extracts auth_token from message metadata", () => {
		const raw: RoboClawChatMessage = {
			sender_id: "user-1",
			content: "hi",
			timestamp: 1700000000000,
			metadata: { auth_token: "secret-tok-1" },
		};

		expect(extractAuthToken(raw)).toBe("secret-tok-1");
	});

	it("extracts token from call headers if not in message metadata", () => {
		const raw: RoboClawChatMessage = {
			sender_id: "user-1",
			content: "hi",
			timestamp: 1700000000000,
			metadata: {},
		};

		expect(
			extractAuthToken(raw, { "x-robo-claw-peer-token": "header-token" }),
		).toBe("header-token");
	});

	it("returns undefined when no token is present in metadata or headers", () => {
		const raw: RoboClawChatMessage = {
			sender_id: "user-1",
			content: "hi",
			timestamp: 1700000000000,
			metadata: {},
		};

		expect(extractAuthToken(raw, {})).toBeUndefined();
	});
});

