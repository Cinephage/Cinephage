import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
import type { ServiceStatus, BackgroundService } from '#lib/server/services/background-service.js';
import { getMediaBrowserManager } from '#lib/server/notifications/mediabrowser/MediaBrowserManager.js';
import { createStatsProvider } from './providers/index.js';
import { db } from '#lib/server/db/index.js';
import { mediaServerSyncedItems, mediaServerSyncedRuns } from '#lib/server/db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const DEFAULT_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHUNK_SIZE = 500;

class MediaServerStatsSyncService extends EventEmitter implements BackgroundService {
	readonly name = 'MediaServerStatsSyncService';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;
	private intervalTimer: NodeJS.Timeout | null = null;
	// Tracks in-flight syncServer() invocations. When > 0, the dashboard's
	// "Sync Servers" button should remain in its working state. SSE clients
	// (/api/media-server-stats/sync/status) read this via currentlySyncing
	// and subscribe to syncStart/syncStop transitions.
	private activeSyncCount = 0;

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	get currentlySyncing(): boolean {
		return this.activeSyncCount > 0;
	}

	start(): void {
		if (this._status !== 'pending') return;
		this._status = 'starting';

		setImmediate(() => {
			try {
				this._status = 'ready';
				this.scheduleInterval();
				logger.info('[MediaServerStatsSync] Service started');
			} catch (error) {
				this._error = error instanceof Error ? error : new Error(String(error));
				this._status = 'error';
				logger.error({ error: this._error.message }, '[MediaServerStatsSync] Failed to start');
			}
		});
	}

	async stop(): Promise<void> {
		if (this.intervalTimer) {
			clearInterval(this.intervalTimer);
			this.intervalTimer = null;
		}
		this._status = 'pending';
		logger.info('[MediaServerStatsSync] Service stopped');
	}

	private scheduleInterval(): void {
		if (this.intervalTimer) {
			clearInterval(this.intervalTimer);
		}

		this.intervalTimer = setInterval(() => {
			this.syncServer().catch((error) => {
				logger.error(
					{ error: error instanceof Error ? error.message : String(error) },
					'[MediaServerStatsSync] Scheduled sync failed'
				);
			});
		}, DEFAULT_SYNC_INTERVAL_MS);
	}

	async syncServer(serverId?: string): Promise<void> {
		// Track overall sync state and emit transitions for SSE clients.
		const wasSyncing = this.currentlySyncing;
		this.activeSyncCount++;
		if (!wasSyncing) {
			this.emit('syncStart', { timestamp: new Date().toISOString() });
		}

		try {
			const manager = getMediaBrowserManager();
			let servers = await manager.getEnabledServers();

			if (serverId) {
				servers = servers.filter((s) => s.id === serverId);
			}

			if (servers.length === 0) {
				logger.debug('[MediaServerStatsSync] No enabled servers to sync');
				return;
			}

			for (const server of servers) {
				await this.syncSingleServer(server);
			}
		} finally {
			this.activeSyncCount = Math.max(0, this.activeSyncCount - 1);
			if (!this.currentlySyncing) {
				this.emit('syncStop', { timestamp: new Date().toISOString() });
			}
		}
	}

