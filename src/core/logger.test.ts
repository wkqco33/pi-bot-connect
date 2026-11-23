import { expect, it } from "vitest";
import { createRuntimeLogger, MemoryLogSink } from "./logger.js";

it("writes structured runtime events only in debug mode and omits raw diagnostics", () => {
	const sink = new MemoryLogSink();
	const details = {
		transport: "telegram",
		attempt: 2,
		error: "private provider response",
		username: "private name",
		identity: "telegram:fixture-user",
		botId: "fixture-bot",
	};
	createRuntimeLogger("bot-connect", sink, false).warn("telegram poll failed", details);
	expect(sink.entries).toEqual([]);

	createRuntimeLogger("bot-connect", sink, true).warn("telegram poll failed", details);
	expect(sink.entries).toEqual([{
		ts: expect.any(String), scope: "bot-connect", level: "warn", msg: "telegram poll failed",
		meta: { transport: "telegram", attempt: 2 },
	}]);
});
