/**
 * Playlist import jobs.
 *
 * A paste is three slow things in a row — fetch the playlist, resolve it
 * against MusicBrainz (one gated request per album/song), then add each album
 * (one gated request, plus an expansion for a discography). A real library is
 * minutes of that, and the person starts it and leaves, so the job is a row in
 * `music_import_jobs` as well as an object in memory.
 *
 * Only the recipe is stored: resolution lives in `music_lookup_cache`, adding
 * an album is idempotent, so a resumed job re-runs cheaply and cannot
 * double-add. The per-album outcome is stored too, because "what did it
 * actually do while I was away" is the question a returning user asks.
 */
import { randomUUID } from 'node:crypto';
import { desc, eq, lt } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { musicImportJobs } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { autoSearchAlbum } from '../MusicAutoSearch.js';
import { musicAlbumService } from '../MusicAlbumService.js';
import { COMPILATION_SECONDARY, musicBrainz } from '../musicbrainz.js';
import type { MusicReleaseGroup } from '../types.js';
import {
	getArtistDiscography,
	getArtistFeatures,
	getCachedRelease,
	setArtistDiscography,
	setArtistFeatures,
	setCachedRelease
} from './cache.js';
import { PlaylistError } from './errors.js';
import { resolvePlaylistTracks } from './resolve.js';
import { resolveSource } from './sources/index.js';
import type {
	AlbumCandidate,
	MatchBasis,
	MatchConfidence,
	PlaylistProviderId,
	PlaylistRef,
	UnmatchedTrack
} from './types.js';

const logger = createChildLogger({ module: 'MusicPlaylistJobs', logDomain: 'system' });

/** A paste is a person's playlist, not an archive dump; beyond this the UI offers a smart list. */
export const MAX_PLAYLIST_TRACKS = 500;
/** A discography expansion stops here; the rest is a second paste. */
const MAX_SCOPE_ALBUMS = 600;
const MAX_JOBS = 20;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const JOB_KEEP_DAYS = 30;
const SAVE_INTERVAL_MS = 1500;

export type PlaylistJobPhase =
	| 'fetching'
	| 'resolving'
	| 'ready'
	| 'importing'
	| 'done'
	| 'failed'
	| 'cancelled'
	/** The process stopped while this job was running; it can be resumed. */
	| 'interrupted';

export type PlaylistJobRowStatus = 'pending' | 'added' | 'existing' | 'failed' | 'skipped';

/** What an import should add: the matched album, or every album by its artist. */
/**
 * What a selection means: the albums that matched, every album by each
 * match's artist, that plus guest appearances, or the matched albums with
 * only the listed songs wanted.
 */
export type ImportScope = 'album' | 'artist' | 'features' | 'songs';

export interface PlaylistJobRow {
	releaseGroupMbid: string;
	/** The artist the release group belongs to; `artist` scope browses by it. */
	artistMbid: string | null;
	title: string;
	artistName: string;
	year: number | null;
	primaryType: string | null;
	matchedBy: MatchBasis;
	confidence: MatchConfidence;
	tracks: Array<{ title: string; artist: string }>;
	inLibrary: boolean;
	albumId: string | null;
	status: PlaylistJobRowStatus;
	error: string | null;
}

export interface JobRecipe {
	scope: ImportScope;
	/** The release groups the user kept selected; replays an import on resume. */
	rowIds: string[];
	libraryId: string | null;
	rootFolderId: string | null;
	qualityProfileId: string | null;
	monitored: boolean;
	searchAfterAdd: boolean;
}

