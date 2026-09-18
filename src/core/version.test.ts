import { describe, expect, it } from "vitest";
import { formatVersionReport, parsePackageMeta, VERSION_UNAVAILABLE_NOTICE } from "./version.js";

describe("parsePackageMeta", () => {
	it("reads name and version from a package manifest", () => {
		expect(parsePackageMeta({ name: "pi-bot-connect", version: "0.4.0" })).toEqual({
			name: "pi-bot-connect",
			version: "0.4.0",
		});
	});

	it("rejects a non-object", () => {
		expect(parsePackageMeta("0.4.0")).toBeNull();
		expect(parsePackageMeta(null)).toBeNull();
		expect(parsePackageMeta([])).toBeNull();
	});

	it("rejects a missing or empty version", () => {
		expect(parsePackageMeta({ name: "pi-bot-connect" })).toBeNull();
		expect(parsePackageMeta({ name: "pi-bot-connect", version: "" })).toBeNull();
		expect(parsePackageMeta({ name: "pi-bot-connect", version: 4 })).toBeNull();
	});

	it("rejects a missing or empty name", () => {
		expect(parsePackageMeta({ version: "0.4.0" })).toBeNull();
		expect(parsePackageMeta({ name: "", version: "0.4.0" })).toBeNull();
	});
});

describe("formatVersionReport", () => {
	it("names the package and the version", () => {
		const report = formatVersionReport({ name: "pi-bot-connect", version: "0.4.0", node: "v24.20.0" });
		expect(report).toContain("pi-bot-connect 0.4.0");
		expect(report).toContain("node v24.20.0");
	});

	it("includes the install location when it is known", () => {
		const report = formatVersionReport({
			name: "pi-bot-connect",
			version: "0.4.0",
			node: "v24.20.0",
			location: "/home/u/.pi/agent/extensions/pi-bot-connect",
		});
		expect(report).toContain("/home/u/.pi/agent/extensions/pi-bot-connect");
	});

	it("omits the location line when it is unknown", () => {
		const report = formatVersionReport({ name: "pi-bot-connect", version: "0.4.0", node: "v24.20.0" });
		expect(report).not.toContain("installed at");
	});
});

describe("VERSION_UNAVAILABLE_NOTICE", () => {
	it("explains that the manifest could not be read", () => {
		expect(VERSION_UNAVAILABLE_NOTICE).toContain("Could not read");
	});
});
