/**
 * Serialises outbound calls to a service that publishes a hard rate limit.
 *
 * MusicBrainz allows one request per second per client and answers an error
 * object (not an empty result) when it is exceeded, so concurrent callers must
 * be spaced rather than retried blindly. The gate reserves the next free slot
 * synchronously, before awaiting, so two callers that arrive together get
 * consecutive slots instead of both seeing the same one.
 */
export type SleepFn = (ms: number) => Promise<void>;

export class RateGate {
	private nextAt: number;

	constructor(
		private readonly minIntervalMs: number,
		private readonly now: () => number = Date.now,
		private readonly sleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
	) {
		this.nextAt = 0;
	}

	/**
	 * Push every caller back by `ms`.
	 *
	 * A 503 from the server is not this caller's problem alone — the whole
	 * client is over the limit, and retrying privately while others keep
	 * firing is how a busy minute becomes a block. Holding the shared slot
	 * makes the backoff apply to everyone queued behind it.
	 */
	hold(ms: number): void {
		this.nextAt = Math.max(this.nextAt, this.now() + Math.max(0, ms));
	}

	/** Wait until this caller's slot is due. */
	async wait(): Promise<void> {
		const now = this.now();
		const reservedAt = Math.max(now, this.nextAt);
		this.nextAt = reservedAt + this.minIntervalMs;

		const delay = reservedAt - now;
		if (delay > 0) await this.sleep(delay);
	}
}
