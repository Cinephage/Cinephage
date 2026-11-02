/**
 * MediaBrowserNotifier - Background service for notifying Jellyfin, Emby, and Plex servers.
 *
 * Features:
 * - Batching: Waits before sending updates to deduplicate rapid changes
 * - Deduplication: Same path updated multiple times = single notification
 * - Non-blocking: Implements BackgroundService interface
 */

import { EventEmitter } from 'events';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
import type { ServiceStatus, BackgroundService } from '#lib/server/services/background-service.js';
import { getMediaBrowserManager } from './MediaBrowserManager';
import { MediaBrowserClient } from './MediaBrowserClient';
import type {
	LibraryUpdateType,
	PendingUpdate,
	LibraryUpdatePayload,
	MediaEventKind
} from './types';
import { MEDIA_EVENT_KIND_TOGGLE } from './types';

// Batching configuration
const BATCH_DELAY_MS = 5000; // Wait 5 seconds before sending
const MAX_BATCH_SIZE = 50; // Maximum updates per batch
const STOP_DRAIN_MAX_MS = 15000; // Maximum time to spend draining on stop()

class MediaBrowserNotifier extends EventEmitter implements BackgroundService {
	readonly name = 'MediaBrowserNotifier';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;

	// Pending updates queue (path -> update info)
	private pendingUpdates: Map<string, PendingUpdate> = new Map();
	private batchTimer: NodeJS.Timeout | null = null;
	private isProcessing = false;

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	/**
	 * Start the notifier service (non-blocking)
	 */
	start(): void {
		if (this._status !== 'pending') {
			return;
		}

		this._status = 'starting';

		setImmediate(() => {
			try {
				this._status = 'ready';
				logger.info('[MediaBrowserNotifier] Service started');
			} catch (error) {
				this._error = error instanceof Error ? error : new Error(String(error));
				this._status = 'error';
				logger.error(
					{
						error: this._error.message
					},
					'[MediaBrowserNotifier] Failed to start'
				);
			}
		});
	}

