import { describe, expect, it } from "vitest";
import { redactSecrets, redactWithReport } from "./redact.js";

describe("redactSecrets", () => {
	it("redacts Anthropic and OpenAI style keys", () => {
		const text = "key sk-ant-api03-AAAABBBBCCCCDDDDEEEE and sk-projABCDEFGHIJKLMNOPQRSTUV";
		const out = redactSecrets(text);
		expect(out).not.toContain("sk-ant-api03-AAAA");
		expect(out).not.toContain("sk-projABCDEF");
		expect(out).toContain("[redacted:anthropic-key]");
		expect(out).toContain("[redacted:openai-key]");
	});

	it("redacts GitHub, Slack, AWS and Google credentials", () => {
		const text = [
			"ghp_ABCDEFGHIJKLMNOPQRSTUVWX",
			"xoxb-1234567890-abcdefghijkl",
			"AKIAIOSFODNN7EXAMPLE",
			`AIza${'a'.repeat(35)}`,
		].join(" ");
		const out = redactSecrets(text);
		expect(out).not.toMatch(/ghp_|xoxb-|AKIA|AIza/);
	});

	it("redacts bearer tokens", () => {
		expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456")).toBe(
			"Authorization: Bearer [redacted]",
		);
	});

	it("redacts private key blocks", () => {
		const pem = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA", "-----END RSA PRIVATE KEY-----"].join("\n");
		const out = redactSecrets(`key follows\n${pem}\n`);
		expect(out).not.toContain("MIIEowIBAAKCAQEA");
		expect(out).toContain("[redacted:private-key]");
	});

	it("redacts JSON web tokens", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
		const out = redactSecrets(`token ${jwt}`);
		expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
		expect(out).toContain("[redacted:jwt]");
	});

	it("redacts a Discord bot token", () => {
		const token = `M${'a'.repeat(23)}.${'b'.repeat(6)}.${'c'.repeat(30)}`;
		const out = redactSecrets(`bot ${token}`);
		expect(out).not.toContain(token);
		expect(out).toContain("[redacted:discord-token]");
	});

	it("redacts an npm token", () => {
		const out = redactSecrets(`//registry.npmjs.org/:_authToken=npm_${'A'.repeat(36)}`);
		expect(out).not.toContain(`npm_${'A'.repeat(36)}`);
	});

	it("redacts API key headers that are not bearer tokens", () => {
		expect(redactSecrets("X-Api-Key: abc123def456")).toBe("X-Api-Key: [redacted]");
		expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [redacted]");
	});

	it("redacts secret env assignments but keeps the variable name", () => {
		expect(redactSecrets('export PI_TELEGRAM_TOKEN="123:secret"')).toBe("export PI_TELEGRAM_TOKEN=[redacted]");
		expect(redactSecrets("SLACK_APP_TOKEN=xapp-1-abcdefghijklmnop")).toBe("SLACK_APP_TOKEN=[redacted]");
		expect(redactSecrets("MY_API_KEY=plainvalue")).toBe("MY_API_KEY=[redacted]");
	});

	it("leaves ordinary text alone", () => {
		const text = "The build passed after I fixed the retry loop in chunk.ts";
		expect(redactSecrets(text)).toBe(text);
	});

	it("reports which rules fired without leaking the secret", () => {
		const report = redactWithReport("token ghp_ABCDEFGHIJKLMNOPQRSTUVWX");
		expect(report.hits).toEqual(["github-token"]);
		expect(JSON.stringify(report)).not.toContain("ABCDEFGHIJKLM");
	});

	it("is idempotent", () => {
		const once = redactSecrets("ghp_ABCDEFGHIJKLMNOPQRSTUVWX");
		expect(redactSecrets(once)).toBe(once);
	});

	it("supports custom rules", () => {
		const out = redactSecrets("internal-12345", {
			rules: [{ name: "custom", pattern: /internal-\d+/g, replacement: "[x]" }],
		});
		expect(out).toBe("[x]");
	});
});
