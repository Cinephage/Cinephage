import type { BackgroundService, ServiceStatus } from '#lib/server/services/background-service.js';
import { getProwlarrConnection, syncProwlarrIndexers } from './ProwlarrConnectionService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });

/** Poll every 30 seconds to check if sync is due */
const POLL_INTERVAL_MS = 30 * 1000;

/** Grace period before first poll after startup */
const STARTUP_GRACE_MS = 3 * 60 * 1000;

export class ProwlarrSyncScheduler implements BackgroundService {
	private static instance: ProwlarrSyncScheduler | null = null;

	readonly name = 'ProwlarrSyncScheduler';
	private _status: ServiceStatus = 'pending';
	private _error: Error | undefined;

	private timer: NodeJS.Timeout | null = null;
	private startupTime: Date | null = null;
	private running = false;

	private constructor() {}

	static getInstance(): ProwlarrSyncScheduler {
		if (!ProwlarrSyncScheduler.instance) {
			ProwlarrSyncScheduler.instance = new ProwlarrSyncScheduler();
		}
		return ProwlarrSyncScheduler.instance;
	}

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	start(): void {
		if (this._status === 'starting' || this._status === 'ready') return;
		this._status = 'starting';
		this.startupTime = new Date();

		setImmediate(() => {
			this.timer = setInterval(() => {
				this.poll().catch((err) => {
					logger.error({ err }, '[ProwlarrSync] Poll error');
				});
			}, POLL_INTERVAL_MS);
			this._status = 'ready';
			logger.info('[ProwlarrSync] Scheduler started');
		});
	}

	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this._status = 'pending';
		this.startupTime = null;
		logger.info('[ProwlarrSync] Scheduler stopped');
	}

	private async poll(): Promise<void> {
		if (this.running) return;

		// Startup grace period
		if (this.startupTime) {
			const elapsed = Date.now() - this.startupTime.getTime();
			if (elapsed < STARTUP_GRACE_MS) return;
		}

		const conn = await getProwlarrConnection();
		if (!conn?.autoSync) return;

		if (!conn.lastSyncAt) {
			// Never synced — run immediately
			await this.runSync();
			return;
		}

		const intervalMs = conn.syncIntervalHours * 60 * 60 * 1000;
		const elapsed = Date.now() - new Date(conn.lastSyncAt).getTime();
		if (elapsed >= intervalMs) {
			await this.runSync();
		}
	}

	private async runSync(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			logger.info('[ProwlarrSync] Running scheduled sync');
			const result = await syncProwlarrIndexers();
			logger.info(
				{ added: result.added, removed: result.removed, failed: result.failed },
				'[ProwlarrSync] Scheduled sync complete'
			);
		} catch (err) {
			logger.error({ err }, '[ProwlarrSync] Scheduled sync failed');
		} finally {
			this.running = false;
		}
	}
}

export function getProwlarrSyncScheduler(): ProwlarrSyncScheduler {
	return ProwlarrSyncScheduler.getInstance();
}
