import { describe, expect, it } from "vitest";
import { DiscordRest } from "./rest.js";

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
