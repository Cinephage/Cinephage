import { EventEmitter } from 'node:events';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ServiceStatus, BackgroundService } from '#lib/server/services/background-service.js';
import type { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import { db } from '#lib/server/db/index.js';
import {
	episodeFiles,
	episodes,
	mediaServerSyncedItems,
	movies,
	movieFiles,
	series,
	storageItemServerLinks,
	storageItems
} from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { logicalKey } from './matchers.js';
import type { ReconcileResult } from '../types.js';

/**
 * Limits the reconcile pass to a subset of the library so imports and
 * per-folder scans don't load the entire storage_items table.
 *
 * - folder: only process items whose root_folder_id matches. Triggered by
 *   a single-folder scan completing. Server items are filtered to the
 *   tmdb_ids present in that folder so cross-source coverage still works.
 * - full: no filter, loads and processes everything. Used for scheduled
 *   runs, startup backfill, and post-import triggers.
 */
type ReconcileScope = { type: 'folder'; rootFolderId: string } | { type: 'full' };

const logger = createChildLogger({ logDomain: 'system' as const });

/**
 * Internal shape used during reconciliation to represent a local source row.
 */
type SourceRow = {
	itemType: 'movie' | 'episode';
	tmdbId: number | null;
	title: string;
	year: number | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	movieFileId: string | null;
	episodeFileId: string | null;
	rootFolderId: string | null;
	libraryId: string | null;
	/**
	 * Movie rows only (null for episodes). Used as a fallback match key for
	 * media-server sync rows whose own TMDB resolution failed but which
	 * still carry an IMDB id - see unmatchedServerMoviesByImdbId in
	 * reconcile(). Without this, a movie present on both sides falsely
	 * reports as "missing from your media server" whenever the server's
	 * metadata agent couldn't resolve TMDB for it (GitHub #601).
	 */
	imdbId: string | null;
};

const CHUNK_SIZE = 500;

function yield_(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

class ReconciliationService extends EventEmitter implements BackgroundService {
	readonly name = 'ReconciliationService';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;
	private reconcileLock = false;
	private pendingTrigger = false;
	private pendingScope: ReconcileScope = { type: 'full' };
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private listenersAttached = false;
	private attachPromise: Promise<void> | null = null;
	private attachedScheduler: EventEmitter | null = null;
	private attachedStatsSync: EventEmitter | null = null;
	private attachedLibraryEvents: typeof libraryMediaEvents | null = null;

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	start(): void {
		if (this._status !== 'pending') return;
		this._status = 'starting';
		setImmediate(() => {
			try {
				this.attachListeners();
				this._status = 'ready';
				logger.info('[ReconciliationService] ready; will run on scan/sync events');
				// Trigger an initial reconcile (backfill) shortly after startup,
				// delayed so we don't compete with other services' startup work.
				setTimeout(() => {
					this.reconcile().catch((err) => {
						logger.error('[ReconciliationService] initial reconcile failed', err);
					});
				}, 5000);
			} catch (e) {
				this._error = e instanceof Error ? e : new Error(String(e));
				this._status = 'error';
				logger.error('[ReconciliationService] startup failed', this._error);
			}
		});
	}

	async stop(): Promise<void> {
		if (this.attachPromise) {
			await this.attachPromise;
			this.attachPromise = null;
		}
		this.detachListeners();
		this._status = 'pending';
	}

	private attachListeners(): void {
		if (this.listenersAttached) return;
		this.listenersAttached = true;
		// Lazy-import to avoid circular deps at module load time.
		// Track the combined Promise so stop() can await completion before detaching,
		// preventing orphaned listeners if stop() is called while imports are in-flight.
		this.attachPromise = Promise.all([
			import('#lib/server/library/library-scheduler.js')
				.then(({ getLibraryScheduler }) => {
					const scheduler = getLibraryScheduler();
					scheduler.on('scanComplete', this.handleScanComplete);
					this.attachedScheduler = scheduler;
				})
				.catch((e) => {
					logger.error('[ReconciliationService] failed to subscribe to scanComplete', e);
				}),
			import('#lib/server/mediaServerStats/MediaServerStatsSyncService.js')
				.then(({ getMediaServerStatsSyncService }) => {
					const statsSync = getMediaServerStatsSyncService();
					statsSync.on('syncComplete', this.handleSyncComplete);
					this.attachedStatsSync = statsSync;
				})
				.catch((e) => {
					logger.error('[ReconciliationService] failed to subscribe to syncComplete', e);
				}),
			// Subscribe to library data mutations triggered by downloads/imports (NOT
			// disk scans, those are handled by scanComplete with a proper rootFolderId).
			import('#lib/server/library/LibraryMediaEvents.js')
				.then(({ libraryMediaEvents }) => {
					libraryMediaEvents.onLibraryDataChanged(this.handleLibraryDataChanged);
					this.attachedLibraryEvents = libraryMediaEvents;
				})
				.catch((e) => {
					logger.error('[ReconciliationService] failed to subscribe to library:data-changed', e);
				})
		]).then(() => undefined);
	}

	private detachListeners(): void {
		if (!this.listenersAttached) return;
		this.listenersAttached = false;
		// Use the references captured on attach rather than re-importing: a fresh
		// dynamic import here can fail if the module runner's transport has
		// already been torn down (Vite dev SSR, "transport was disconnected"),
		// or could even resolve to a different post-reload module instance,
		// silently targeting the wrong emitter and leaking the real listener.
		this.attachedScheduler?.off('scanComplete', this.handleScanComplete);
		this.attachedScheduler = null;
		this.attachedStatsSync?.off('syncComplete', this.handleSyncComplete);
		this.attachedStatsSync = null;
		this.attachedLibraryEvents?.offLibraryDataChanged(this.handleLibraryDataChanged);
		this.attachedLibraryEvents = null;
	}

	/**
	 * Triggered when a disk scan finishes. Cancels any in-flight debounce timer
	 * (disk scans emit per-series library:data-changed events that would
	 * otherwise cause a duplicate full reconcile 1500ms later) and immediately
	 * starts a scoped reconcile for just the affected root folder.
	 */
	private handleScanComplete = (event: { type: string; rootFolderId?: string }): void => {
		// Cancel any debounce queued by the per-series/movie library:data-changed
		// events that fire during the scan; this scanComplete covers the same data.
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		const scope: ReconcileScope = event.rootFolderId
			? { type: 'folder', rootFolderId: event.rootFolderId }
			: { type: 'full' };
		this.triggerReconcile(scope);
	};

	/**
	 * Triggered when a media-server sync finishes. Debounced in case multiple
	 * servers finish within the same window. Always runs a full reconcile
	 * since server coverage can span all root folders.
	 */
	private handleSyncComplete = (): void => {
		this.scheduleDebounced({ type: 'full' });
	};

	/**
	 * Triggered by download imports, blocklist changes, and other non-scan
	 * mutations. Debounced so a burst of imports coalesces into one run.
	 * Disk-scan events (source 'movie'/'series' with reason 'movie-updated'/
	 * 'series-updated') are intentionally NOT filtered here; the debounce
	 * cancel in handleScanComplete already suppresses the duplicate.
	 */
	private handleLibraryDataChanged = (): void => {
		this.scheduleDebounced({ type: 'full' });
	};

	/** Immediately trigger a reconcile, or mark it pending if one is running. */
	private triggerReconcile(scope: ReconcileScope): void {
		if (this.reconcileLock) {
			this.pendingTrigger = true;
			// Widen the pending scope: a full run covers any narrower scope.
			if (scope.type === 'full' || this.pendingScope.type === 'full') {
				this.pendingScope = { type: 'full' };
			}
			// Both are folder scopes: keep whichever arrived first; the follow-up
			// run after the current one will use pendingScope.
			return;
		}
		this.reconcile(scope).catch((err) => {
			logger.error('[ReconciliationService] reconcile failed after trigger', err);
		});
	}

	/** Debounce a reconcile trigger, coalescing bursts into one run. */
	private scheduleDebounced(scope: ReconcileScope): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.triggerReconcile(scope);
		}, 1500);
	}

	/**
	 * Run a reconciliation pass, optionally scoped to a single root folder.
	 *
	 * The reconcile loop runs in chunks of 500 items, yielding the event loop
	 * between chunks via setImmediate. This keeps import processing and HTTP
	 * requests responsive even on libraries with tens of thousands of items.
	 * If a new trigger arrives while a reconcile is in-flight, pendingTrigger
	 * is set and a follow-up run starts immediately after the current one
	 * finishes, ensuring no library mutations are silently dropped.
	 *
	 * @param scope - Optional scope to limit the reconcile to a root folder.
	 *   When omitted a full library reconcile runs (startup, scheduled task).
	 */
	async reconcile(scope: ReconcileScope = { type: 'full' }): Promise<ReconcileResult> {
		const start = Date.now();
		if (this.reconcileLock) {
			this.pendingTrigger = true;
			logger.debug('[ReconciliationService] reconcile already in progress; deferring');
			return {
				itemsUpserted: 0,
				itemsInserted: 0,
				itemsUpdated: 0,
				itemsDeleted: 0,
				linksUpserted: 0,
				errorCount: 0,
				durationMs: 0,
				skipped: true
			};
		}
		this.reconcileLock = true;
		this.pendingTrigger = false;
		this.pendingScope = { type: 'full' };
		try {
			// For a folder-scoped run we load local rows first, then derive
			// the tmdbIds needed to filter server items and existing DB rows.
			// For a full run everything loads in parallel (no dependency).
			const existingItemsSelect = {
				id: storageItems.id,
				itemType: storageItems.itemType,
				tmdbId: storageItems.tmdbId,
				seasonNumber: storageItems.seasonNumber,
				episodeNumber: storageItems.episodeNumber,
				// Change-detection fields: used to skip no-op UPDATEs
				title: storageItems.title,
				year: storageItems.year,
				seriesName: storageItems.seriesName,
				tvdbId: storageItems.tvdbId,
				imdbId: storageItems.imdbId,
				movieFileId: storageItems.movieFileId,
				episodeFileId: storageItems.episodeFileId,
				rootFolderId: storageItems.rootFolderId,
				libraryId: storageItems.libraryId,
				sourceSystem: storageItems.sourceSystem,
				matchConfidence: storageItems.matchConfidence
			};

			let localRows: SourceRow[];
			let serverItemRows: Array<typeof mediaServerSyncedItems.$inferSelect>;
			let unmatchedServerMovieRows: Array<typeof mediaServerSyncedItems.$inferSelect>;
			let existingItems: Array<{
				id: string;
				itemType: string;
				tmdbId: number | null;
				seasonNumber: number | null;
				episodeNumber: number | null;
				title: string;
				year: number | null;
				seriesName: string | null;
				tvdbId: number | null;
				imdbId: string | null;
				movieFileId: string | null;
				episodeFileId: string | null;
				rootFolderId: string | null;
				libraryId: string | null;
				sourceSystem: string;
				matchConfidence: string;
			}>;
			let existingLinks: Array<{
				storageItemId: string;
				serverId: string;
				syncedItemId: string;
			}>;

			if (scope.type === 'folder') {
				// Phase 1: local rows for this folder only.
				localRows = await this.loadLocalRows(scope.rootFolderId);

				// Phase 2: server items filtered to the tmdbIds present in this
				// folder; storage_items and links filtered to the same folder.
				const folderTmdbIds = [
					...new Set(localRows.map((r) => r.tmdbId).filter((id): id is number => id !== null))
				];
				const folderLinkSubquery = db
					.select({ id: storageItems.id })
					.from(storageItems)
					.where(eq(storageItems.rootFolderId, scope.rootFolderId));
				[serverItemRows, unmatchedServerMovieRows, existingItems, existingLinks] =
					await Promise.all([
						this.loadServerItemsForTmdbIds(folderTmdbIds),
						this.loadUnmatchedServerMovieItems(),
						db
							.select(existingItemsSelect)
							.from(storageItems)
							.where(eq(storageItems.rootFolderId, scope.rootFolderId)),
						db
							.select({
								storageItemId: storageItemServerLinks.storageItemId,
								serverId: storageItemServerLinks.serverId,
								syncedItemId: storageItemServerLinks.syncedItemId
							})
							.from(storageItemServerLinks)
							.where(inArray(storageItemServerLinks.storageItemId, folderLinkSubquery))
					]);
			} else {
				// Full run: load everything in parallel.
				[localRows, serverItemRows, unmatchedServerMovieRows, existingItems, existingLinks] =
					await Promise.all([
						this.loadLocalRows(),
						this.loadServerItems(),
						this.loadUnmatchedServerMovieItems(),
						db.select(existingItemsSelect).from(storageItems),
						db
							.select({
								storageItemId: storageItemServerLinks.storageItemId,
								serverId: storageItemServerLinks.serverId,
								syncedItemId: storageItemServerLinks.syncedItemId
							})
							.from(storageItemServerLinks)
					]);
			}

			// ---- Build all read-only maps before touching the DB ----

			const desired = new Map<string, SourceRow>();
			for (const row of localRows) {
				if (row.tmdbId === null) continue;
				const key = logicalKey(row.itemType, row.tmdbId, row.seasonNumber, row.episodeNumber);
				if (!desired.has(key)) desired.set(key, row); // first row wins (matches existing dedup)
			}

			const serverByKey = new Map<string, Array<typeof mediaServerSyncedItems.$inferSelect>>();
			for (const s of serverItemRows) {
				const key = logicalKey(
					s.itemType as 'movie' | 'episode',
					s.tmdbId,
					s.seasonNumber,
					s.episodeNumber
				);
				if (!serverByKey.has(key)) serverByKey.set(key, []);
				serverByKey.get(key)!.push(s);
			}

			// File-granularity server coverage: media servers report one item
			// per physical file, so a combined file (e.g. S02E12-E13) appears
			// under a single episode number. Without this, every episode after
			// the first in the range would have no 1:1 server counterpart and
			// be flagged as "missing from your media server". A server episode
			// item (series tmdbId + season + episode number) covers a local file
			// whose episodeIds include that number.
			const filesByTmdbSeason = new Map<
				string,
				Array<{ fileId: string; episodeNumbers: Set<number> }>
			>();
			for (const row of localRows) {
				if (
					row.itemType !== 'episode' ||
					!row.episodeFileId ||
					row.tmdbId === null ||
					row.seasonNumber === null ||
					row.episodeNumber === null
				) {
					continue;
				}
				const seasonKey = `${row.tmdbId}:${row.seasonNumber}`;
				let files = filesByTmdbSeason.get(seasonKey);
				if (!files) {
					files = [];
					filesByTmdbSeason.set(seasonKey, files);
				}
				let fileEntry = files.find((f) => f.fileId === row.episodeFileId);
				if (!fileEntry) {
					fileEntry = { fileId: row.episodeFileId, episodeNumbers: new Set() };
					files.push(fileEntry);
				}
				fileEntry.episodeNumbers.add(row.episodeNumber);
			}
			const serverItemsByFile = new Map<
				string,
				Array<typeof mediaServerSyncedItems.$inferSelect>
			>();
			for (const s of serverItemRows) {
				if (
					s.itemType !== 'episode' ||
					s.tmdbId === null ||
					s.seasonNumber === null ||
					s.episodeNumber === null
				) {
					continue;
				}
				const files = filesByTmdbSeason.get(`${s.tmdbId}:${s.seasonNumber}`);
				if (!files) {
					continue;
				}
				for (const file of files) {
					if (!file.episodeNumbers.has(s.episodeNumber)) {
						continue;
					}
					const arr = serverItemsByFile.get(file.fileId);
					if (arr) {
						arr.push(s);
					} else {
						serverItemsByFile.set(file.fileId, [s]);
					}
				}
			}

			// Fallback coverage for movies whose server-side TMDB resolution
			// failed: match by IMDB id instead so a movie present on both
			// sides doesn't falsely report as "missing from your media
			// server" just because the server's metadata agent couldn't
			// resolve TMDB for it (#601). Keyed by lowercased IMDB id.
			const unmatchedServerMoviesByImdbId = new Map<
				string,
				Array<typeof mediaServerSyncedItems.$inferSelect>
			>();
			for (const s of unmatchedServerMovieRows) {
				if (!s.imdbId) continue;
				const key = s.imdbId.toLowerCase();
				const arr = unmatchedServerMoviesByImdbId.get(key);
				if (arr) {
					arr.push(s);
				} else {
					unmatchedServerMoviesByImdbId.set(key, [s]);
				}
			}

			// Existing rows indexed by logical key (full row for change-detection)
			const existingByKey = new Map<string, (typeof existingItems)[number]>();
			for (const item of existingItems) {
				const key = logicalKey(
					item.itemType as 'movie' | 'episode',
					item.tmdbId,
					item.seasonNumber,
					item.episodeNumber
				);
				existingByKey.set(key, item);
			}
			// Map from "storageItemId:serverId" -> current syncedItemId, used to skip
			// no-op server-link updates when only lastSeenAt would change.
			const existingLinkMap = new Map(
				existingLinks.map((l) => [`${l.storageItemId}:${l.serverId}`, l.syncedItemId])
			);

			const keepItemIds = new Set<string>();
			let itemsInserted = 0;
			let itemsUpdated = 0;
			let linksUpserted = 0;
			let errorCount = 0;
			const now = new Date().toISOString();

			const allKeys = [...new Set<string>([...desired.keys(), ...serverByKey.keys()])];

			// Process in chunks, yielding between each to keep the event loop
			// responsive during large library reconciles.
			for (let chunkStart = 0; chunkStart < allKeys.length; chunkStart += CHUNK_SIZE) {
				const chunk = allKeys.slice(chunkStart, chunkStart + CHUNK_SIZE);
				db.transaction((tx) => {
					for (const key of chunk) {
						try {
							const localRow = desired.get(key) ?? null;
							let serverItems = serverByKey.get(key) ?? [];
							// Fall back to file-granularity coverage for episodes of a
							// multi-episode file: the file exists on the server under a
							// sibling episode number, so this episode is satisfied too.
							if (serverItems.length === 0 && localRow?.episodeFileId) {
								serverItems = serverItemsByFile.get(localRow.episodeFileId) ?? [];
							}
							// Fall back to IMDB-id matching for movies whose server
							// counterpart has no TMDB id (see unmatchedServerMoviesByImdbId).
							if (serverItems.length === 0 && localRow?.itemType === 'movie' && localRow.imdbId) {
								serverItems =
									unmatchedServerMoviesByImdbId.get(localRow.imdbId.toLowerCase()) ?? [];
							}
							const existing = existingByKey.get(key);

							// Preserve any pre-existing row even if this iteration later
							// throws, so a transient update failure doesn't cause a
							// stale-cleanup deletion.
							if (existing) keepItemIds.add(existing.id);

							const hasLocal = localRow !== null;
							const hasServer = serverItems.length > 0;
							const sourceSystem = hasLocal && hasServer ? 'both' : hasLocal ? 'local' : 'server';
							const matchConfidence = hasLocal ? 'exact' : 'id';

							const title = localRow?.title ?? serverItems[0]?.title ?? 'Unknown';
							const year = localRow?.year ?? serverItems[0]?.year ?? null;
							const seriesName = serverItems[0]?.seriesName ?? null;
							const itemType = (localRow?.itemType ?? serverItems[0]?.itemType ?? 'movie') as
								'movie' | 'episode' | 'series' | 'season';
							const tmdbId = localRow?.tmdbId ?? serverItems[0]?.tmdbId ?? null;
							const tvdbId = serverItems[0]?.tvdbId ?? null;
							const imdbId = serverItems[0]?.imdbId ?? null;
							// Movies must never carry season/episode values: the unique index and
							// logicalKey match movies on tmdbId alone, and stray server-side
							// metadata (e.g. Jellyfin reporting IndexNumber=1 on a movie) would
							// otherwise create a second storage_items row for the same film.
							const isMovie = itemType === 'movie';
							const seasonNumber = isMovie
								? null
								: (localRow?.seasonNumber ?? serverItems[0]?.seasonNumber ?? null);
							const episodeNumber = isMovie
								? null
								: (localRow?.episodeNumber ?? serverItems[0]?.episodeNumber ?? null);

							const newMovieFileId = localRow?.movieFileId ?? null;
							const newEpisodeFileId = localRow?.episodeFileId ?? null;
							const newRootFolderId = localRow?.rootFolderId ?? null;
							const newLibraryId = localRow?.libraryId ?? null;

							let itemId: string;
							if (existing) {
								itemId = existing.id;
								keepItemIds.add(itemId);

								// Skip the UPDATE when nothing material changed.
								// Writing every row on every reconcile even
								// when nothing in the library has changed causes massive unnecessary I/O.
								const changed =
									existing.title !== title ||
									existing.year !== year ||
									existing.seriesName !== seriesName ||
									existing.tvdbId !== tvdbId ||
									existing.imdbId !== imdbId ||
									existing.movieFileId !== newMovieFileId ||
									existing.episodeFileId !== newEpisodeFileId ||
									existing.rootFolderId !== newRootFolderId ||
									existing.libraryId !== newLibraryId ||
									existing.sourceSystem !== sourceSystem ||
									existing.matchConfidence !== matchConfidence;

								if (changed) {
									tx.update(storageItems)
										.set({
											title,
											year,
											seriesName,
											itemType,
											tmdbId,
											tvdbId,
											imdbId,
											seasonNumber,
											episodeNumber,
											movieFileId: newMovieFileId,
											episodeFileId: newEpisodeFileId,
											rootFolderId: newRootFolderId,
											libraryId: newLibraryId,
											sourceSystem,
											matchConfidence,
											lastReconciledAt: now
										})
										.where(eq(storageItems.id, existing.id))
										.run();
									itemsUpdated++;
								}
							} else {
								const [inserted] = tx
									.insert(storageItems)
									.values({
										itemType,
										tmdbId,
										tvdbId,
										imdbId,
										title,
										year,
										seriesName,
										seasonNumber,
										episodeNumber,
										movieFileId: newMovieFileId,
										episodeFileId: newEpisodeFileId,
										rootFolderId: newRootFolderId,
										libraryId: newLibraryId,
										sourceSystem,
										matchConfidence,
										firstSeenAt: now,
										lastReconciledAt: now
									})
									.returning({ id: storageItems.id })
									.all();
								itemId = inserted.id;
								keepItemIds.add(itemId);
								itemsInserted++;
							}

							// Upsert server links: skip the UPDATE when syncedItemId
							// hasn't changed (lastSeenAt alone isn't worth a write).
							for (const s of serverItems) {
								const linkKey = `${itemId}:${s.serverId}`;
								const existingSyncedId = existingLinkMap.get(linkKey);
								if (existingSyncedId === undefined) {
									tx.insert(storageItemServerLinks)
										.values({
											storageItemId: itemId,
											serverId: s.serverId,
											syncedItemId: s.id,
											lastSeenAt: now
										})
										.onConflictDoNothing()
										.run();
									linksUpserted++;
								} else if (existingSyncedId !== s.id) {
									tx.update(storageItemServerLinks)
										.set({ lastSeenAt: now, syncedItemId: s.id })
										.where(
											and(
												eq(storageItemServerLinks.storageItemId, itemId),
												eq(storageItemServerLinks.serverId, s.serverId)
											)
										)
										.run();
									linksUpserted++;
								}
								// else: link exists with same syncedItemId, no write needed
							}
						} catch (itemError) {
							// Isolate per-item failures so one bad row can't abort the
							// whole run (and re-abort on every subsequent run).
							errorCount++;
							logger.warn(`[ReconciliationService] failed to reconcile key ${key}`, {
								error: itemError instanceof Error ? itemError : new Error(String(itemError))
							});
						}
					}
				});
				if (chunkStart + CHUNK_SIZE < allKeys.length) {
					await yield_();
				}
			}

			// Stale cleanup: remove rows no longer present in any source.
			// For a folder-scoped run, only delete rows belonging to that folder
			// (existingItems is already filtered to the folder).
			// Chunked to stay within SQLite's ~999 host-parameter limit.
			let itemsDeleted = 0;
			const staleIds = existingItems.filter((i) => !keepItemIds.has(i.id)).map((i) => i.id);
			for (let i = 0; i < staleIds.length; i += CHUNK_SIZE) {
				const batch = staleIds.slice(i, i + CHUNK_SIZE);
				db.transaction((tx) => {
					tx.delete(storageItems).where(inArray(storageItems.id, batch)).run();
				});
				itemsDeleted += batch.length;
				if (i + CHUNK_SIZE < staleIds.length) {
					await yield_();
				}
			}

			const result: ReconcileResult = {
				itemsUpserted: itemsInserted + itemsUpdated,
				itemsInserted,
				itemsUpdated,
				itemsDeleted,
				linksUpserted,
				errorCount,
				durationMs: Date.now() - start,
				skipped: false as const
			};

			logger.info(
				`[ReconciliationService] reconcile complete: ${result.itemsInserted} new, ${result.itemsUpdated} updated, ${result.itemsDeleted} removed, ${result.linksUpserted} links, ${result.errorCount} errors in ${result.durationMs}ms`
			);
			this.emit('reconcileComplete', result);
			return result;
		} catch (e) {
			this._error = e instanceof Error ? e : new Error(String(e));
			logger.error('[ReconciliationService] reconcile threw', this._error);
			throw e;
		} finally {
			this.reconcileLock = false;
			// A trigger that arrived while we were running sets pendingTrigger.
			// Use the accumulated pendingScope so a full-scope trigger isn't
			// narrowed to a folder scope that arrived first.
			if (this.pendingTrigger) {
				const followUpScope = this.pendingScope;
				this.pendingTrigger = false;
				this.pendingScope = { type: 'full' };
				setImmediate(() => {
					this.reconcile(followUpScope).catch((err) => {
						logger.error('[ReconciliationService] reconcile failed on deferred trigger', err);
					});
				});
			}
		}
	}

	private async loadLocalRows(rootFolderId?: string): Promise<SourceRow[]> {
		const [movieFileRows, episodeFileRows] = await Promise.all([
			db
				.select({
					movieId: movies.id,
					movieFileId: movieFiles.id,
					tmdbId: movies.tmdbId,
					imdbId: movies.imdbId,
					title: movies.title,
					year: movies.year,
					libraryId: movies.libraryId,
					rootFolderId: movies.rootFolderId
				})
				.from(movies)
				.leftJoin(movieFiles, eq(movieFiles.movieId, movies.id))
				.where(rootFolderId ? eq(movies.rootFolderId, rootFolderId) : undefined),
			db
				.select({
					seriesId: series.id,
					episodeFileId: episodeFiles.id,
					tmdbId: series.tmdbId,
					title: series.title,
					year: series.year,
					libraryId: series.libraryId,
					rootFolderId: series.rootFolderId,
					seasonNumber: episodeFiles.seasonNumber,
					episodeIds: episodeFiles.episodeIds
				})
				.from(series)
				.innerJoin(episodeFiles, eq(episodeFiles.seriesId, series.id))
				.where(rootFolderId ? eq(series.rootFolderId, rootFolderId) : undefined)
		]);

		// Collect only the episode IDs referenced by episode files — avoids
		// loading the entire episodes table for large libraries.
		const referencedEpisodeIds = new Set<string>();
		for (const r of episodeFileRows) {
			for (const id of r.episodeIds ?? []) {
				referencedEpisodeIds.add(id);
			}
		}

		// Load referenced episodes in chunks to stay within SQLite's variable limit.
		const episodeRows: Array<{
			id: string;
			episodeNumber: number;
			seasonNumber: number;
			seriesId: string;
		}> = [];
		if (referencedEpisodeIds.size > 0) {
			const ids = [...referencedEpisodeIds];
			for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
				const batch = ids.slice(i, i + CHUNK_SIZE);
				const rows = await db
					.select({
						id: episodes.id,
						episodeNumber: episodes.episodeNumber,
						seasonNumber: episodes.seasonNumber,
						seriesId: episodes.seriesId
					})
					.from(episodes)
					.where(inArray(episodes.id, batch));
				episodeRows.push(...rows);
			}
		}

		// Map<episodeId, { episodeNumber, seasonNumber }> for per-episode expansion.
		// An episode file can cover multiple episodes (e.g. double episodes); we emit
		// one SourceRow per covered episode so each gets its own storage_items row
		// instead of collapsing to a single row via the COALESCE(-1) unique index.
		const episodeById = new Map<string, { episodeNumber: number; seasonNumber: number }>();
		for (const e of episodeRows) {
			episodeById.set(e.id, { episodeNumber: e.episodeNumber, seasonNumber: e.seasonNumber });
		}

		const movieRows: SourceRow[] = movieFileRows
			.filter((r) => r.tmdbId !== null && r.movieFileId !== null)
			.map((r) => ({
				itemType: 'movie' as const,
				tmdbId: r.tmdbId,
				imdbId: r.imdbId ?? null,
				title: r.title,
				year: r.year ?? null,
				seasonNumber: null,
				episodeNumber: null,
				movieFileId: r.movieFileId,
				episodeFileId: null,
				rootFolderId: r.rootFolderId ?? null,
				libraryId: r.libraryId ?? null
			}));

		const epRows: SourceRow[] = [];
		for (const r of episodeFileRows) {
			if (r.tmdbId === null) continue;
			const ids = r.episodeIds ?? [];
			const resolved = ids
				.map((id) => episodeById.get(id))
				.filter((e): e is { episodeNumber: number; seasonNumber: number } => e !== undefined);

			if (resolved.length > 0) {
				for (const ep of resolved) {
					epRows.push({
						itemType: 'episode' as const,
						tmdbId: r.tmdbId,
						imdbId: null,
						title: r.title,
						year: r.year ?? null,
						seasonNumber: ep.seasonNumber,
						episodeNumber: ep.episodeNumber,
						movieFileId: null,
						episodeFileId: r.episodeFileId,
						rootFolderId: r.rootFolderId ?? null,
						libraryId: r.libraryId ?? null
					});
				}
			} else {
				// No episode linkage resolved (empty/null episodeIds, or IDs missing
				// from the episodes table): fall back to file-granularity, preserving
				// backwards compatibility.
				if (ids.length > 0) {
					// episodeIds reference UUIDs that no longer exist in the episodes
					// table (e.g. after a re-scan regenerated episode IDs). This is a
					// data-integrity problem worth surfacing: the file collapses onto a
					// null-episode row and won't match numbered server episodes.
					logger.warn(
						`[ReconciliationService] episode file ${r.episodeFileId} for "${r.title}" S${r.seasonNumber} has ${ids.length} episode_ids but none resolve to the episodes table; falling back to file-granularity`,
						{ episodeFileId: r.episodeFileId, seriesId: r.seriesId, unresolvedIds: ids }
					);
				}
				epRows.push({
					itemType: 'episode' as const,
					tmdbId: r.tmdbId,
					imdbId: null,
					title: r.title,
					year: r.year ?? null,
					seasonNumber: r.seasonNumber,
					episodeNumber: null,
					movieFileId: null,
					episodeFileId: r.episodeFileId,
					rootFolderId: r.rootFolderId ?? null,
					libraryId: r.libraryId ?? null
				});
			}
		}

		return [...movieRows, ...epRows];
	}

	private async loadServerItems(): Promise<Array<typeof mediaServerSyncedItems.$inferSelect>> {
		return db
			.select()
			.from(mediaServerSyncedItems)
			.where(sql`${mediaServerSyncedItems.tmdbId} IS NOT NULL`);
	}

	/**
	 * Movie rows that the media server synced but whose TMDB resolution
	 * failed (so they're excluded from loadServerItems's primary key-based
	 * matching). These still carry an IMDB id in many cases, which lets us
	 * avoid falsely reporting a movie as "missing from your media server"
	 * when it's genuinely present there under unresolved metadata (#601).
	 */
	private async loadUnmatchedServerMovieItems(): Promise<
		Array<typeof mediaServerSyncedItems.$inferSelect>
	> {
		return db
			.select()
			.from(mediaServerSyncedItems)
			.where(
				sql`${mediaServerSyncedItems.itemType} = 'movie' AND ${mediaServerSyncedItems.tmdbId} IS NULL AND ${mediaServerSyncedItems.imdbId} IS NOT NULL`
			);
	}

	private async loadServerItemsForTmdbIds(
		tmdbIds: number[]
	): Promise<Array<typeof mediaServerSyncedItems.$inferSelect>> {
		if (tmdbIds.length === 0) return [];
		const results: Array<typeof mediaServerSyncedItems.$inferSelect> = [];
		for (let i = 0; i < tmdbIds.length; i += CHUNK_SIZE) {
			const batch = tmdbIds.slice(i, i + CHUNK_SIZE);
			const rows = await db
				.select()
				.from(mediaServerSyncedItems)
				.where(inArray(mediaServerSyncedItems.tmdbId, batch));
			results.push(...rows);
		}
		return results;
	}
}

let instance: ReconciliationService | null = null;

export function getReconciliationService(): ReconciliationService {
	if (!instance) instance = new ReconciliationService();
	return instance;
}

/** Test-only: reset the singleton between tests. */
export function __resetReconciliationServiceForTests(): void {
	instance = null;
}
