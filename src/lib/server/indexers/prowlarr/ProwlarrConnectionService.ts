import { db } from '#lib/server/db/index.js';
import { settings as settingsTable } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { getPersistentStatusTracker } from '#lib/server/indexers/status/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import { decryptSettingValue, encryptSettingValue } from '#lib/server/settings/secretSettings.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });

const SETTINGS_KEY = 'prowlarr_connection';

export interface ProwlarrConnection {
	url: string;
	/** Stored server-side only — never sent to the client */
	apiKey: string;
	autoSync: boolean;
	syncIntervalHours: number;
	/**
	 * When true, sync will also import indexers that exist in Prowlarr but
	 * have not been imported yet. When false (default), sync only touches
	 * indexers the user has already explicitly imported.
	 */
	syncAddNew: boolean;
	/**
	 * When true, a single aggregate indexer is used that searches all Prowlarr
	 * indexers at once instead of managing them individually.
	 */
	useAggregateEndpoint: boolean;
	lastSyncAt: string | null;
	lastSyncResult: SyncResult | null;
	/** Set when a sync attempt fails entirely (e.g. Prowlarr unreachable). Cleared on success. */
	lastSyncError: string | null;
}

export interface SyncResult {
	updated: number;
	removed: number;
	added: number;
	failed: number;
	errors: string[];
}

export interface ProwlarrApiIndexer {
	id: number;
	name: string;
	enable: boolean;
	protocol: string;
	privacy?: string;
}

export interface ProwlarrApiIndexerStatus {
	indexerId: number;
	disabledTill: string | null;
	mostRecentFailure: string | null;
}

export async function getProwlarrConnection(): Promise<ProwlarrConnection | null> {
	const row = await db.query.settings.findFirst({
		where: eq(settingsTable.key, SETTINGS_KEY)
	});
	if (!row) return null;
	try {
		// apiKey is encrypted at rest inside the connection blob.
		const conn = JSON.parse(
			decryptSettingValue(SETTINGS_KEY, row.value) ?? '{}'
		) as ProwlarrConnection;
		if (conn.syncAddNew === undefined) conn.syncAddNew = false;
		if (conn.useAggregateEndpoint === undefined) conn.useAggregateEndpoint = false;
		if (conn.lastSyncError === undefined) conn.lastSyncError = null;
		return conn;
	} catch {
		return null;
	}
}

export async function saveProwlarrConnection(conn: ProwlarrConnection): Promise<void> {
	const value = encryptSettingValue(SETTINGS_KEY, JSON.stringify(conn));
	await db
		.insert(settingsTable)
		.values({ key: SETTINGS_KEY, value })
		.onConflictDoUpdate({ target: settingsTable.key, set: { value } });
}

export async function deleteProwlarrConnection(): Promise<void> {
	await db.delete(settingsTable).where(eq(settingsTable.key, SETTINGS_KEY));
}

export function normalizeProwlarrUrl(url: string): string {
	return url.replace(/\/+$/, '');
}

/**
 * Extract the numeric Prowlarr indexer ID from an indexer record.
 * All managed Prowlarr indexers encode the ID as the last path segment of baseUrl
 * (e.g. http://prowlarr:9696/1). The indexerId in settings is a convenience copy.
 */
export function getProwlarrId(
	indexer: { baseUrl: string; settings?: Record<string, unknown> | null },
	prowlarrBase: string
): number {
	// Prefer settings.indexerId when present (avoids URL parsing)
	const fromSettings = parseInt(String(indexer.settings?.indexerId ?? ''), 10);
	if (!isNaN(fromSettings)) return fromSettings;
	// Fall back to extracting from the baseUrl path segment
	const suffix = indexer.baseUrl.slice(prowlarrBase.length + 1).replace(/\/+$/, '');
	return parseInt(suffix, 10);
}

/** Returns true when the indexer is the single aggregate Prowlarr indexer. */
export function isAggregateIndexer(indexer: {
	definitionId: string;
	settings?: Record<string, unknown> | null;
}): boolean {
	return indexer.definitionId === 'prowlarr' && indexer.settings?.aggregate === true;
}

