import type { BackgroundService, ServiceStatus } from '#lib/server/services/background-service.js';
import { getJackettConnection, syncJackettIndexers } from './JackettConnectionService.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });

const POLL_INTERVAL_MS = 30 * 1000;
const STARTUP_GRACE_MS = 3 * 60 * 1000;

export class JackettSyncScheduler implements BackgroundService {
	private static instance: JackettSyncScheduler | null = null;

	readonly name = 'JackettSyncScheduler';
	private _status: ServiceStatus = 'pending';
	private _error: Error | undefined;

	private timer: NodeJS.Timeout | null = null;
	private startupTime: Date | null = null;
	private running = false;

	private constructor() {}

	static getInstance(): JackettSyncScheduler {
		if (!JackettSyncScheduler.instance) {
			JackettSyncScheduler.instance = new JackettSyncScheduler();
		}
		return JackettSyncScheduler.instance;
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
					logger.error({ err }, '[JackettSync] Poll error');
				});
			}, POLL_INTERVAL_MS);
			this._status = 'ready';
			logger.info('[JackettSync] Scheduler started');
		});
	}

	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this._status = 'pending';
		this.startupTime = null;
		logger.info('[JackettSync] Scheduler stopped');
	}

	private async poll(): Promise<void> {
		if (this.running) return;

		if (this.startupTime) {
			const elapsed = Date.now() - this.startupTime.getTime();
			if (elapsed < STARTUP_GRACE_MS) return;
		}

		const conn = await getJackettConnection();
		if (!conn?.autoSync) return;

		if (!conn.lastSyncAt) {
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
			logger.info('[JackettSync] Running scheduled sync');
			const result = await syncJackettIndexers();
			logger.info(
				{ added: result.added, removed: result.removed, failed: result.failed },
				'[JackettSync] Scheduled sync complete'
			);
		} catch (err) {
			logger.error({ err }, '[JackettSync] Scheduled sync failed');
		} finally {
			this.running = false;
		}
	}
}

export function getJackettSyncScheduler(): JackettSyncScheduler {
	return JackettSyncScheduler.getInstance();
}
