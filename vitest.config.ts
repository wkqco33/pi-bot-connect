/**
 * Vitest configuration.
 *
 * Kept as a plain object on purpose: some TS language servers do not honor the
 * `types` condition of vitest's exports map for `vitest/config`, which makes the
 * whole repo look red. A plain object needs no import and stays portable.
 */
export default {
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/index.ts", "src/transports/index.ts"],
		},
	},
};
