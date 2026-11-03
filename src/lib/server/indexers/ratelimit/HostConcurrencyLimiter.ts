/**
 * Per-host concurrency limiter.
 *
 * Limits how many requests to the same host can be in-flight simultaneously.
 * This prevents thundering-herd bursts when many indexers share a host
 * (e.g., 20 Prowlarr indexers all firing at once).
 *
 * Unlike rate limiting (N requests per time window), this is a semaphore:
 * at most N requests can be awaiting a response from the same host at any instant.
 */

const DEFAULT_MAX_CONCURRENT = 5;

/**
 * Extract a host key from a URL, including port so that different services
 * on the same machine are not treated as the same host.
 */
function concurrencyKey(url: string): string {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		return parsed.port ? `${host}:${parsed.port}` : host;
	} catch {
		return url.toLowerCase();
	}
}

export class HostConcurrencyLimiter {
	private inFlight: Map<string, number> = new Map();
	private queues: Map<string, Array<(acquired: boolean) => void>> = new Map();
	private maxConcurrent: number;

	constructor(maxConcurrent = DEFAULT_MAX_CONCURRENT) {
		this.maxConcurrent = maxConcurrent;
	}

	/**
	 * Acquire a concurrency slot for the given URL's host.
	 *
	 * Returns true when the slot is acquired (proceed with the request).
	 * Returns false if timeoutMs elapses before a slot becomes available.
	 * If timeoutMs is omitted, waits indefinitely.
	 */
	async acquire(url: string, timeoutMs?: number): Promise<boolean> {
		const key = concurrencyKey(url);
		const current = this.inFlight.get(key) ?? 0;

		if (current < this.maxConcurrent) {
			this.inFlight.set(key, current + 1);
			return true;
		}

		// No slot available - queue and wait
		return new Promise<boolean>((resolve) => {
			let settled = false;

			const onSlot = (acquired: boolean) => {
				if (settled) return;
				settled = true;
				if (acquired) {
					const n = this.inFlight.get(key) ?? 0;
					this.inFlight.set(key, n + 1);
				}
				resolve(acquired);
			};

			const queue = this.queues.get(key) ?? [];
			queue.push(onSlot);
			this.queues.set(key, queue);

			if (timeoutMs !== undefined) {
				setTimeout(() => {
					if (!settled) {
						settled = true;
						const q = this.queues.get(key);
						if (q) {
							const idx = q.indexOf(onSlot);
							if (idx > -1) q.splice(idx, 1);
						}
						resolve(false);
					}
				}, timeoutMs);
			}
		});
	}

	/**
	 * Release a concurrency slot for the given URL's host.
	 * Must be called in a finally block after every successful acquire.
	 */
	release(url: string): void {
		const key = concurrencyKey(url);
		const current = this.inFlight.get(key) ?? 0;
		const updated = Math.max(0, current - 1);
		if (updated === 0) {
			this.inFlight.delete(key);
		} else {
			this.inFlight.set(key, updated);
		}

		const queue = this.queues.get(key);
		if (queue?.length) {
			const next = queue.shift();
			if (queue.length === 0) {
				this.queues.delete(key);
			}
			if (next) next(true);
		} else if (this.queues.has(key)) {
			this.queues.delete(key);
		}
	}

	getInFlight(url: string): number {
		return this.inFlight.get(concurrencyKey(url)) ?? 0;
	}
}

let concurrencyLimiterInstance: HostConcurrencyLimiter | null = null;

export function getHostConcurrencyLimiter(): HostConcurrencyLimiter {
	if (!concurrencyLimiterInstance) {
		concurrencyLimiterInstance = new HostConcurrencyLimiter();
	}
	return concurrencyLimiterInstance;
}

export function resetHostConcurrencyLimiter(): void {
	concurrencyLimiterInstance = null;
}
