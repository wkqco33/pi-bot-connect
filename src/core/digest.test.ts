import { describe, expect, it } from "vitest";
import { buildWorkDigest, type WorkDigestInput } from "./digest.js";

const BASE: WorkDigestInput = {
	cwd: "/work/pi-bot-connect",
	agentState: "idle",
};

describe("buildWorkDigest", () => {
	it("always renders a header with state and working directory", () => {
		const digest = buildWorkDigest({ ...BASE, sessionName: "refactor-bridge", branch: "feat/core" });
		expect(digest).toContain("### refactor-bridge — idle");
		expect(digest).toContain("`/work/pi-bot-connect`");
		expect(digest).toContain("branch `feat/core`");
	});

	it("falls back to a generic title and omits a missing branch", () => {
		const digest = buildWorkDigest(BASE);
		expect(digest).toContain("### pi session — idle");
		expect(digest).not.toContain("branch");
	});

	it("summarizes todos with a pending count", () => {
		const digest = buildWorkDigest({
			...BASE,
			todos: [
				{ text: "write router tests", done: true },
				{ text: "wire telegram transport", done: false },
				{ text: "write AGENTS.md", done: false },
			],
		});
		expect(digest).toContain("**Pending (2/3)**");
		expect(digest).toContain("- [x] write router tests");
		expect(digest).toContain("- [ ] wire telegram transport");
	});

	it("totals line changes and caps the file list", () => {
		const changes = Array.from({ length: 9 }, (_, index) => ({
			path: `src/file-${index}.ts`,
			added: 10,
			removed: index,
		}));
		const digest = buildWorkDigest({ ...BASE, changes }, { maxFiles: 3 });
		expect(digest).toContain("**Changes (9 files, +90/-36)**");
		expect(digest).toContain("`src/file-0.ts` +10/-0");
		expect(digest).toContain("…and 6 more");
		expect(digest).not.toContain("src/file-4.ts");
	});

	it("reports the currently running tool", () => {
		const digest = buildWorkDigest({ ...BASE, agentState: "busy", runningTool: "bash: npm test" });
		expect(digest).toContain("### pi session — busy");
		expect(digest).toContain("**Now:** bash: npm test");
	});

	it("includes the test summary", () => {
		const digest = buildWorkDigest({ ...BASE, testSummary: "99 passed, 0 failed" });
		expect(digest).toContain("**Tests:** 99 passed, 0 failed");
	});

	it("redacts secrets from captured prompts and summaries", () => {
		const digest = buildWorkDigest({
			...BASE,
			lastUserPrompt: "deploy with token ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
			lastAssistantSummary: "used sk-ant-api03-AAAABBBBCCCCDDDDEEEE",
		});
		expect(digest).not.toContain("ghp_ABCDEF");
		expect(digest).not.toContain("sk-ant-api03");
		expect(digest).toContain("[redacted:github-token]");
	});

	it("can be told not to redact", () => {
		const digest = buildWorkDigest({ ...BASE, lastUserPrompt: "token ghp_ABCDEFGHIJKLMNOPQRSTUVWX" }, { redact: false });
		expect(digest).toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWX");
	});

	it("drops low-priority sections instead of exceeding the budget", () => {
		const digest = buildWorkDigest(
			{
				...BASE,
				sessionName: "long",
				changes: [{ path: "src/a.ts", added: 1, removed: 1 }],
				lastUserPrompt: "x".repeat(400),
				lastAssistantSummary: "y".repeat(400),
			},
			{ maxLength: 200 },
		);
		expect(digest.length).toBeLessThanOrEqual(260);
		expect(digest).toContain("digest truncated");
		expect(digest).toContain("**Changes");
	});

	it("skips empty sections entirely", () => {
		const digest = buildWorkDigest(BASE);
		expect(digest).not.toContain("**Pending");
		expect(digest).not.toContain("**Changes");
		expect(digest).not.toContain("**Tests");
		expect(digest).not.toContain("**Last request");
	});
});