/**
 * Returns true if the given indexer was imported from this Prowlarr connection —
 * either as a numeric individual indexer or as the aggregate indexer.
 * Requires definitionId='prowlarr' so that torznab/newznab indexers that happen
 * to share the same host are not incorrectly claimed as Prowlarr-managed.
 */
export function isIndexerFromConnection(
	indexer: { definitionId: string; baseUrl: string; settings?: Record<string, unknown> | null },
	prowlarrBase: string
): boolean {
	if (indexer.definitionId !== 'prowlarr') return false;
	// Aggregate indexer is identified by its settings flag, not URL suffix
	if (isAggregateIndexer(indexer)) {
		return indexer.baseUrl === prowlarrBase || indexer.baseUrl.startsWith(prowlarrBase + '/');
	}
	// Individual indexer — baseUrl must end with a numeric Prowlarr ID
	if (!indexer.baseUrl.startsWith(prowlarrBase + '/')) return false;
	const suffix = indexer.baseUrl.slice(prowlarrBase.length + 1).replace(/\/+$/, '');
	return /^\d+$/.test(suffix);
}

export async function fetchProwlarrIndexers(
	prowlarrUrl: string,
	apiKey: string
): Promise<ProwlarrApiIndexer[]> {
	const base = normalizeProwlarrUrl(prowlarrUrl);
	const res = await fetch(`${base}/api/v1/indexer`, {
		headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
		signal: AbortSignal.timeout(10000)
	});

	if (res.status === 401 || res.status === 403) {
		throw new Error('Authentication failed. Check your Prowlarr API key.');
	}
	if (!res.ok) {
		throw new Error(`Prowlarr returned HTTP ${res.status}`);
	}

	const data: unknown = await res.json();
	if (!Array.isArray(data)) {
		throw new Error('Unexpected response format from Prowlarr');
	}
	return data as ProwlarrApiIndexer[];
}

export async function fetchProwlarrIndexerStatus(
	prowlarrUrl: string,
	apiKey: string
): Promise<ProwlarrApiIndexerStatus[]> {
	const base = normalizeProwlarrUrl(prowlarrUrl);
	const res = await fetch(`${base}/api/v1/indexerstatus`, {
		headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
		signal: AbortSignal.timeout(10000)
	});
	if (!res.ok) return [];
	const data: unknown = await res.json();
	if (!Array.isArray(data)) return [];
	return data as ProwlarrApiIndexerStatus[];
}

/**
 * Switch to aggregate mode: remove all individual Prowlarr indexers and
 * create a single aggregate indexer that searches all of them at once.
 */
export async function enableAggregateMode(conn: ProwlarrConnection): Promise<void> {
	const prowlarrBase = normalizeProwlarrUrl(conn.url);
	const manager = await getIndexerManager();
	const existingIndexers = await manager.getIndexers();

	// Delete individual indexers from this connection
	const individual = existingIndexers.filter(
		(i) => isIndexerFromConnection(i, prowlarrBase) && !isAggregateIndexer(i)
	);
	for (const indexer of individual) {
		await manager.deleteIndexer(indexer.id);
	}

	// Create aggregate indexer if not already present
	const alreadyHasAggregate = existingIndexers.some(
		(i) => isIndexerFromConnection(i, prowlarrBase) && isAggregateIndexer(i)
	);
	if (!alreadyHasAggregate) {
		await manager.createIndexer({
			name: 'Prowlarr',
			definitionId: 'prowlarr',
			baseUrl: prowlarrBase,
			alternateUrls: [],
			enabled: true,
			priority: 25,
			settings: { apikey: conn.apiKey, aggregate: true },
			enableAutomaticSearch: true,
			enableInteractiveSearch: true,
			minimumSeeders: 1,
			seedRatio: null,
			seedTime: null,
			packSeedTime: null
		});
	}
}

/**
 * Switch back from aggregate mode: remove the single aggregate indexer so the
 * user can re-import individual indexers via the import modal.
 */
