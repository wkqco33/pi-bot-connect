#!/usr/bin/env node
/**
 * Release gate: asserts the tarball contains exactly what it should.
 *
 * `npm pack --dry-run` prints a file list that nobody reads carefully at 2am.
 * This fails the build instead, so a missing LICENSE or a leaked dev file is
 * caught before an immutable artifact is published.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Files a consumer or the pi loader needs. */
const REQUIRED = [
	"package.json",
	"README.md",
	"LICENSE",
	"CHANGELOG.md",
	"AGENTS.md",
	"src/index.ts",
	"docs/architecture.md",
	"docs/feasibility.md",
];

/** Development-only paths that must never ship. */
const FORBIDDEN = [
	/^\.github\//,
	/^\.editorconfig$/,
	/^package-lock\.json$/,
	/^tsconfig\.json$/,
	/^vitest\.config\.ts$/,
	/^scripts\//,
	/^node_modules\//,
	/\.tgz$/,
	/^\.git\//,
];

function runPack() {
	const command = process.platform === "win32" ? "npm.cmd" : "npm";
	let raw;
	try {
		raw = execFileSync(command, ["pack", "--dry-run", "--json"], { encoding: "utf8" });
	} catch (error) {
		console.error("could not run `npm pack --dry-run --json`");
		throw error;
	}
	try {
		return JSON.parse(raw);
	} catch (error) {
		console.error("`npm pack --json` did not return JSON");
		throw error;
	}
}

function readManifest() {
	try {
		return JSON.parse(readFileSync("package.json", "utf8"));
	} catch (error) {
		console.error("could not read package.json");
		throw error;
	}
}

/**
 * npm 12 returns `{ "<name>": entry }`; older npm returns `[entry]`.
 * Accept both: the CI runner and a developer's machine will not agree.
 */
function firstEntry(report) {
	if (Array.isArray(report)) return report[0];
	if (report && typeof report === "object") {
		const values = Object.values(report);
		return values[0];
	}
	return undefined;
}

const report = runPack();
const entry = firstEntry(report);
if (!entry || !Array.isArray(entry.files)) {
	console.error("unexpected `npm pack --json` shape: no files array");
	console.error(JSON.stringify(report, null, 2).slice(0, 400));
	process.exit(1);
}

const paths = new Set(entry.files.map((file) => file.path));
const problems = [];

for (const required of REQUIRED) {
	if (!paths.has(required)) problems.push(`missing from the tarball: ${required}`);
}

for (const path of paths) {
	for (const pattern of FORBIDDEN) {
		if (pattern.test(path)) problems.push(`must not be published: ${path}`);
	}
}

const manifest = readManifest();
if (manifest.private === true) problems.push('package.json has "private": true');

// The pi manifest is how the extension gets loaded; a stale path ships a
// package that installs cleanly and then does nothing.
for (const extension of manifest.pi?.extensions ?? []) {
	const normalized = String(extension).replace(/^\.\//, "");
	if (!paths.has(normalized)) {
		problems.push(`pi manifest points at a file that is not shipped: ${extension}`);
	}
}

if (problems.length > 0) {
	console.error(`pack verification failed (${problems.length} problem(s)):`);
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}

const files = entry.entryCount ?? paths.size;
console.log(
	`pack verification passed: ${manifest.name}@${manifest.version}, ${files} files, ${entry.size} bytes packed, ${entry.unpackedSize} bytes unpacked`,
);
