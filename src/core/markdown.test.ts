import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown } from "./markdown.js";

describe("escapeHtml", () => {
	it("escapes the characters that could break out of markup", () => {
		expect(escapeHtml('a & b <c> "d"')).toBe("a &amp; b &lt;c&gt; &quot;d&quot;");
	});
});

describe("renderMarkdown", () => {
	it("passes markdown through untouched for markdown-native transports", () => {
		const source = "## Title\n\n**bold** and `code`";
		expect(renderMarkdown(source, "markdown")).toBe(source);
	});

	describe("plain", () => {
		it("strips heading, emphasis and strikethrough markers", () => {
			expect(renderMarkdown("## Title", "plain")).toBe("Title");
			expect(renderMarkdown("**bold** and *italic* and ~~gone~~", "plain")).toBe("bold and italic and gone");
		});

		it("rewrites links to text and url", () => {
			expect(renderMarkdown("see [docs](https://x.dev/a)", "plain")).toBe("see docs (https://x.dev/a)");
		});

		it("keeps list structure with a bullet glyph", () => {
			expect(renderMarkdown("- one\n- two", "plain")).toBe("• one\n• two");
		});

		it("drops code delimiters but keeps the code text", () => {
			expect(renderMarkdown("run `npm test` now", "plain")).toBe("run npm test now");
			expect(renderMarkdown("```\nnpm test\n```", "plain")).toBe("\nnpm test\n");
		});
	});

	describe("html", () => {
		it("converts emphasis and code into tags", () => {
			expect(renderMarkdown("**bold** and `code`", "html")).toBe("<b>bold</b> and <code>code</code>");
		});

		it("escapes html in prose so user content cannot inject tags", () => {
			expect(renderMarkdown("<script>alert(1)</script>", "html")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
		});

		it("wraps fences in pre and escapes their body", () => {
			expect(renderMarkdown("```\n<tag>\n```", "html")).toBe("<pre>\n&lt;tag&gt;\n</pre>");
		});

		it("converts links to anchors", () => {
			expect(renderMarkdown("[docs](https://x.dev)", "html")).toBe('<a href="https://x.dev">docs</a>');
		});
	});

	describe("mrkdwn", () => {
		it("converts bold to single asterisks", () => {
			expect(renderMarkdown("**bold**", "mrkdwn")).toBe("*bold*");
			expect(renderMarkdown("__bold__", "mrkdwn")).toBe("*bold*");
		});

		it("converts strikethrough to Slack's single tilde", () => {
			expect(renderMarkdown("~~gone~~", "mrkdwn")).toBe("~gone~");
		});

		it("converts links to Slack link syntax", () => {
			expect(renderMarkdown("[docs](https://x.dev)", "mrkdwn")).toBe("<https://x.dev|docs>");
		});

		it("keeps inline code and fences", () => {
			expect(renderMarkdown("`code`", "mrkdwn")).toBe("`code`");
			expect(renderMarkdown("```\ncode\n```", "mrkdwn")).toBe("```\ncode\n```");
		});
	});

	describe("code protection", () => {
		it("does not rewrite markdown syntax inside code spans or fences", () => {
			expect(renderMarkdown("`**not bold**`", "plain")).toBe("**not bold**");
			expect(renderMarkdown("```\n**not bold**\n```", "plain")).toBe("\n**not bold**\n");
			expect(renderMarkdown("`**not bold**`", "mrkdwn")).toBe("`**not bold**`");
		});

		it("never leaks an internal marker", () => {
			const out = renderMarkdown("a `code` b ```\nfence\n``` c", "html");
			expect(out).not.toContain("\u0000");
		});

		it("replaces a literal NUL in the source instead of colliding with markers", () => {
			expect(renderMarkdown("bad\u0000value", "plain")).toBe("bad\uFFFDvalue");
		});
	});
});
