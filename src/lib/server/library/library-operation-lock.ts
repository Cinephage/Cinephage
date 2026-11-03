/**
 * Library Operation Lock
 *
 * In-process mutual exclusion between long-running library filesystem
 * operations (bulk renames, folder reorganizes, root-folder moves) and
 * library scans. A scan running while folders are being renamed sees a
 * half-renamed state and, because the scan diff is path-based, hard-deletes
 * the rows for moved files (jellyfin/jellyfin#16883 failure class).
 *
 * Rename/move operations acquire the lock; DiskScanService refuses to start
 * while it is held; the library watcher re-queues events instead of scanning.
 *
 * Invariant: `waiters.length > 0` implies `currentHolder !== null`. Ownership
 * transfers directly in `release()` (the holder assigns `currentHolder` to the
 * next waiter's operation before resolving it), so `isLocked` never observably
 * drops while waiters are queued.
 *
 * Prefer `withLock` over a raw `acquire()`: a caller that forgets to release
 * the acquired lock deadlocks every subsequent library operation.
 *
 * Note: `holder` may briefly report the next queued operation before its
 * wrapped function starts running - this is intentional and part of the
 * direct ownership handoff.
 */
export class LibraryOperationLock {
	private currentHolder: string | null = null;
	private waiters: Array<{ operation: string; resolve: () => void }> = [];

	get isLocked(): boolean {
		return this.currentHolder !== null;
	}

	get holder(): string | null {
		return this.currentHolder;
	}

	get pendingCount(): number {
		return this.waiters.length;
	}

	async acquire(operation: string): Promise<() => void> {
		if (this.currentHolder !== null) {
			await new Promise<void>((resolve) => this.waiters.push({ operation, resolve }));
			// release() assigned currentHolder = operation before resolving us.
		} else {
			this.currentHolder = operation;
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.waiters.shift();
			if (next) {
				this.currentHolder = next.operation;
				next.resolve();
			} else {
				this.currentHolder = null;
			}
		};
	}

	async withLock<T>(operation: string, fn: () => Promise<T>): Promise<T> {
		const release = await this.acquire(operation);
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

export const libraryOperationLock = new LibraryOperationLock();
