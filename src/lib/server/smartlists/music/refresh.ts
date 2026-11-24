import { and, asc, count, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import {
	albums,
	artists,
	smartListItems,
	smartListRefreshHistory,
	smartLists,
	type SmartListRecord
} from '#lib/server/db/schema.js';
import { deezer } from '#lib/server/catalog/deezerApi.js';
import { createChildLogger } from '#lib/logging/index.js';
import { fillMissingAlbums } from '#lib/server/music/playlists/albums.js';
import { resolvePlaylistTracks } from '#lib/server/music/playlists/resolve.js';
import { resolveSource } from '#lib/server/music/playlists/sources/index.js';
import { musicBrainz } from '#lib/server/music/musicbrainz.js';
import type { RefreshResult } from '../types.js';
import { addMusicItem } from './add.js';
import {
	musicListConfig,
	musicListConfigError,
	type MusicListCandidate,
	type MusicListConfig
} from './types.js';
import { releaseGroupCoverUrl } from '#lib/music/cover-art.js';

const logger = createChildLogger({
	module: 'MusicSmartListRefresh',
	logDomain: 'monitoring' as const
});

/** Albums per refresh is bounded; a list is a shelf, not the whole catalogue. */
const MAX_ALBUMS = 200;
/** Auto-add stays gentle per refresh, the same ceiling the video lists use. */
const MAX_AUTO_ADD = 10;

/**
 * One refresh per list at a time. The create flow starts a background refresh
 * and the detail page offers Refresh now; without this, the second run races
 * the first on the same rows and loses on the per-list unique index.
 */
const inFlight = new Set<string>();

async function resolvePlaylistCandidates(
	config: MusicListConfig
): Promise<{ candidates: MusicListCandidate[]; failed: number }> {
	if (!config.url) throw new Error('A playlist list needs a playlist URL');
	const { source, url } = resolveSource(config.url);
	const page = await source.fetchPlaylist(url, { limit: config.trackLimit });
	// Same discovery the paste path does: a list of songs becomes a list of
	// albums before MusicBrainz is asked anything, so a refresh costs one
	// request per album instead of one per track.
	const enriched = await fillMissingAlbums(page.tracks, deezer);
	const { candidates, unmatched } = await resolvePlaylistTracks(enriched.tracks);
	return {
		failed: unmatched.length,
		candidates: candidates.map((candidate) => ({
			mbid: candidate.releaseGroupMbid,
			title: candidate.title,
			artistName: candidate.artistName,
			artistMbid: candidate.artistMbid || null,
			year: candidate.year,
			primaryType: candidate.primaryType,
			trackCount: null,
			coverUrl: releaseGroupCoverUrl(candidate.releaseGroupMbid)
		}))
	};
}

/**
 * New releases by the artists already monitored. One MusicBrainz browse page
 * per artist (100 groups), then the date/type window is applied locally; the
 * client's rate gate serialises the requests.
 */
async function resolveNewReleaseCandidates(config: MusicListConfig): Promise<MusicListCandidate[]> {
	const since = new Date(Date.now() - config.lookbackDays * 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10);

	const monitored = await db
		.select({ id: artists.id, name: artists.name, mbid: artists.mbid })
		.from(artists)
		.where(and(eq(artists.monitored, true), isNotNull(artists.mbid)))
		// A random sample, so a large watched list rotates across refreshes
		// instead of starving the artists after the first N alphabetically.
		.orderBy(sql`RANDOM()`)
		.limit(config.artistLimit)
		.all();

	const found = new Map<string, { candidate: MusicListCandidate; date: string }>();
	for (const artist of monitored) {
		if (!artist.mbid) continue;
		try {
			const { releaseGroups } = await musicBrainz.getArtistReleaseGroups(
				artist.mbid,
				{ mbid: artist.mbid, name: artist.name },
				{ limit: 100 }
			);
			for (const group of releaseGroups) {
				if (!group.firstReleaseDate || group.firstReleaseDate < since) continue;
				if (!config.releaseTypes.includes(group.primaryType ?? 'Album')) continue;
				if (found.has(group.mbid)) continue;
				found.set(group.mbid, {
					date: group.firstReleaseDate,
					candidate: {
						mbid: group.mbid,
						title: group.title,
						artistName: group.artist.name,
						artistMbid: group.artist.mbid || null,
						year: group.year ?? null,
						primaryType: group.primaryType ?? null,
						trackCount: null,
						coverUrl: releaseGroupCoverUrl(group.mbid)
					}
				});
			}
		} catch (error) {
			logger.warn(
				{ listId: 'new-releases', artist: artist.name, err: String(error) },
				'[MusicSmartList] artist browse failed'
			);
		}
	}

	return [...found.values()]
		.sort((a, b) => b.date.localeCompare(a.date))
		.map((entry) => entry.candidate);
}

/** Upsert candidates by release-group id; source items that vanished go to 9999. */
async function upsertCandidates(
	list: SmartListRecord,
	candidates: MusicListCandidate[]
): Promise<{ itemsNew: number; itemsRemoved: number }> {
	const now = new Date().toISOString();
	const existing = await db
		.select()
		.from(smartListItems)
		.where(eq(smartListItems.smartListId, list.id))
		.all();
	const byMbid = new Map(
		existing.filter((item) => item.mbid).map((item) => [item.mbid as string, item])
	);

	const albumRows =
		candidates.length > 0
			? await db
					.select({ id: albums.id, mbid: albums.mbid })
					.from(albums)
					.where(
						inArray(
							albums.mbid,
							candidates.map((candidate) => candidate.mbid)
						)
					)
					.all()
			: [];
	const albumByMbid = new Map(
		albumRows.filter((row) => row.mbid).map((row) => [row.mbid as string, row.id])
	);

	let itemsNew = 0;
	const seen = new Set<string>();

	for (const [index, candidate] of candidates.entries()) {
		seen.add(candidate.mbid);
		const albumId = albumByMbid.get(candidate.mbid) ?? null;
		const row = byMbid.get(candidate.mbid);

		if (row) {
			await db
				.update(smartListItems)
				.set({
					position: index,
					title: candidate.title,
					artistName: candidate.artistName,
					artistMbid: candidate.artistMbid,
					year: candidate.year,
					primaryType: candidate.primaryType,
					coverUrl: candidate.coverUrl,
					trackCount: candidate.trackCount,
					albumId,
					inLibrary: Boolean(albumId),
					lastSeenAt: now,
					updatedAt: now
				})
				.where(eq(smartListItems.id, row.id))
				.run();
			continue;
		}

		itemsNew += 1;
		await db
			.insert(smartListItems)
			.values({
				smartListId: list.id,
				mediaType: 'music',
				tmdbId: null,
				mbid: candidate.mbid,
				artistName: candidate.artistName,
				artistMbid: candidate.artistMbid,
				title: candidate.title,
				year: candidate.year,
				primaryType: candidate.primaryType,
				coverUrl: candidate.coverUrl,
				trackCount: candidate.trackCount,
				albumId,
				inLibrary: Boolean(albumId),
				position: index,
				firstSeenAt: now,
				lastSeenAt: now,
				updatedAt: now
			})
			.run();
	}

	let itemsRemoved = 0;
	for (const row of existing) {
		if (row.mbid && !seen.has(row.mbid) && row.position !== 9999) {
			itemsRemoved += 1;
			await db
				.update(smartListItems)
				.set({ position: 9999, updatedAt: now })
				.where(eq(smartListItems.id, row.id))
				.run();
		}
	}

	return { itemsNew, itemsRemoved };
}

async function autoAddItems(list: SmartListRecord): Promise<number> {
	if (list.autoAddBehavior === 'disabled' || !list.rootFolderId) return 0;

	const eligible = await db
		.select()
		.from(smartListItems)
		.where(
			and(
				eq(smartListItems.smartListId, list.id),
				eq(smartListItems.inLibrary, false),
				eq(smartListItems.isExcluded, false),
				lt(smartListItems.position, 9999)
			)
		)
		.orderBy(asc(smartListItems.position))
		.limit(MAX_AUTO_ADD)
		.all();

	let added = 0;
	for (const item of eligible) {
		const result = await addMusicItem(list, item, {
			auto: true,
			search: list.autoAddBehavior === 'add_and_search' && (list.autoAddMonitored ?? true)
		});
		if (result.success) added += 1;
	}
	return added;
}

/**
 * Refresh one music list. The list-level controls are the same as video; the
 * source is a playlist or the monitored artists' new releases, and every item
 * is an album (MusicBrainz release group).
 */
async function runMusicListRefresh(
	list: SmartListRecord,
	refreshType: 'automatic' | 'manual'
): Promise<RefreshResult> {
	const startTime = Date.now();
	const [historyEntry] = await db
		.insert(smartListRefreshHistory)
		.values({
			smartListId: list.id,
			refreshType,
			status: 'running',
			startedAt: new Date().toISOString()
		})
		.returning();

	try {
		const configError = musicListConfigError(list);
		if (configError) throw new Error(configError);

		const config = musicListConfig(list);
		const resolved =
			config.source === 'playlist'
				? await resolvePlaylistCandidates(config)
				: { candidates: await resolveNewReleaseCandidates(config), failed: 0 };
		const candidates = resolved.candidates.slice(0, Math.min(list.itemLimit ?? 100, MAX_ALBUMS));

		const { itemsNew, itemsRemoved } = await upsertCandidates(list, candidates);
		const itemsAutoAdded = await autoAddItems(list);

		const activeCount =
			(
				await db
					.select({ value: count() })
					.from(smartListItems)
					.where(and(eq(smartListItems.smartListId, list.id), lt(smartListItems.position, 9999)))
					.get()
			)?.value ?? 0;
		const inLibraryCount =
			(
				await db
					.select({ value: count() })
					.from(smartListItems)
					.where(
						and(
							eq(smartListItems.smartListId, list.id),
							eq(smartListItems.inLibrary, true),
							lt(smartListItems.position, 9999)
						)
					)
					.get()
			)?.value ?? 0;

		const completedAt = new Date().toISOString();
		const durationMs = Date.now() - startTime;

		await db
			.update(smartLists)
			.set({
				lastRefreshTime: completedAt,
				lastRefreshStatus: 'success',
				lastRefreshError: null,
				nextRefreshTime: new Date(
					Date.now() + list.refreshIntervalHours * 60 * 60 * 1000
				).toISOString(),
				cachedItemCount: activeCount,
				itemsInLibrary: inLibraryCount,
				itemsAutoAdded: (list.itemsAutoAdded ?? 0) + itemsAutoAdded,
				updatedAt: completedAt
			})
			.where(eq(smartLists.id, list.id))
			.run();

		await db
			.update(smartListRefreshHistory)
			.set({
				status: 'success',
				itemsFound: candidates.length,
				itemsNew,
				itemsRemoved,
				itemsAutoAdded,
				itemsFailed: resolved.failed,
				completedAt,
				durationMs
			})
			.where(eq(smartListRefreshHistory.id, historyEntry.id))
			.run();

		logger.info(
			{
				listId: list.id,
				source: config.source,
				itemsFound: candidates.length,
				itemsNew,
				itemsRemoved,
				itemsAutoAdded,
				durationMs
			},
			'[MusicSmartList] refresh completed'
		);

		return {
			smartListId: list.id,
			status: 'success',
			itemsFound: candidates.length,
			itemsNew,
			itemsRemoved,
			itemsAutoAdded,
			itemsFailed: resolved.failed,
			durationMs
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const durationMs = Date.now() - startTime;

		await db
			.update(smartLists)
			.set({
				lastRefreshStatus: 'failed',
				lastRefreshError: errorMessage,
				updatedAt: new Date().toISOString()
			})
			.where(eq(smartLists.id, list.id))
			.run();

		await db
			.update(smartListRefreshHistory)
			.set({
				status: 'failed',
				errorMessage,
				completedAt: new Date().toISOString(),
				durationMs
			})
			.where(eq(smartListRefreshHistory.id, historyEntry.id))
			.run();

		logger.error({ listId: list.id, err: errorMessage }, '[MusicSmartList] refresh failed');
		return {
			smartListId: list.id,
			status: 'failed',
			itemsFound: 0,
			itemsNew: 0,
			itemsRemoved: 0,
			itemsAutoAdded: 0,
			itemsFailed: 0,
			durationMs,
			errorMessage
		};
	}
}

export async function refreshMusicList(
	list: SmartListRecord,
	refreshType: 'automatic' | 'manual'
): Promise<RefreshResult> {
	if (inFlight.has(list.id)) {
		return {
			smartListId: list.id,
			status: 'running',
			itemsFound: 0,
			itemsNew: 0,
			itemsRemoved: 0,
			itemsAutoAdded: 0,
			itemsFailed: 0,
			durationMs: 0,
			errorMessage: 'A refresh is already running for this list'
		};
	}

	inFlight.add(list.id);
	try {
		return await runMusicListRefresh(list, refreshType);
	} finally {
		inFlight.delete(list.id);
	}
}
