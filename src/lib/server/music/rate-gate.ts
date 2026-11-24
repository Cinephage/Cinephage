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
	private notBefore = 0;
	/** Set after the server throttles us: a slower pace, not just one sleep. */
	private slowUntil = 0;

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
		const until = this.now() + Math.max(0, ms);
		this.notBefore = Math.max(this.notBefore, until);
		this.nextAt = Math.max(this.nextAt, until);
	}

	/**
	 * The server said slow down, not just "wait once".
	 *
	 * MusicBrainz enforces a rolling average: a burst that drew a 503 needs a
	 * visibly slower pace for a while, otherwise the very next requests walk
	 * straight back into the limit. The gate stays at 2.5x its interval for the
	 * penalty window (five minutes by default), then decays on its own.
	 */
	throttle(waitMs: number, penaltyMs = 5 * 60_000): void {
		this.slowUntil = Math.max(this.slowUntil, this.now() + Math.max(0, penaltyMs));
		this.hold(waitMs);
	}

	private get intervalMs(): number {
		return this.now() < this.slowUntil
			? Math.round(this.minIntervalMs * 2.5)
			: this.minIntervalMs;
	}

	/** Wait until this caller's slot is due, re-checking a hold after waking. */
	async wait(): Promise<void> {
		for (;;) {
			const now = this.now();
			const reservedAt = Math.max(now, this.nextAt, this.notBefore);
			this.nextAt = reservedAt + this.intervalMs;

			const delay = reservedAt - now;
			if (delay > 0) await this.sleep(delay);
			// A hold issued while this caller was asleep must delay it too. One
			// extra sleep, not a re-reservation loop: a fake clock in a test never
			// advances, and an unbounded loop would hang it.
			const held = this.notBefore - this.now();
			if (held > 0) await this.sleep(held);
			return;
		}
	}
}