export interface PlaylistJob {
	id: string;
	url: string;
	provider: PlaylistProviderId | null;
	playlist: PlaylistRef | null;
	phase: PlaylistJobPhase;
	/** Work unit progress inside the current phase; `total` is 0 while fetching. */
	progress: { done: number; total: number };
	trackTotal: number;
	resolvedTracks: number;
	rows: PlaylistJobRow[];
	unmatched: UnmatchedTrack[];
	summary: { added: number; existing: number; failed: number } | null;
	recipe: JobRecipe;
	error: string | null;
	cancelRequested: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface ImportOptions {
	libraryId?: string | null;
	rootFolderId?: string | null;
	qualityProfileId?: string | null;
	monitored?: boolean;
	/** Grab a release for each added album as it lands. Off by default; it is a lot of indexer traffic. */
	searchAfterAdd?: boolean;
	scope?: ImportScope;
}

const jobs = new Map<string, PlaylistJob>();
let lastSaveAt = 0;

function isFinished(job: PlaylistJob): boolean {
	return (
		job.phase === 'done' ||
		job.phase === 'failed' ||
		job.phase === 'cancelled' ||
		job.phase === 'interrupted'
	);
}

function emptyRecipe(scope: ImportScope = 'album'): JobRecipe {
	return {
		scope,
		rowIds: [],
		libraryId: null,
		rootFolderId: null,
		qualityProfileId: null,
		monitored: true,
		searchAfterAdd: false
	};
}

/**
 * Write the job down. Progress ticks every MusicBrainz request, so the write
 * is throttled; a phase change is always written, because that is what a
 * resumed job and the job list key off.
 */
function save(job: PlaylistJob, force = false): void {
	const now = Date.now();
	if (!force && now - lastSaveAt < SAVE_INTERVAL_MS) return;
	lastSaveAt = now;
	const values = {
		id: job.id,
		url: job.url,
		recipe: job.recipe,
		phase: job.phase,
		progress: job.progress,
		summary: job.summary,
		result: job.rows.map((row) => ({
			mbid: row.releaseGroupMbid,
			title: row.title,
			artist: row.artistName,
			status: row.status,
			error: row.error,
			// Enough to preview and expand after a restart: the artist is what an
			// expansion browses, and the rest is what the review screen shows.
			artistMbid: row.artistMbid,
			year: row.year,
			primaryType: row.primaryType,
			albumId: row.albumId,
			inLibrary: row.inLibrary
		})),
		error: job.error,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt
	};
	try {
		db.insert(musicImportJobs)
			.values(values)
			.onConflictDoUpdate({ target: musicImportJobs.id, set: values })
			.run();
	} catch (err) {
		// The in-memory job must keep working even if the row cannot be written.
		logger.warn(
			{ err: err instanceof Error ? err.message : String(err), jobId: job.id },
			'[MusicPlaylistJobs] could not persist the job'
		);
	}
}

function touch(job: PlaylistJob, force = false): void {
	job.updatedAt = new Date().toISOString();
	save(job, force);
}

/** Evict finished jobs past their TTL, then the oldest finished jobs over the cap. */
function prune(): void {
	const now = Date.now();
	for (const [id, job] of jobs) {
		if (isFinished(job) && now - Date.parse(job.updatedAt) > JOB_TTL_MS) jobs.delete(id);
	}
	while (jobs.size > MAX_JOBS) {
		const oldest = [...jobs.values()]
			.filter(isFinished)
			.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
		if (!oldest) break;
		jobs.delete(oldest.id);
	}

	const cutoff = new Date(now - JOB_KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
	try {
		db.delete(musicImportJobs).where(lt(musicImportJobs.createdAt, cutoff)).run();
	} catch {
		// Housekeeping only; a failure here must not break a new import.
	}
}

export function getPlaylistJob(id: string): PlaylistJob | null {
	const live = jobs.get(id);
	if (live) return live;

	const row = db.select().from(musicImportJobs).where(eq(musicImportJobs.id, id)).get();
	if (!row) return null;
	// A row whose process is gone is not "running" any more, whatever it said.
	const phase: PlaylistJobPhase =
		row.phase === 'fetching' || row.phase === 'resolving' || row.phase === 'importing'
			? 'interrupted'
			: (row.phase as PlaylistJobPhase);
	return {
		id: row.id,
		url: row.url,
		provider: null,
		playlist: null,
		phase,
		progress: row.progress,
		trackTotal: 0,
		resolvedTracks: 0,
		rows: (row.result ?? []).map((entry) => ({
			releaseGroupMbid: entry.mbid,
			artistMbid: entry.artistMbid ?? null,
			title: entry.title,
			artistName: entry.artist,
			year: entry.year ?? null,
			primaryType: entry.primaryType ?? null,
			matchedBy: 'album',
			confidence: 'high',
			tracks: [],
			inLibrary: entry.inLibrary ?? entry.status === 'existing',
			albumId: entry.albumId ?? null,
			status: entry.status as PlaylistJobRowStatus,
			error: entry.error
		})),
		unmatched: [],
		summary: row.summary ?? null,
		recipe: row.recipe,
		error: row.error,
		cancelRequested: false,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

/** Recent imports, newest first — what the modal's "recent" list shows. */
export function listPlaylistJobs(limit = 12): PlaylistJob[] {
	const rows = db
		.select({ id: musicImportJobs.id })
		.from(musicImportJobs)
		.orderBy(desc(musicImportJobs.createdAt))
		.limit(limit)
		.all();
	return rows.flatMap((row) => {
		const job = getPlaylistJob(row.id);
		return job ? [job] : [];
	});
}

function toRow(candidate: AlbumCandidate): PlaylistJobRow {
	return {
		releaseGroupMbid: candidate.releaseGroupMbid,
		artistMbid: candidate.artistMbid,
		inLibrary: candidate.inLibrary,
		albumId: candidate.albumId,
		title: candidate.title,
		artistName: candidate.artistName,
		year: candidate.year,
		primaryType: candidate.primaryType,
		matchedBy: candidate.matchedBy,
		confidence: candidate.confidence,
		tracks: candidate.tracks,
		status: 'pending',
		error: null
	};
}

function rowFromGroup(group: MusicReleaseGroup): PlaylistJobRow {
	return {
		releaseGroupMbid: group.mbid,
		artistMbid: group.artist.mbid,
		title: group.title,
		artistName: group.artist.name,
		year: group.year ?? null,
		primaryType: group.primaryType ?? null,
		matchedBy: 'album',
		confidence: 'high',
		tracks: [],
		inLibrary: false,
		albumId: null,
		status: 'pending',
		error: null
	};
}

async function runResolve(job: PlaylistJob): Promise<void> {
	try {
		job.phase = 'fetching';
		job.progress = { done: 0, total: 0 };
		touch(job, true);

		const { source, url } = resolveSource(job.url);
		job.provider = source.id;
		const page = await source.fetchPlaylist(url, { limit: MAX_PLAYLIST_TRACKS });
		if (job.cancelRequested) return void finishCancelled(job);

		job.playlist = page.playlist;
		job.trackTotal = page.tracks.length;
		job.phase = 'resolving';
		touch(job, true);

		const result = await resolvePlaylistTracks(page.tracks, {
			onProgress: (progress) => {
				job.progress = { done: progress.done, total: progress.total };
				touch(job);
			}
		});
		if (job.cancelRequested) return void finishCancelled(job);

		job.rows = result.candidates.map(toRow);
		job.unmatched = result.unmatched;
		job.resolvedTracks = result.resolvedTracks;
		job.phase = 'ready';
		touch(job, true);
		logger.info(
			{
				jobId: job.id,
				provider: job.provider,
				tracks: job.trackTotal,
				albums: job.rows.length,
				unmatched: job.unmatched.length
			},
			'[MusicPlaylistJobs] playlist resolved'
		);

		// A resumed import already knows what to add; go straight to it.
		if (job.recipe.rowIds.length > 0) {
			const known = new Set(job.rows.map((row) => row.releaseGroupMbid));
			const selected = job.recipe.rowIds.filter((id) => known.has(id));
			if (selected.length > 0) await runImport(job, selected, job.recipe);
		}
	} catch (err) {
		job.phase = 'failed';
		job.error = err instanceof Error ? err.message : String(err);
		touch(job, true);
		logger.warn({ err: job.error, jobId: job.id }, '[MusicPlaylistJobs] resolve failed');
	}
}

function finishCancelled(job: PlaylistJob): void {
	job.phase = 'cancelled';
	touch(job, true);
}

/** Start fetching and resolving a pasted playlist. Returns immediately. */
export function startResolveJob(input: string, scope: ImportScope = 'album'): PlaylistJob {
	prune();
	// Validate the URL before creating a job so a typo is a 400, not a failed job.
	const { url } = resolveSource(input);

	const now = new Date().toISOString();
	const job: PlaylistJob = {
		id: randomUUID(),
		url: url.toString(),
		provider: null,
		playlist: null,
		phase: 'fetching',
		progress: { done: 0, total: 0 },
		trackTotal: 0,
		resolvedTracks: 0,
		rows: [],
		unmatched: [],
		summary: null,
		recipe: emptyRecipe(scope),
		error: null,
		cancelRequested: false,
		createdAt: now,
		updatedAt: now
	};
	jobs.set(job.id, job);
	save(job, true);
	void runResolve(job);
	return job;
}

/**
 * Every album by the artist of each selected row, minus what is already
 * stored. One browse request per artist (paged), then the normal album path;
 * `filterReleaseGroups` keeps albums and EPs and drops compilations, so a
 * "whole artist" import is a discography, not every single and karaoke disc.
 */
/** One artist's albums as an expansion would add them, cached per scope. */
async function artistGroups(
	artist: { mbid: string; name: string },
	scope: 'artist' | 'features'
): Promise<MusicReleaseGroup[]> {
	const cached = scope === 'features' ? getArtistFeatures(artist.mbid) : getArtistDiscography(artist.mbid);
	if (cached) return cached.value ?? [];

	const groups: MusicReleaseGroup[] = [];
	let offset = 0;
	// Browse pages at 100; a prolific artist needs two or three requests.
	while (true) {
		const page = await musicBrainz.getArtistReleaseGroups(artist.mbid, artist, { limit: 100, offset });
		groups.push(...page.releaseGroups);
		offset += page.releaseGroups.length;
		if (page.releaseGroups.length === 0 || offset >= page.total) break;
	}
	const own = musicAlbumService.filterReleaseGroups(groups, {});
	setArtistDiscography(artist.mbid, own);
	if (scope === 'artist') return own;

	const guests = await guestAlbums(artist);
	const all = [...own, ...guests.filter((guest) => !own.some((group) => group.mbid === guest.mbid))];
	setArtistFeatures(artist.mbid, all);
	return all;
}

/**
 * Albums where the artist is a guest, not the album artist.
 *
 * MusicBrainz has no "guest appearances" browse: the recording search keyed by
 * artist id is the way in — every recording they are credited on, from which
 * the albums that belong to someone else are what "with featuring" means.
 * Only the first release each recording names is visible here, so this is a
 * good approximation, not a discography.
 */
async function guestAlbums(artist: { mbid: string; name: string }): Promise<MusicReleaseGroup[]> {
	const hits = await musicBrainz.searchRecordings({
		artist: artist.name,
		artistMbid: artist.mbid,
		limit: 100
	});
	const seen = new Map<string, MusicReleaseGroup>();
	for (const hit of hits) {
		const candidate = hit.releaseGroup;
		const owner = candidate?.artist;
		if (!candidate || !owner || owner.mbid === artist.mbid) continue;
		if (owner.name === 'Various Artists') continue;
		if ((candidate.primaryType ?? 'Album') !== 'Album' && candidate.primaryType !== 'EP') continue;
		const secondary = candidate.secondaryTypes ?? [];
		if (secondary.some((type) => (COMPILATION_SECONDARY as readonly string[]).includes(type))) continue;
		seen.set(candidate.mbid, {
			mbid: candidate.mbid,
			title: candidate.title,
			primaryType: candidate.primaryType ?? null,
			secondaryTypes: secondary,
			firstReleaseDate: candidate.firstReleaseDate ?? null,
			year: candidate.firstReleaseDate ? Number(candidate.firstReleaseDate.slice(0, 4)) : null,
			artist: owner
		});
	}
	return [...seen.values()];
}

/** What an expansion would add, per artist, before anything is written. */
export interface ExpansionPreview {
	total: number;
	byArtist: Array<{
		artistMbid: string;
		artistName: string;
		count: number;
		albums: Array<{ mbid: string; title: string; year: number | null; primaryType: string | null }>;
	}>;
}

/** The albums an expansion adds, as rows and as a preview, computed once. */
async function planExpansion(
	rows: PlaylistJobRow[],
	scope: ImportScope
): Promise<{ rows: PlaylistJobRow[]; preview: ExpansionPreview }> {
	const artists = new Map<string, string>();
	for (const row of rows) {
		if (row.artistMbid) artists.set(row.artistMbid, row.artistName);
	}

	const stored = musicAlbumService.existingReleaseGroupMbids();
	const targets = new Map<string, PlaylistJobRow>();
	const byArtist: ExpansionPreview['byArtist'] = [];
	for (const [mbid, name] of artists) {
		let groups: MusicReleaseGroup[] = [];
		try {
			groups = await artistGroups({ mbid, name }, scope === 'features' ? 'features' : 'artist');
		} catch (err) {
			logger.warn(
				{ err: err instanceof Error ? err.message : String(err), artist: name },
				'[MusicPlaylistJobs] artist expansion failed'
			);
			continue;
		}
		const added: ExpansionPreview['byArtist'][number]['albums'] = [];
		for (const group of groups) {
			if (stored.has(group.mbid) || targets.has(group.mbid)) continue;
			if (targets.size >= MAX_SCOPE_ALBUMS) break;
			targets.set(group.mbid, rowFromGroup(group));
			added.push({
				mbid: group.mbid,
				title: group.title,
				year: group.year ?? null,
				primaryType: group.primaryType ?? null
			});
		}
		byArtist.push({ artistMbid: mbid, artistName: name, count: added.length, albums: added });
		if (targets.size >= MAX_SCOPE_ALBUMS) break;
	}
	return { rows: [...targets.values()], preview: { total: targets.size, byArtist } };
}

/** The rows an artist/features import would add on top of the selection. */
export async function expandArtists(
	rows: PlaylistJobRow[],
	scope: ImportScope
): Promise<PlaylistJobRow[]> {
	return (await planExpansion(rows, scope)).rows;
}

/**
 * What the current selection would add, without importing anything.
 *
 * "Artist" turns three checked albums into two hundred; the review screen says
 * so before the button is pressed, using the same computation the import does.
 */
export async function previewExpansion(rows: PlaylistJobRow[], scope: ImportScope): Promise<ExpansionPreview> {
	if (scope !== 'artist' && scope !== 'features') return { total: 0, byArtist: [] };
	return (await planExpansion(rows, scope)).preview;
}

async function runImport(
	job: PlaylistJob,
	rowIds: string[],
	options: JobRecipe
): Promise<void> {
	const selected = new Set(rowIds);
	const chosen = job.rows.filter((row) => selected.has(row.releaseGroupMbid));
	job.recipe = { ...options, rowIds, scope: options.scope ?? 'album' };
	job.phase = 'importing';
	job.progress = { done: 0, total: chosen.length };
	job.summary = { added: 0, existing: 0, failed: 0 };
	touch(job, true);

	let libraryId = options.libraryId ?? null;
	let rootFolderId = options.rootFolderId ?? null;
	if (!libraryId) {
		// Same defaulting rule as the single-album route: an album added without
		// a library goes to the default music library, with its default folder.
		const libraries = await getLibraryEntityService().listLibraries({ mediaType: 'music' });
		const target = libraries.find((library) => library.isDefault) ?? libraries[0] ?? null;
		libraryId = target?.id ?? null;
		rootFolderId = rootFolderId ?? target?.defaultRootFolderId ?? null;
	}

	let targets = chosen;
	if (job.recipe.scope === 'artist' || job.recipe.scope === 'features') {
		const expanded = await expandArtists(chosen, job.recipe.scope);
		job.rows.push(...expanded);
		targets = [...chosen, ...expanded];
		job.progress.total = targets.length;
		touch(job, true);
		logger.info(
			{
				jobId: job.id,
				artists: new Set(chosen.map((row) => row.artistMbid)).size,
				albums: targets.length
			},
			'[MusicPlaylistJobs] discography expanded'
		);
	}

	for (const row of targets) {
		if (job.cancelRequested) {
			finishCancelled(job);
			return;
		}
		if (row.status !== 'pending') {
			// Expanded rows can repeat a selected album's artist; stop at the same
			// row twice rather than adding it twice.
			job.progress.done += 1;
			touch(job);
			continue;
		}
		if (row.inLibrary) {
			// Already here; the resolve already told us, and re-fetching the
			// release group would spend a request to learn nothing.
			row.status = 'existing';
			job.summary.existing += 1;
			job.progress.done += 1;
			touch(job);
			continue;
		}

		try {
			// One request per album: group, official edition and tracklist together.
			// A release that was imported before comes back from the cache instead.
			const cachedRelease = getCachedRelease(row.releaseGroupMbid)?.value ?? null;
			let group;
			let release;
			if (cachedRelease) {
				({ group, release } = cachedRelease);
			} else {
				const fetched = await musicBrainz.getReleaseGroupWithTracklist(row.releaseGroupMbid);
				setCachedRelease(row.releaseGroupMbid, fetched);
				({ group, release } = fetched);
			}
			const result = musicAlbumService.addAlbum({
				releaseGroup: group,
				release,
				libraryId,
				rootFolderId,
				monitored: job.recipe.monitored,
				qualityProfileId: job.recipe.qualityProfileId,
				// "Just the songs": the album comes along, the want is the track.
				onlyTracks:
					job.recipe.scope === 'songs' ? row.tracks.map((track) => track.title) : undefined
			});
			row.status = result.created ? 'added' : 'existing';
			row.albumId = result.albumId;
			row.error = null;
			if (result.created) job.summary.added += 1;
			else job.summary.existing += 1;

			if (job.recipe.searchAfterAdd) {
				const album = musicAlbumService.getAlbum(result.albumId);
				if (album) await autoSearchAlbum(album);
			}
		} catch (err) {
			row.status = 'failed';
			row.error = err instanceof Error ? err.message : String(err);
			job.summary.failed += 1;
			logger.warn(
				{ jobId: job.id, mbid: row.releaseGroupMbid, err: row.error },
				'[MusicPlaylistJobs] album import failed'
			);
		}
		job.progress.done += 1;
		touch(job);
	}

	job.phase = 'done';
	touch(job, true);
	logger.info({ jobId: job.id, ...job.summary }, '[MusicPlaylistJobs] playlist import finished');
}

/**
 * Import the chosen rows of a resolved job. Rows are addressed by release-group
 * mbid, which the server re-fetches before writing — the client never supplies
 * album metadata, only which rows it selected.
 */
export function startImportJob(
	id: string,
	rowIds: string[],
	options: ImportOptions = {}
): PlaylistJob {
	const job = jobs.get(id);
	if (!job) throw new PlaylistError('Import job not found or expired', 400);
	if (job.phase !== 'ready') {
		throw new PlaylistError(`That job is ${job.phase}, not ready to import`, 400);
	}
	if (rowIds.length === 0) throw new PlaylistError('Select at least one album to import', 400);

	const known = new Set(job.rows.map((row) => row.releaseGroupMbid));
	const unknown = rowIds.filter((rowId) => !known.has(rowId));
	if (unknown.length > 0) {
		throw new PlaylistError('Some selected albums are not part of this playlist', 400);
	}

	const recipe: JobRecipe = {
		scope: options.scope ?? 'album',
		rowIds,
		libraryId: options.libraryId ?? null,
		rootFolderId: options.rootFolderId ?? null,
		qualityProfileId: options.qualityProfileId ?? null,
		monitored: options.monitored ?? true,
		searchAfterAdd: options.searchAfterAdd ?? false
	};
	void runImport(job, rowIds, recipe);
	return job;
}

/**
 * Re-run a job that stopped when the process did. Resolution is cached and
 * adding is idempotent, so replaying the stored recipe is safe; an import that
 * had already started replays its own selection.
 */
export function resumePlaylistJob(id: string): PlaylistJob {
	prune();
	const existing = getPlaylistJob(id);
	if (!existing) throw new PlaylistError('Import job not found or expired', 404);
	if (!(existing.phase === 'interrupted' || existing.phase === 'failed')) {
		throw new PlaylistError(`That job is ${existing.phase}, not resumable`, 400);
	}

	const now = new Date().toISOString();
	const job: PlaylistJob = {
		...existing,
		phase: 'fetching',
		progress: { done: 0, total: 0 },
		rows: [],
		unmatched: [],
		summary: null,
		error: null,
		cancelRequested: false,
		updatedAt: now
	};
	jobs.set(job.id, job);
	touch(job, true);
	void runResolve(job);
	return job;
}

export function cancelPlaylistJob(id: string): PlaylistJob | null {
	const job = getPlaylistJob(id);
	if (!job) return null;
	if (!isFinished(job)) {
		job.cancelRequested = true;
		touch(job);
	}
	return job;
}
