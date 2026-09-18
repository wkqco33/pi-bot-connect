import { describe, expect, it } from "vitest";
import { thinkingLabel, toolEndLabel, toolStartLabel } from "./progress.js";

describe("progress labels", () => {
	it("labels the reasoning phase before any tool runs", () => {
		expect(thinkingLabel()).toBe("thinking…");
	});

	it("labels a running tool by name only", () => {
		expect(toolStartLabel("bash")).toBe("▶ bash");
	});

	it("labels a successful tool finish", () => {
		expect(toolEndLabel("bash", true)).toBe("✓ bash");
	});

	it("labels a failed tool finish", () => {
		expect(toolEndLabel("bash", false)).toBe("✕ bash");
	});

	it("collapses whitespace so a tool name cannot break the one-line card", () => {
		expect(toolStartLabel("  mcp\n weird  ")).toBe("▶ mcp weird");
	});
});