	private async syncSingleServer(server: {
		id: string;
		name: string;
		host: string;
		apiKey: string;
		serverType: string;
	}): Promise<void> {
		const runId = randomUUID();
		const startedAt = new Date().toISOString();

		// Refresh server metadata (version, name, health) before syncing items
		const manager = getMediaBrowserManager();
		const healthResult = await manager.testServer(server.id);
		if (!healthResult.success) {
			logger.warn(
				{ serverId: server.id, serverName: server.name, error: healthResult.error },
				'[MediaServerStatsSync] Server health check failed, skipping sync'
			);
			return;
		}

		await db.insert(mediaServerSyncedRuns).values({
			id: runId,
			serverId: server.id,
			status: 'running',
			startedAt
		});

		let itemsSynced = 0;
		let itemsAdded = 0;
		let itemsUpdated = 0;
		const itemsRemoved = 0;

		try {
			const provider = createStatsProvider({
				host: server.host,
				apiKey: server.apiKey,
				serverId: server.id,
				serverType: server.serverType as 'jellyfin' | 'emby' | 'plex'
			});

			const result = await provider.fetchAllItems();
			const now = new Date().toISOString();

			for (const item of result.items) {
				const existingRows = await db
					.select({ id: mediaServerSyncedItems.id })
					.from(mediaServerSyncedItems)
					.where(
						and(
							eq(mediaServerSyncedItems.serverId, server.id),
							eq(mediaServerSyncedItems.serverItemId, item.serverItemId)
						)
					)
					.limit(1);

				const values = {
					serverId: server.id,
					serverItemId: item.serverItemId,
					tmdbId: item.tmdbId,
					tvdbId: item.tvdbId,
					imdbId: item.imdbId,
					title: item.title,
					year: item.year,
					itemType: item.itemType,
					seriesName: item.seriesName,
					seasonNumber: item.seasonNumber,
					episodeNumber: item.episodeNumber,
					playCount: item.playCount,
					lastPlayedDate: item.lastPlayedDate,
					playedPercentage: item.playedPercentage,
					isPlayed: item.isPlayed ? 1 : 0,
					videoCodec: item.videoCodec,
					videoProfile: item.videoProfile,
					videoBitDepth: item.videoBitDepth,
					width: item.width,
					height: item.height,
					isHDR: item.isHDR ? 1 : 0,
					hdrFormat: item.hdrFormat,
					videoBitrate: item.videoBitrate,
					audioCodec: item.audioCodec,
					audioChannels: item.audioChannels,
					audioChannelLayout: item.audioChannelLayout,
					audioBitrate: item.audioBitrate,
					audioLanguages: item.audioLanguages,
					subtitleLanguages: item.subtitleLanguages,
					audioLanguagesRaw: item.audioLanguagesRaw,
					subtitleLanguagesRaw: item.subtitleLanguagesRaw,
					containerFormat: item.containerFormat,
					fileSize: item.fileSize,
					bitrate: item.bitrate,
					duration: item.duration,
					lastSyncedAt: now,
					updatedAt: now
				};

				if (existingRows.length > 0) {
					await db
						.update(mediaServerSyncedItems)
						.set(values)
						.where(eq(mediaServerSyncedItems.id, existingRows[0].id));
					itemsUpdated++;
				} else {
					await db.insert(mediaServerSyncedItems).values(values);
					itemsAdded++;
				}
				itemsSynced++;
			}

			if (result.serverItemIds.size > 0) {
				// notInArray with large arrays exceeds SQLite's variable limit.
				// Load existing IDs, compute stale set locally, delete in chunks.
				const existingRows = await db
					.select({ serverItemId: mediaServerSyncedItems.serverItemId })
					.from(mediaServerSyncedItems)
					.where(eq(mediaServerSyncedItems.serverId, server.id));

				const staleIds = existingRows
					.map((r) => r.serverItemId)
					.filter((id) => !result.serverItemIds.has(id));

				for (let i = 0; i < staleIds.length; i += CHUNK_SIZE) {
					const batch = staleIds.slice(i, i + CHUNK_SIZE);
					await db
						.delete(mediaServerSyncedItems)
						.where(
							and(
								eq(mediaServerSyncedItems.serverId, server.id),
								inArray(mediaServerSyncedItems.serverItemId, batch)
							)
						);
				}
			}

			const completedAt = new Date().toISOString();
			const duration = new Date(completedAt).getTime() - new Date(startedAt).getTime();

			await db
				.update(mediaServerSyncedRuns)
				.set({
					status: 'completed',
					itemsSynced,
					itemsAdded,
					itemsUpdated,
					itemsRemoved,
					completedAt,
					duration
				})
				.where(eq(mediaServerSyncedRuns.id, runId));

			this.emit('syncComplete', {
				serverId: server.id,
				itemsSynced,
				itemsAdded,
				itemsUpdated,
				itemsRemoved
			});

			logger.info(
				{
					serverId: server.id,
					serverName: server.name,
					itemsSynced,
					itemsAdded,
					itemsUpdated,
					itemsRemoved,
					durationMs: duration
				},
				'[MediaServerStatsSync] Sync completed'
			);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const completedAt = new Date().toISOString();
			const duration = new Date(completedAt).getTime() - new Date(startedAt).getTime();

			await db
				.update(mediaServerSyncedRuns)
				.set({
					status: 'failed',
					itemsSynced,
					itemsAdded,
					itemsUpdated,
					itemsRemoved,
					errorMessage,
					completedAt,
					duration
				})
				.where(eq(mediaServerSyncedRuns.id, runId));

			this.emit('syncError', { serverId: server.id, error });

			logger.error(
				{
					serverId: server.id,
					serverName: server.name,
					error: errorMessage
				},
				'[MediaServerStatsSync] Sync failed'
			);
		}
	}
}

let instance: MediaServerStatsSyncService | null = null;

export function getMediaServerStatsSyncService(): MediaServerStatsSyncService {
	if (!instance) {
		instance = new MediaServerStatsSyncService();
	}
	return instance;
}

export { MediaServerStatsSyncService };
