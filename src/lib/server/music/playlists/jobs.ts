/**
 * Playlist import jobs.
 *
 * A paste is three slow things in a row — fetch the playlist, resolve it
 * against MusicBrainz (one gated request per album/song), then add each album
 * (two or three more gated requests) — so it cannot live inside one HTTP
 * request. The job is the unit the browser polls instead.
 *
 * Jobs are in memory on purpose: the one-time import is idempotent per album
 * (`addAlbum` returns `created: false` for a row that already exists), so a
 * restart loses the progress display, not the work. The recurring case is a
 * smart list, which owns its own persisted schedule and does not use this
 * module.
 */
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '#lib/logging/index.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { autoSearchAlbum } from '../MusicAutoSearch.js';
import { musicAlbumService } from '../MusicAlbumService.js';
import { musicBrainz, pickPrimaryRelease } from '../musicbrainz.js';
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
const MAX_JOBS = 20;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

export type PlaylistJobPhase =
	| 'fetching'
	| 'resolving'
	| 'ready'
	| 'importing'
	| 'done'
	| 'failed'
	| 'cancelled';

export type PlaylistJobRowStatus = 'pending' | 'added' | 'existing' | 'failed' | 'skipped';

export interface PlaylistJobRow {
	releaseGroupMbid: string;
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
}

const jobs = new Map<string, PlaylistJob>();

function touch(job: PlaylistJob): void {
	job.updatedAt = new Date().toISOString();
}

function isFinished(job: PlaylistJob): boolean {
	return job.phase === 'done' || job.phase === 'failed' || job.phase === 'cancelled';
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
}

export function getPlaylistJob(id: string): PlaylistJob | null {
	return jobs.get(id) ?? null;
}

function toRow(candidate: AlbumCandidate): PlaylistJobRow {
	return {
		releaseGroupMbid: candidate.releaseGroupMbid,
		title: candidate.title,
		artistName: candidate.artistName,
		year: candidate.year,
		primaryType: candidate.primaryType,
		matchedBy: candidate.matchedBy,
		confidence: candidate.confidence,
		tracks: candidate.tracks,
		inLibrary: candidate.inLibrary,
		albumId: candidate.albumId,
		status: 'pending',
		error: null
	};
}

async function runResolve(job: PlaylistJob): Promise<void> {
	try {
		job.phase = 'fetching';
		job.progress = { done: 0, total: 0 };
		touch(job);

		const { source, url } = resolveSource(job.url);
		job.provider = source.id;
		const page = await source.fetchPlaylist(url, { limit: MAX_PLAYLIST_TRACKS });
		if (job.cancelRequested) return void finishCancelled(job);

		job.playlist = page.playlist;
		job.trackTotal = page.tracks.length;
		job.phase = 'resolving';
		touch(job);

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
		touch(job);
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
	} catch (err) {
		job.phase = 'failed';
		job.error = err instanceof Error ? err.message : String(err);
		touch(job);
		logger.warn({ err: job.error, jobId: job.id }, '[MusicPlaylistJobs] resolve failed');
	}
}

function finishCancelled(job: PlaylistJob): void {
	job.phase = 'cancelled';
	touch(job);
}

/** Start fetching and resolving a pasted playlist. Returns immediately. */
export function startResolveJob(input: string): PlaylistJob {
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
		error: null,
		cancelRequested: false,
		createdAt: now,
		updatedAt: now
	};
	jobs.set(job.id, job);
	void runResolve(job);
	return job;
}

async function runImport(job: PlaylistJob, rowIds: string[], options: ImportOptions): Promise<void> {
	const selected = new Set(rowIds);
	const rows = job.rows.filter((row) => selected.has(row.releaseGroupMbid));
	job.phase = 'importing';
	job.progress = { done: 0, total: rows.length };
	job.summary = { added: 0, existing: 0, failed: 0 };
	touch(job);

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

	for (const row of rows) {
		if (job.cancelRequested) {
			finishCancelled(job);
			return;
		}
		try {
			const releaseGroup = await musicBrainz.getReleaseGroup(row.releaseGroupMbid);
			const editions = await musicBrainz.getReleaseGroupReleases(row.releaseGroupMbid);
			const primary = pickPrimaryRelease(editions);
			if (!primary) throw new Error('no editions to import');
			const release = await musicBrainz.getRelease(primary.mbid);
			const result = musicAlbumService.addAlbum({
				releaseGroup,
				release,
				libraryId,
				rootFolderId,
				monitored: options.monitored ?? true,
				qualityProfileId: options.qualityProfileId ?? null
			});
			row.status = result.created ? 'added' : 'existing';
			row.albumId = result.albumId;
			row.error = null;
			if (result.created) job.summary.added += 1;
			else job.summary.existing += 1;

			if (options.searchAfterAdd) {
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
	touch(job);
	logger.info(
		{ jobId: job.id, ...job.summary },
		'[MusicPlaylistJobs] playlist import finished'
	);
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

	void runImport(job, rowIds, options);
	return job;
}

export function cancelPlaylistJob(id: string): PlaylistJob | null {
	const job = jobs.get(id);
	if (!job) return null;
	if (!isFinished(job)) job.cancelRequested = true;
	return job;
}
