import { describe, expect, it } from "vitest";
import {
	extractTestSummary,
	isTestCommand,
	normalizeGitPath,
	parseGitBranch,
	parseGitNumstat,
	summarizeTestRun,
} from "./work.js";

describe("normalizeGitPath", () => {
	it("returns a plain path unchanged", () => {
		expect(normalizeGitPath("src/core/chunk.ts")).toBe("src/core/chunk.ts");
	});

	it("unquotes a quoted path", () => {
		expect(normalizeGitPath('"src/with space.ts"')).toBe("src/with space.ts");
	});

	it("resolves a partial rename inside braces", () => {
		expect(normalizeGitPath("src/{core => kernel}/chunk.ts")).toBe("src/kernel/chunk.ts");
	});

	it("resolves a rename with no common prefix", () => {
		expect(normalizeGitPath("src/a.ts => src/b.ts")).toBe("src/b.ts");
	});

	it("resolves a rename of the file name only", () => {
		expect(normalizeGitPath("src/{old.ts => new.ts}")).toBe("src/new.ts");
	});

	it("trims stray whitespace in a rename target", () => {
		expect(normalizeGitPath("a/{b =>   c}/d")).toBe("a/c/d");
	});
});

describe("parseGitNumstat", () => {
	const OUTPUT = ["12\t3\tsrc/a.ts", "0\t5\tsrc/b.ts", "-\t-\tassets/logo.png", "4\t4\tsrc/c.ts"].join("\n");

	it("parses added and removed counts per file", () => {
		const changes = parseGitNumstat("12\t3\tsrc/a.ts");
		expect(changes).toEqual([{ path: "src/a.ts", added: 12, removed: 3 }]);
	});

	it("keeps binary files with zero counts", () => {
		expect(parseGitNumstat("-\t-\tassets/logo.png")).toEqual([
			{ path: "assets/logo.png", added: 0, removed: 0 },
		]);
	});

	it("sorts by total churn descending", () => {
		// a=15, b=5, logo=0, c=8 -> a, c, b, logo
		expect(parseGitNumstat(OUTPUT).map((change) => change.path)).toEqual([
			"src/a.ts",
			"src/c.ts",
			"src/b.ts",
			"assets/logo.png",
		]);
	});

	it("caps the number of entries after sorting", () => {
		expect(parseGitNumstat(OUTPUT, { max: 2 }).map((change) => change.path)).toEqual(["src/a.ts", "src/c.ts"]);
	});

	it("returns nothing for empty output", () => {
		expect(parseGitNumstat("")).toEqual([]);
		expect(parseGitNumstat("\n \n")).toEqual([]);
	});

	it("skips malformed lines instead of throwing", () => {
		expect(parseGitNumstat("not a numstat line\n12\t3\tsrc/a.ts")).toEqual([
			{ path: "src/a.ts", added: 12, removed: 3 },
		]);
	});

	it("skips a line with non-numeric counts", () => {
		expect(parseGitNumstat("x\ty\tsrc/a.ts")).toEqual([]);
	});

	it("resolves a rename line", () => {
		expect(parseGitNumstat("1\t1\tsrc/{a => b}/file.ts")).toEqual([
			{ path: "src/b/file.ts", added: 1, removed: 1 },
		]);
	});

	it("handles a path containing a space", () => {
		expect(parseGitNumstat("1\t1\tsrc/my file.ts")).toEqual([{ path: "src/my file.ts", added: 1, removed: 1 }]);
	});
});

describe("parseGitBranch", () => {
	it("trims the branch name", () => {
		expect(parseGitBranch("feat/core\n")).toBe("feat/core");
	});

	it("treats a detached HEAD as no branch", () => {
		expect(parseGitBranch("HEAD\n")).toBeUndefined();
	});

	it("treats empty output as no branch", () => {
		expect(parseGitBranch("")).toBeUndefined();
		expect(parseGitBranch("   \n")).toBeUndefined();
	});
});

describe("isTestCommand", () => {
	it("recognizes common test invocations", () => {
		for (const command of [
			"npm test",
			"npm run test",
			"npm run test:unit",
			"pnpm test",
			"yarn test",
			"bun test",
			"npx vitest run",
			"jest --watch",
			"pytest -q",
			"python -m pytest tests/",
			"go test ./...",
			"cargo test",
			"rspec",
			"./gradlew test",
			"mvn test",
			"make test",
			"dotnet test",
		]) {
			expect(isTestCommand(command), command).toBe(true);
		}
	});

	it("ignores unrelated commands", () => {
		for (const command of ["ls -la", "git status", "npm run build", "npm install", "cat test.txt"]) {
			expect(isTestCommand(command), command).toBe(false);
		}
	});
});

describe("extractTestSummary", () => {
	it("reads a vitest totals line", () => {
		const output = [" Test Files  17 passed (17)", "      Tests  312 passed (312)"].join("\n");
		expect(extractTestSummary(output)).toBe("312 passed");
	});

	it("reads a vitest totals line with failures", () => {
		expect(extractTestSummary("      Tests  2 failed | 310 passed (312)")).toBe("2 failed | 310 passed");
	});

	it("reads a jest totals line", () => {
		expect(extractTestSummary("Tests:       2 failed, 10 passed, 12 total")).toBe("2 failed, 10 passed, 12 total");
	});

	it("reads a cargo result line", () => {
		expect(extractTestSummary("test result: ok. 12 passed; 0 failed; 0 ignored")).toBe("12 passed, 0 failed");
	});

	it("reads a pytest summary line", () => {
		expect(extractTestSummary("========== 5 passed, 1 failed in 0.12s ==========")).toBe("5 passed, 1 failed");
	});

	it("reads go test output", () => {
		expect(extractTestSummary("ok  \tgithub.com/x/y\t0.512s")).toBe("ok");
		expect(extractTestSummary("FAIL\tgithub.com/x/y\t0.010s")).toBe("failed");
	});

	it("returns undefined when nothing recognisable is present", () => {
		expect(extractTestSummary("all good")).toBeUndefined();
		expect(extractTestSummary("")).toBeUndefined();
	});

	it("caps a very long summary", () => {
		const long = `Tests: ${"9 passed, ".repeat(40)}`;
		const summary = extractTestSummary(long);
		expect(summary).toBeDefined();
		expect((summary ?? "").length).toBeLessThanOrEqual(120);
	});
});

describe("summarizeTestRun", () => {
	it("returns undefined for a command that is not a test run", () => {
		expect(summarizeTestRun({ command: "ls -la", failed: false, output: "" })).toBeUndefined();
	});

	it("prefers the runner's own summary", () => {
		expect(summarizeTestRun({ command: "npm test", failed: false, output: "Tests  312 passed (312)" })).toBe(
			"npm test — 312 passed",
		);
	});

	it("falls back to the exit status when there is no summary", () => {
		expect(summarizeTestRun({ command: "go test ./...", failed: false, output: "" })).toBe("go test ./... — ok");
		expect(summarizeTestRun({ command: "go test ./...", failed: true, output: "" })).toBe(
			"go test ./... — failed",
		);
	});

	it("collapses whitespace and shortens a long command", () => {
		const command = `npm   test   ${"--flag ".repeat(12)}`;
		const summary = summarizeTestRun({ command, failed: false, output: "" });
		expect(summary?.startsWith("npm test --flag")).toBe(true);
		expect(summary?.endsWith("ok")).toBe(true);
	});
});
