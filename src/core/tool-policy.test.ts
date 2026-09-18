import { describe, expect, it } from "vitest";
import {
	READ_ONLY_TOOLS,
	decideRemoteToolAccess,
	remoteToolApprovalPrompt,
	remoteToolBlockReason,
	remoteToolDeclinedReason,
	type RemoteToolPolicy,
} from "./tool-policy.js";

const POLICIES: readonly RemoteToolPolicy[] = ["unrestricted", "read-only", "no-tools"];

describe("decideRemoteToolAccess", () => {
	it("allows every tool under the default unrestricted policy", () => {
		for (const tool of ["read", "bash", "write", "edit", "grep"]) {
			expect(decideRemoteToolAccess("unrestricted", tool)).toBe("allow");
		}
	});

	it("blocks every tool under no-tools, even read-only ones", () => {
		for (const tool of ["read", "grep", "ls", "bash"]) {
			expect(decideRemoteToolAccess("no-tools", tool)).toBe("block");
		}
	});

	it("allows only the read-only set under read-only", () => {
		for (const tool of ["read", "grep", "find", "ls"]) {
			expect(decideRemoteToolAccess("read-only", tool)).toBe("allow");
		}
	});

	it("blocks mutating and shell tools under read-only", () => {
		for (const tool of ["bash", "write", "edit", "powershell"]) {
			expect(decideRemoteToolAccess("read-only", tool)).toBe("block");
		}
	});

	it("blocks an unknown tool under read-only rather than assuming it is safe", () => {
		expect(decideRemoteToolAccess("read-only", "some_custom_tool")).toBe("block");
	});

	it("treats every read-only tool as allowed", () => {
		for (const tool of READ_ONLY_TOOLS) {
			expect(decideRemoteToolAccess("read-only", tool)).toBe("allow");
		}
	});
});

describe("remoteToolBlockReason", () => {
	it("names the blocked tool so the model and the user can see why", () => {
		for (const policy of POLICIES) {
			expect(remoteToolBlockReason(policy, "bash")).toContain("bash");
		}
	});

	it("distinguishes a total block from a read-only block", () => {
		expect(remoteToolBlockReason("no-tools", "bash")).not.toBe(remoteToolBlockReason("read-only", "bash"));
	});

	it("never suggests running the tool remotely", () => {
		for (const policy of POLICIES) {
			expect(remoteToolBlockReason(policy, "bash")).toContain("locally");
		}
	});
});

describe("remoteToolApprovalPrompt", () => {
	it("names the tool so the operator knows what they are approving", () => {
		const prompt = remoteToolApprovalPrompt("bash");
		expect(prompt.title).toContain("bash");
		expect(prompt.message).toContain("bash");
	});

	it("never echoes tool arguments", () => {
		const prompt = remoteToolApprovalPrompt("bash");
		expect(prompt.title).not.toContain("{");
		expect(prompt.message).not.toContain("{");
	});
});

describe("remoteToolDeclinedReason", () => {
	it("explains that the operator declined without naming arguments", () => {
		const reason = remoteToolDeclinedReason("bash");
		expect(reason).toContain("bash");
		expect(reason).toContain("operator");
	});
});