export async function disableAggregateMode(conn: ProwlarrConnection): Promise<void> {
	const prowlarrBase = normalizeProwlarrUrl(conn.url);
	const manager = await getIndexerManager();
	const existingIndexers = await manager.getIndexers();

	const aggregate = existingIndexers.find(
		(i) => isIndexerFromConnection(i, prowlarrBase) && isAggregateIndexer(i)
	);
	if (aggregate) {
		await manager.deleteIndexer(aggregate.id);
	}
}

export async function syncProwlarrIndexers(): Promise<SyncResult> {
	const conn = await getProwlarrConnection();
	if (!conn) {
		throw new Error('No Prowlarr connection configured');
	}

	const prowlarrBase = normalizeProwlarrUrl(conn.url);
	const result: SyncResult = { updated: 0, removed: 0, added: 0, failed: 0, errors: [] };

	let prowlarrIndexers: ProwlarrApiIndexer[];
	try {
		prowlarrIndexers = await fetchProwlarrIndexers(conn.url, conn.apiKey);
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		conn.lastSyncAt = new Date().toISOString();
		conn.lastSyncError = errorMsg;
		await saveProwlarrConnection(conn);
		throw new Error(`Failed to fetch indexers from Prowlarr: ${errorMsg}`, { cause: err });
	}

	const manager = await getIndexerManager();
	const existingIndexers = await manager.getIndexers();

	if (conn.useAggregateEndpoint) {
		// Aggregate mode: just keep the single aggregate indexer's API key up to date.
		const aggIndexer = existingIndexers.find(
			(i) => isIndexerFromConnection(i, prowlarrBase) && isAggregateIndexer(i)
		);
		if (aggIndexer) {
			const existingSettings = aggIndexer.settings as Record<string, unknown> | null;
			if (existingSettings?.apikey !== conn.apiKey) {
				try {
					await manager.updateIndexer(aggIndexer.id, {
						settings: { ...existingSettings, apikey: conn.apiKey }
					});
					result.updated += 1;
				} catch (err) {
					result.failed += 1;
					result.errors.push(
						`Update aggregate: ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}
		}
	} else {
		const prowlarrById = new Map(prowlarrIndexers.map((i) => [i.id, i]));

		// Partition: individual Prowlarr indexers managed by Cinephage
		const managedIndexers = existingIndexers.filter(
			(i) => isIndexerFromConnection(i, prowlarrBase) && !isAggregateIndexer(i)
		);

		for (const indexer of managedIndexers) {
			const prowlarrId = getProwlarrId(indexer, prowlarrBase);
			const pi = prowlarrById.get(prowlarrId);

			if (!pi) {
				// No longer in Prowlarr - soft-mark as orphaned rather than hard-delete.
				try {
					if (!indexer.orphaned) {
						await manager.updateIndexer(indexer.id, { enabled: false, orphaned: true });
						result.removed += 1;
						logger.info(
							{ indexerName: indexer.name, prowlarrId },
							'[Prowlarr] Orphaned indexer no longer in Prowlarr'
						);
					}
				} catch (err) {
					result.failed += 1;
					result.errors.push(
						`Orphan ${indexer.name}: ${err instanceof Error ? err.message : String(err)}`
					);
				}
				continue;
			}

			// Still exists in Prowlarr - sync name, upstream enabled state, and API key.
			const updates: Record<string, unknown> = {};
			if (pi.name !== indexer.name) updates.name = pi.name;
			if (pi.enable !== indexer.upstreamEnabled) updates.upstreamEnabled = pi.enable;
			if (indexer.orphaned) updates.orphaned = false;

			const existingSettings = indexer.settings as Record<string, unknown> | null;
			const currentKey = existingSettings?.apikey;
			const expectedProtocol = pi.protocol === 'usenet' ? 'usenet' : 'torrent';
			const needsSettingsUpdate =
				currentKey !== conn.apiKey || existingSettings?.protocol !== expectedProtocol;
			if (needsSettingsUpdate) {
				updates.settings = {
					...(existingSettings ?? {}),
					apikey: conn.apiKey,
					protocol: expectedProtocol
				};
			}

			if (Object.keys(updates).length > 0) {
				try {
					await manager.updateIndexer(indexer.id, updates);
					result.updated += 1;
					logger.info(
						{ indexerName: pi.name, prowlarrId, updates: Object.keys(updates) },
						'[Prowlarr] Updated indexer'
					);
				} catch (err) {
					result.failed += 1;
					result.errors.push(
						`Update ${indexer.name}: ${err instanceof Error ? err.message : String(err)}`
					);
				}
			}
		}

		// Add new indexers only when the user has opted in
		if (conn.syncAddNew) {
			const managedIds = new Set(managedIndexers.map((i) => getProwlarrId(i, prowlarrBase)));

			for (const pi of prowlarrIndexers) {
				if (managedIds.has(pi.id)) continue;

				try {
					await manager.createIndexer({
						name: pi.name,
						definitionId: 'prowlarr',
						baseUrl: `${prowlarrBase}/${pi.id}`,
						alternateUrls: [],
						enabled: true,
						upstreamEnabled: pi.enable,
						priority: 25,
						settings: {
							apikey: conn.apiKey,
							indexerId: String(pi.id),
							protocol: pi.protocol === 'usenet' ? 'usenet' : 'torrent'
						},
						enableAutomaticSearch: true,
						enableInteractiveSearch: true,
						minimumSeeders: 1,
						seedRatio: null,
						seedTime: null,
						packSeedTime: null
					});
					result.added += 1;
					logger.info(
						{ indexerName: pi.name, prowlarrId: pi.id },
						'[Prowlarr] Auto-imported new indexer'
					);
				} catch (err) {
					result.failed += 1;
					result.errors.push(`Add ${pi.name}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}

		// Health passthrough: update Cinephage status tracker from Prowlarr's indexer health data.
		try {
			const statusTracker = getPersistentStatusTracker();
			const prowlarrStatuses = await fetchProwlarrIndexerStatus(conn.url, conn.apiKey);
			const failedByProwlarrId = new Map(prowlarrStatuses.map((s) => [s.indexerId, s]));

			const currentIndexers = await manager.getIndexers();
			const stillManaged = currentIndexers.filter(
				(i) => isIndexerFromConnection(i, prowlarrBase) && !isAggregateIndexer(i)
			);

			for (const indexer of stillManaged) {
				const prowlarrId = getProwlarrId(indexer, prowlarrBase);
				const failureInfo = failedByProwlarrId.get(prowlarrId);

				if (failureInfo) {
					await statusTracker.recordFailure(
						indexer.id,
						failureInfo.mostRecentFailure ?? 'Reported unhealthy by Prowlarr'
					);
				} else {
					await statusTracker.recordSuccess(indexer.id);
				}
			}
		} catch {
			// Health passthrough is best-effort
		}
	}

	conn.lastSyncAt = new Date().toISOString();
	conn.lastSyncResult = result;
	conn.lastSyncError = null;
	await saveProwlarrConnection(conn);

	logger.info(
		{
			updated: result.updated,
			removed: result.removed,
			added: result.added,
			failed: result.failed
		},
		'[Prowlarr] Sync complete'
	);
	return result;
}

/**
 * Push the current connection API key to every Prowlarr-sourced indexer that
 * still has the old key.  Called immediately when connection settings are saved
 * with a new API key so searches don't 401 until the next scheduled sync.
 */
export async function propagateProwlarrApiKey(newApiKey: string): Promise<void> {
	const conn = await getProwlarrConnection();
	if (!conn) return;

	const prowlarrBase = normalizeProwlarrUrl(conn.url);
	const manager = await getIndexerManager();
	const indexers = await manager.getIndexers();

	for (const indexer of indexers) {
		if (!isIndexerFromConnection(indexer, prowlarrBase)) continue;
		const existing = indexer.settings as Record<string, unknown> | null;
		if ((existing?.apikey ?? '') === newApiKey) continue;
		await manager.updateIndexer(indexer.id, {
			settings: { ...(existing ?? {}), apikey: newApiKey }
		});
	}
}
