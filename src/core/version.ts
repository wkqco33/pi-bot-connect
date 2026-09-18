/**
 * Extension version reporting.
 *
 * pi exposes no version getter for an extension, so the adapter reads the
 * installed `package.json` at runtime. Validating that manifest is pure and
 * lives here, so `/connect version` renders the same way in every build and a
 * malformed manifest degrades to a clear notice instead of a crash.
 */

export interface PackageMeta {
	readonly name: string;
	readonly version: string;
}

/** Validates the untrusted manifest content read from disk. */
export function parsePackageMeta(raw: unknown): PackageMeta | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	const { name, version } = record;
	if (typeof name !== "string" || name.length === 0) return null;
	if (typeof version !== "string" || version.length === 0) return null;
	return { name, version };
}

export interface VersionReportInput {
	readonly name: string;
	readonly version: string;
	readonly node: string;
	/** Install directory of the extension, when it can be determined. */
	readonly location?: string;
}

/** Terminal-facing version card. Never contains credentials. */
export function formatVersionReport(input: VersionReportInput): string {
	const lines = [`${input.name} ${input.version}`, `- node ${input.node}`];
	if (input.location !== undefined && input.location.length > 0) lines.push(`- installed at ${input.location}`);
	return lines.join("\n");
}

export const VERSION_UNAVAILABLE_NOTICE =
	"Could not read the extension version from its package.json. Reinstall the package or run pi from an updated checkout.";
