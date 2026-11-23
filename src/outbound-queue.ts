type RunOutboundJob = (signal: AbortSignal) => Promise<boolean>;

interface Job {
	readonly turn?: number;
	readonly run: RunOutboundJob;
	readonly finish: (sent: boolean) => void;
	readonly fail: (error: unknown) => void;
}

interface Lane {
	readonly pending: Job[];
	active?: AbortController;
}

const MAX_PENDING = 8;

/** Orders publishes within a destination. Slow destinations drain independently. */
export class OutboundQueue {
	private readonly lanes = new Map<string, Lane>();

	push(key: string, run: RunOutboundJob, turn?: number): Promise<boolean> | undefined {
		const existing = this.lanes.get(key);
		const lane: Lane = existing ?? { pending: [] };
		const tail = lane.pending.at(-1);
		if (turn !== undefined && tail?.turn === turn) lane.pending.pop()?.finish(false);
		if (lane.pending.length >= MAX_PENDING) return undefined;

		const result = new Promise<boolean>((finish, fail) => {
			lane.pending.push({ run, finish, fail, ...(turn === undefined ? {} : { turn }) });
		});
		if (existing === undefined) {
			this.lanes.set(key, lane);
			void this.drain(key, lane);
		}
		return result;
	}

	cancel(key: string): void {
		const lane = this.lanes.get(key);
		if (lane === undefined) return;
		lane.active?.abort();
		for (const job of lane.pending.splice(0)) job.finish(false);
	}

	cancelAll(): void {
		for (const key of this.lanes.keys()) this.cancel(key);
	}

	private async drain(key: string, lane: Lane): Promise<void> {
		let job: Job | undefined;
		while ((job = lane.pending.shift()) !== undefined) {
			const controller = new AbortController();
			lane.active = controller;
			try {
				const sent = await job.run(controller.signal);
				job.finish(!controller.signal.aborted && sent);
			} catch (error) {
				if (controller.signal.aborted) job.finish(false);
				else job.fail(error);
			}
		}
		this.lanes.delete(key);
	}
}