	/**
	 * Stop the notifier service.
	 * Drains pending update batches with a timeout to prevent
	 * indefinite blocking during server shutdown.
	 */
	async stop(): Promise<void> {
		if (this.batchTimer) {
			clearTimeout(this.batchTimer);
			this.batchTimer = null;
		}

		// Drain remaining updates with a deadline.
		const deadline = Date.now() + STOP_DRAIN_MAX_MS;
		while (this.pendingUpdates.size > 0 && Date.now() < deadline) {
			await this.processBatch();
			// Guard against infinite loop if processBatch returns
			// immediately but doesn't actually drain.
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		if (this.pendingUpdates.size > 0) {
			logger.warn(
				{ remaining: this.pendingUpdates.size },
				'[MediaBrowserNotifier] Stop drain timed out, discarding remaining updates'
			);
			this.pendingUpdates.clear();
		}

		this._status = 'pending';
		logger.info('[MediaBrowserNotifier] Service stopped');
	}

	/**
	 * Queue an update for notification
	 *
	 * @param path - The file/folder path that changed
	 * @param updateType - The type of change (Created, Modified, Deleted)
	 * @param eventKind - The originating operation ('import' | 'upgrade' | 'rename'
	 *   | 'delete'). Used to enforce each server's event toggles. Omitted for
	 *   legacy callers: the update is delivered to every enabled server.
	 */
	queueUpdate(path: string, updateType: LibraryUpdateType, eventKind?: MediaEventKind): void {
		if (this._status !== 'ready') {
			logger.debug(
				{
					status: this._status,
					path
				},
				'[MediaBrowserNotifier] Ignoring update - service not ready'
			);
			return;
		}

		// Normalize path
		const normalizedPath = path.replace(/\/+$/, '');

		// Check for existing update and determine priority
		// Priority order: Deleted > Modified > Created
		const existing = this.pendingUpdates.get(normalizedPath);

		if (existing) {
			// If existing is 'Deleted', keep it
			if (existing.updateType === 'Deleted') {
				return;
			}
			// If new is 'Deleted', upgrade
			if (updateType === 'Deleted') {
				existing.updateType = 'Deleted';
				existing.eventKind = eventKind ?? existing.eventKind;
				existing.addedAt = Date.now();
				return;
			}
			// If existing is 'Modified', keep it (higher than Created)
			if (existing.updateType === 'Modified') {
				return;
			}
			// Otherwise, upgrade to the new type
			existing.updateType = updateType;
			existing.eventKind = eventKind ?? existing.eventKind;
			existing.addedAt = Date.now();
		} else {
			// New entry
			this.pendingUpdates.set(normalizedPath, {
				path: normalizedPath,
				updateType,
				addedAt: Date.now(),
				eventKind
			});
		}

		logger.debug(
			{
				path: normalizedPath,
				updateType,
				queueSize: this.pendingUpdates.size
			},
			'[MediaBrowserNotifier] Update queued'
		);

		// Start batch timer if not already running
		if (!this.batchTimer && !this.isProcessing) {
			this.batchTimer = setTimeout(() => {
				this.batchTimer = null;
				this.processBatch().catch((error) => {
					logger.error(
						{
							error: error instanceof Error ? error.message : String(error)
						},
						'[MediaBrowserNotifier] Batch processing failed'
					);
				});
			}, BATCH_DELAY_MS);
		}
	}

	/**
	 * Process queued updates and send to all enabled servers
	 */
	private async processBatch(): Promise<void> {
		if (this.isProcessing || this.pendingUpdates.size === 0) {
			return;
		}

		this.isProcessing = true;

		try {
			// Get updates to process (limit to MAX_BATCH_SIZE)
			const updates: PendingUpdate[] = [];
			const pathsToRemove: string[] = [];

			for (const [path, update] of this.pendingUpdates) {
				if (updates.length >= MAX_BATCH_SIZE) {
					break;
				}
				updates.push(update);
				pathsToRemove.push(path);
			}

			// Remove processed updates from queue
			for (const path of pathsToRemove) {
				this.pendingUpdates.delete(path);
			}

			logger.info(
				{
					count: updates.length,
					remaining: this.pendingUpdates.size
				},
				'[MediaBrowserNotifier] Processing batch'
			);

			// Send to all enabled servers
			await this.sendToServers(updates);

			// If there are more updates, schedule another batch
			if (this.pendingUpdates.size > 0 && !this.batchTimer) {
				this.batchTimer = setTimeout(() => {
					this.batchTimer = null;
					this.processBatch().catch((error) => {
						logger.error(
							{
								error: error instanceof Error ? error.message : String(error)
							},
							'[MediaBrowserNotifier] Batch processing failed'
						);
					});
				}, BATCH_DELAY_MS);
			}
		} finally {
			this.isProcessing = false;
		}
	}

	/**
	 * Send updates to all enabled MediaBrowser servers
	 */
	private async sendToServers(updates: PendingUpdate[]): Promise<void> {
		const manager = getMediaBrowserManager();
		const enabledServers = await manager.getEnabledServers();

		if (enabledServers.length === 0) {
			logger.debug('[MediaBrowserNotifier] No enabled servers, skipping notification');
			return;
		}

		// Group updates by type for logging
		const byType = {
			Created: updates.filter((u) => u.updateType === 'Created').length,
			Modified: updates.filter((u) => u.updateType === 'Modified').length,
			Deleted: updates.filter((u) => u.updateType === 'Deleted').length
		};

		logger.info(
			{
				serverCount: enabledServers.length,
				updateCount: updates.length,
				byType
			},
			'[MediaBrowserNotifier] Sending updates to servers'
		);

		// Send to each enabled server, enforcing that server's event toggles.
		// Updates without an eventKind (legacy callers) always pass the filter.
		await Promise.all(
			enabledServers.map(async (server) => {
				try {
					const eligibleUpdates = updates.filter(
						(update) =>
							!update.eventKind || server[MEDIA_EVENT_KIND_TOGGLE[update.eventKind]] !== false
					);

					if (eligibleUpdates.length === 0) {
						logger.debug(
							{
								serverId: server.id,
								serverName: server.name
							},
							'[MediaBrowserNotifier] No eligible updates for server after toggle filter, skipping'
						);
						return;
					}

					// Apply path mappings
					const mappedUpdates = eligibleUpdates.map((update) => ({
						Path: MediaBrowserClient.mapPath(update.path, server.pathMappings),
						UpdateType: update.updateType
					}));

					const payload: LibraryUpdatePayload = {
						Updates: mappedUpdates
					};

					// Get or create client
					const client = new MediaBrowserClient({
						host: server.host,
						apiKey: server.apiKey,
						serverType: server.serverType as 'jellyfin' | 'emby' | 'plex'
					});

					const succeeded = await client.notifyLibraryUpdate(payload);

					if (succeeded) {
						logger.debug(
							{
								serverId: server.id,
								serverName: server.name,
								updateCount: mappedUpdates.length
							},
							'[MediaBrowserNotifier] Updates sent to server'
						);
					} else {
						logger.warn(
							{
								serverId: server.id,
								serverName: server.name,
								updateCount: mappedUpdates.length
							},
							'[MediaBrowserNotifier] Server rejected the update - see the warning/error logged just above for why'
						);
					}
				} catch (error) {
					logger.error(
						{
							serverId: server.id,
							serverName: server.name,
							error: error instanceof Error ? error.message : String(error)
						},
						'[MediaBrowserNotifier] Failed to send updates to server'
					);
				}
			})
		);
	}

	/**
	 * Get the current queue size (for monitoring)
	 */
	getQueueSize(): number {
		return this.pendingUpdates.size;
	}
}

// Singleton instance
let notifierInstance: MediaBrowserNotifier | null = null;

/**
 * Get the MediaBrowserNotifier singleton
 */
export function getMediaBrowserNotifier(): MediaBrowserNotifier {
	if (!notifierInstance) {
		notifierInstance = new MediaBrowserNotifier();
	}
	return notifierInstance;
}

export { MediaBrowserNotifier };
