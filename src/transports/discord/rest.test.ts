import { describe, expect, it } from "vitest";
import { DiscordRest } from "./rest.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("DiscordRest — typing indicator", () => {
	it("POSTs to the channel typing endpoint", async () => {
		const calls: Array<{ url: string; method: string }> = [];
		const rest = new DiscordRest({
			token: "test-token",
			fetchImpl: (input, init) => {
				calls.push({ url: String(input), method: init?.method ?? "GET" });
				return Promise.resolve(new Response(null, { status: 204 }));
			},
		});

		await rest.triggerTyping("chan 1");

		expect(calls).toEqual([
			{ url: "https://discord.com/api/v10/channels/chan%201/typing", method: "POST" },
		]);
	});

	it("surfaces a failure status instead of swallowing it", async () => {
		const rest = new DiscordRest({
			token: "test-token",
			fetchImpl: () =>
				Promise.resolve(
					new Response('{"message":"Missing Permissions"}', {
						status: 403,
						headers: { "content-type": "application/json" },
					}),
				),
		});

		await expect(rest.triggerTyping("chan-1")).rejects.toThrow(/403/);
	});
});

describe("DiscordRest — resilience", () => {
	it("passes an abort signal so a hung request cannot block a turn", async () => {
		let seen: AbortSignal | null | undefined;
		const rest = new DiscordRest({
			token: "test-token",
			fetchImpl: (_input, init) => {
				seen = init?.signal;
				return Promise.resolve(jsonResponse({ id: "1", username: "bot" }));
			},
		});

		await rest.getBotIdentity();

		expect(seen).toBeInstanceOf(AbortSignal);
	});

	it("aborts a request that exceeds the timeout", async () => {
		const rest = new DiscordRest({
			token: "test-token",
			timeoutMs: 5,
			fetchImpl: (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		});

		await expect(rest.getBotIdentity()).rejects.toThrow(/could not be sent/);
	});

	it("retries a 503 and then succeeds", async () => {
		const statuses = [503, 200];
		const delays: number[] = [];
		const rest = new DiscordRest({
			token: "test-token",
			delayImpl: (ms) => {
				delays.push(ms);
				return Promise.resolve();
			},
			fetchImpl: () => {
				const status = statuses.shift() ?? 200;
				return Promise.resolve(status === 200 ? jsonResponse({ id: "1", username: "bot" }) : jsonResponse({ message: "upstream" }, status));
			},
		});

		const identity = await rest.getBotIdentity();

		expect(identity.id).toBe("1");
		expect(delays).toHaveLength(1);
	});

	it("surfaces a persistent 5xx after retrying", async () => {
		let calls = 0;
		const rest = new DiscordRest({
			token: "test-token",
			delayImpl: () => Promise.resolve(),
			fetchImpl: () => {
				calls++;
				return Promise.resolve(jsonResponse({ message: "boom" }, 502));
			},
		});

		await expect(rest.getBotIdentity()).rejects.toThrow(/502/);
		expect(calls).toBe(2);
	});

	it("retries a network failure", async () => {
		let calls = 0;
		const rest = new DiscordRest({
			token: "test-token",
			delayImpl: () => Promise.resolve(),
			fetchImpl: () => {
				calls++;
				if (calls === 1) return Promise.reject(new Error("ECONNRESET"));
				return Promise.resolve(jsonResponse({ id: "1", username: "bot" }));
			},
		});

		const identity = await rest.getBotIdentity();

		expect(identity.id).toBe("1");
	});

	it("does not retry a 4xx", async () => {
		let calls = 0;
		const rest = new DiscordRest({
			token: "test-token",
			delayImpl: () => Promise.resolve(),
			fetchImpl: () => {
				calls++;
				return Promise.resolve(jsonResponse({ message: "Missing Permissions" }, 403));
			},
		});

		await expect(rest.getBotIdentity()).rejects.toThrow(/403/);
		expect(calls).toBe(1);
	});
});
