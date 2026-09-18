/**
 * Markdown → transport-flavor rendering.
 *
 * The bridge always stores assistant output as CommonMark. Each transport asks
 * for the flavor it can actually display. Code spans and fences are protected
 * before prose rewriting so their contents are never mangled.
 */

export type MarkdownFlavor = "plain" | "markdown" | "html" | "mrkdwn";

interface ProtectedBlock {
	readonly raw: string;
	readonly kind: "code" | "fence";
}

const MARKER = "\u0000";
const MARKER_PATTERN = /\u0000(\d+)\u0000/g;

function markerFor(index: number): string {
	return `${MARKER}${index}${MARKER}`;
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function protectCode(markdown: string): { text: string; blocks: ProtectedBlock[] } {
	const blocks: ProtectedBlock[] = [];
	// A literal NUL in the source would collide with our marker scheme.
	let text = markdown.replace(/\u0000/g, "\uFFFD");

	text = text.replace(/```([^\n`]*)([\s\S]*?)```/g, (_match, _language: string, body: string) => {
		blocks.push({ raw: body, kind: "fence" });
		return markerFor(blocks.length - 1);
	});

	text = text.replace(/`([^`\n]+)`/g, (_match, body: string) => {
		blocks.push({ raw: body, kind: "code" });
		return markerFor(blocks.length - 1);
	});

	return { text, blocks };
}

type RenderableFlavor = Exclude<MarkdownFlavor, "markdown">;

const CODE_RENDERERS: Record<RenderableFlavor, (block: ProtectedBlock) => string> = {
	plain: (block) => block.raw,
	mrkdwn: (block) => (block.kind === "fence" ? `\`\`\`${block.raw}\`\`\`` : `\`${block.raw}\``),
	html: (block) =>
		block.kind === "fence" ? `<pre>${escapeHtml(block.raw)}</pre>` : `<code>${escapeHtml(block.raw)}</code>`,
};

function restoreCode(text: string, blocks: readonly ProtectedBlock[], flavor: RenderableFlavor): string {
	return text.replace(MARKER_PATTERN, (_match, rawIndex: string) => {
		const block = blocks[Number(rawIndex)];
		if (!block) return "";
		return CODE_RENDERERS[flavor](block);
	});
}

function toPlain(text: string): string {
	return text
		.replace(/^#{1,6}[ \t]+(.*)$/gm, "$1")
		.replace(/^>[ \t]?/gm, "")
		.replace(/^\s*[-*+][ \t]+/gm, "• ")
		.replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, "---")
		.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, "$1 ($2)")
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
		.replace(/(^|[^_])_([^_\n]+)_/g, "$1$2");
}

function toMrkdwn(text: string): string {
	return text
		.replace(/^#{1,6}[ \t]+(.*)$/gm, "*$1*")
		.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, "<$2|$1>")
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<$2|$1>")
		.replace(/\*\*([^*]+)\*\*/g, "*$1*")
		.replace(/__([^_]+)__/g, "*$1*")
		.replace(/~~([^~]+)~~/g, "~$1~");
}

function toHtmlProse(escaped: string): string {
	return escaped
		.replace(/^#{1,6}[ \t]+(.*)$/gm, "<b>$1</b>")
		.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
		.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
		.replace(/__([^_]+)__/g, "<b>$1</b>")
		.replace(/~~([^~]+)~~/g, "<s>$1</s>")
		.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
		.replace(/(^|[^_])_([^_\n]+)_/g, "$1<i>$2</i>");
}

const PROSE_RENDERERS: Record<RenderableFlavor, (text: string) => string> = {
	plain: toPlain,
	mrkdwn: toMrkdwn,
	html: (text) => toHtmlProse(escapeHtml(text)),
};

export function renderMarkdown(markdown: string, flavor: MarkdownFlavor): string {
	if (flavor === "markdown") return markdown;

	const { text, blocks } = protectCode(markdown);
	const prose = PROSE_RENDERERS[flavor](text);
	return restoreCode(prose, blocks, flavor);
}
