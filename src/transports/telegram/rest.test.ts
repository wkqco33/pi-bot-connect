import { describe, expect, it, vi } from "vitest";
import { TelegramRest } from "./rest.js";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ok(result: unknown): Response {
	return json({ ok: true, result });
}

describe("TelegramRest — requests", () => {
	it("maps getMe to an identity string pair", async () => {
		const rest = new TelegramRest({
			token: "t",
			fetchImpl: () => Promise.resolve(ok({ id: 12345, username: "pi_bot" })),
		});
		await expect(rest.getMe()).resolves.toEqual({ id: "12345", username: "pi_bot" });
	});

	it("surfaces an ok:false response with its description", async () => {
		const rest = new TelegramRest({
			token: "t",
			fetchImpl: () => Promise.resolve(json({ ok: false, description: "Unauthorized" }, 401)),
		});
		await expect(rest.getMe()).rejects.toThrow(/Unauthorized/);
	});

	it("maps sendMessage to a message id", async () => {
		const rest = new TelegramRest({
			token: "t",
			fetchImpl: () => Promise.resolve(ok({ message_id: 77 })),
		});
		await expect(rest.sendMessage("-100", "hello")).resolves.toEqual({ messageId: "77" });
	});

	it("returns an empty list when getUpdates is not an array", async () => {
		const rest = new TelegramRest({
			token: "t",
			fetchImpl: () => Promise.resolve(ok(null)),
		});
		await expect(rest.getUpdates(undefined, 0)).resolves.toEqual([]);
	});

	it("sets HTML parse mode so rendered markup is not sent literally", async () => {
		let body: Record<string, unknown> = {};
		const rest = new TelegramRest({
			token: "t",
			fetchImpl: (_input, init) => {
				body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return Promise.resolve(ok({ message_id: 1 }));
			},
		});

		await rest.sendMessage("-100", "<b>hi</b>");

		expect(body).toMatchObject({ parse_mode: "HTML" });
	});

	it("sets HTML parse mode when editing as well", async () => {
		let body: Record<string, unknown> = {};
		const rest = new TelegramRest({
			token: "t",
			fetchImpl: (_input, init) => {
				body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return Promise.resolve(ok(true));
			},
		});

		await rest.editMessageText("-100", "1", "<b>hi</b>");

		expect(body).toMatchObject({ parse_mode: "HTML" });
	});

	it("passes the long-poll timeout and allowed updates", async () => {
		let body: Record<string, unknown> = {};
		const rest = new TelegramRest({
			token: "t",
			fetchImpl: (_input, init) => {
				body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				return Promise.resolve(ok([]));
			},
		});
		await rest.getUpdates(42, 25);
		expect(body).toMatchObject({ offset: 42, timeout: 25, allowed_updates: ["message"] });
	});

	it("embeds the token in the download url", () => {
		const rest = new TelegramRest({ token: "secret", fetchImpl: () => Promise.resolve(ok({})) });
		expect(rest.downloadUrl("photos/a.jpg")).toContain("/botsecret/photos/a.jpg");
	});

	it("passes an abort signal", async () => {
		let seen: AbortSignal | null | undefined;
		const rest = new TelegramRest({
			token: "t",
			fetchImpl: (_input, init) => {
				seen = init?.signal;
				return Promise.resolve(ok({ id: 1 }));
			},
		});
		await rest.getMe();
		expect(seen).toBeInstanceOf(AbortSignal);
	});
});

