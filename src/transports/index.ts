/**
 * Transport registry.
 *
 * Adding a messenger = adding one file here that implements `Transport`.
 * Nothing else in the codebase changes, and the new adapter gets the same
 * routing, pairing, redaction, chunking and digest behaviour for free.
 *
 * Roadmap (see docs/architecture.md for the acceptance checklist per transport):
 *   - telegram.ts  long polling, 4096 chars, HTML flavor
 *   - discord.ts   gateway or REST polling, 2000 chars, markdown flavor
 *   - slack.ts     Socket Mode, 4000 chars, mrkdwn flavor
 *
 * Each transport must:
 *   1. never emit an `Envelope` field that is not in the contract
 *   2. set `isDirect` correctly (DMs vs channels) — addressing depends on it
 *   3. read credentials from environment variables, never from the config file
 *   4. pass `src/transports/transport-contract.test.ts` (see docs)
 */

import type { Transport } from "../core/types.js";

export interface TransportFactoryContext {
	readonly transportConfig: Readonly<Record<string, unknown>>;
	readonly logger: import("../core/types.js").Logger;
}

export interface TransportFactory {
	readonly id: string;
	/** Returns null when the transport is not configured; throws on bad config. */
	create(context: TransportFactoryContext): Transport | null;
}

/**
 * Factories registered at load time. Empty until real transports land, which
 * is why the extension loads cleanly with no credentials configured.
 */
const FACTORIES: readonly TransportFactory[] = [];

export function listTransportFactories(): readonly TransportFactory[] {
	return FACTORIES;
}

export function createTransports(
	transportsConfig: Readonly<Record<string, unknown>>,
	logger: import("../core/types.js").Logger,
): { transports: Transport[]; skipped: string[] } {
	const created: Transport[] = [];
	const skipped: string[] = [];

	for (const factory of FACTORIES) {
		// An entry may be disabled explicitly with `{ enabled: false }`.
		const entry = transportsConfig[factory.id];
		if (entry && typeof entry === "object" && "enabled" in entry && entry.enabled === false) {
			skipped.push(factory.id);
			continue;
		}
		const transport = factory.create({ transportConfig: transportsConfig, logger });
		if (transport) created.push(transport);
	}

	return { transports: created, skipped };
}