describe("TelegramRest — resilience", () => {
	it.each([429, 503])("cancels a message retry after HTTP %i", async (status) => {
		const canceled = new AbortController();
		const reason = new Error("disconnected");
		let fetches = 0;
		let fetchSignal: AbortSignal | null | undefined;
		let retrySignal: AbortSignal | undefined;
		const rest = new TelegramRest({
			token: "fixture",
			delayImpl: (_ms, signal) => {
				retrySignal = signal;
				canceled.abort(reason);
				return Promise.resolve();
			},
			fetchImpl: (_input, init) => {
				fetchSignal = init?.signal;
				expect(JSON.parse(String(init?.body))).toMatchObject({ message_thread_id: 42 });
				return Promise.resolve(++fetches === 1
					? json({ ok: false, parameters: { retry_after: 1 } }, status)
					: ok({ message_id: 2 }));
			},
		});

		await expect(rest.sendMessage("chat", "answer", "42", canceled.signal)).rejects.toBe(reason);
		expect(fetchSignal?.reason).toBe(reason);
		expect(retrySignal).toBe(canceled.signal);
		expect(fetches).toBe(1);
	});

	it("combines the long-poll deadline and shutdown signal", async () => {
		const shutdown = new AbortController();
		const deadline = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
		try {
			const rest = new TelegramRest({
				token: "t",
				maxRetries: 0,
				fetchImpl: (_input, init) => {
					deadline.abort(new Error("deadline"));
					expect(init?.signal?.aborted).toBe(true);
					return Promise.reject(init?.signal?.reason);
				},
			});
			await expect(rest.getUpdates(undefined, 30, shutdown.signal)).rejects.toThrow(/deadline/);
			expect(timeout).toHaveBeenCalledWith(40_000);
			expect(shutdown.signal.aborted).toBe(false);
		} finally {
			timeout.mockRestore();
		}
	});

	it("does not retry when the caller aborts an active request", async () => {
		const shutdown = new AbortController();
		const delayImpl = vi.fn(() => Promise.resolve());
		const fetchImpl = vi.fn((_input, init) => {
			shutdown.abort(new Error("shutdown"));
			return Promise.reject(init?.signal?.reason);
		});
		const rest = new TelegramRest({ token: "t", fetchImpl, delayImpl });
		await expect(rest.getUpdates(undefined, 30, shutdown.signal)).rejects.toThrow(/shutdown/);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(delayImpl).not.toHaveBeenCalled();
	});

	it("honors retry_after on a 429 and then succeeds", async () => {
		const statuses = [429, 200];
		const delays: number[] = [];
		const rest = new TelegramRest({
			token: "t",
			delayImpl: (ms) => {
				delays.push(ms);
				return Promise.resolve();
			},
			fetchImpl: () => {
				const status = statuses.shift() ?? 200;
				if (status === 429) {
					return Promise.resolve(json({ ok: false, parameters: { retry_after: 2 } }, 429));
				}
				return Promise.resolve(ok({ id: 1, username: "b" }));
			},
		});

		await expect(rest.getMe()).resolves.toMatchObject({ id: "1" });
		expect(delays).toEqual([2000]);
	});

	it("retries a 5xx and then succeeds", async () => {
		const statuses = [503, 200];
		const delays: number[] = [];
		const rest = new TelegramRest({
			token: "t",
			delayImpl: (ms) => {
				delays.push(ms);
				return Promise.resolve();
			},
			fetchImpl: () => {
				const status = statuses.shift() ?? 200;
				return Promise.resolve(status === 200 ? ok({ id: 1, username: "b" }) : json({ ok: false }, status));
			},
		});

		await expect(rest.getMe()).resolves.toMatchObject({ id: "1" });
		expect(delays).toHaveLength(1);
	});

	it("does not retry a 4xx", async () => {
		let calls = 0;
		const rest = new TelegramRest({
			token: "t",
			delayImpl: () => Promise.resolve(),
			fetchImpl: () => {
				calls++;
				return Promise.resolve(json({ ok: false, description: "Bad Request" }, 400));
			},
		});

		await expect(rest.getMe()).rejects.toThrow(/Bad Request/);
		expect(calls).toBe(1);
	});

	it("retries a network failure", async () => {
		let calls = 0;
		const rest = new TelegramRest({
			token: "t",
			delayImpl: () => Promise.resolve(),
			fetchImpl: () => {
				calls++;
				if (calls === 1) return Promise.reject(new Error("ECONNRESET"));
				return Promise.resolve(ok({ id: 1, username: "b" }));
			},
		});
		await expect(rest.getMe()).resolves.toMatchObject({ id: "1" });
	});

	it("surfaces a getFile response without a path", async () => {
		const rest = new TelegramRest({ token: "t", fetchImpl: () => Promise.resolve(ok({})) });
		await expect(rest.getFile("f1")).rejects.toThrow(/file path/);
	});
});
