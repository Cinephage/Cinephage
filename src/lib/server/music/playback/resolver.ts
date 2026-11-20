/**
 * Turning a track row into something an <audio> element can play.
 *
 * Order is deliberate: a file on disk always wins — the stream is a fallback
 * for albums the Streamer owns, never a replacement for owned media. A track
 * with neither a file nor a stream-backed album is not playable, and saying so
 * is better than silently searching YouTube for a normal library album.
 *
 * A cold provider track costs two yt-dlp runs (search, then resolve), which is
 * the pause before the music. The chosen upload is therefore written to
 * `tracks.stream_video_id`: a replay resolves it directly, and the album's
 * other tracks can be warmed from it (`warmer.ts`).
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, artists, trackFiles, tracks, trackStreamCache } from '#lib/server/db/schema.js';
import { isPathInsideManagedRoot } from '#lib/server/filesystem/path-guard.js';
import { getContentType } from '#lib/server/streaming/usenet/types.js';
import { createChildLogger } from '#lib/logging/index.js';
import { pickBestCandidate } from './match.js';
import { isYtDlpAvailable, resolveAudio, searchYoutube, type ResolvedAudio } from './ytdlp.js';

const logger = createChildLogger({ module: 'MusicPlaybackResolver', logDomain: 'streams' });

const CACHE_TTL_MS = 30 * 60 * 1000;

export interface TrackStream {
	source: 'local' | 'youtube';
	/** Absolute path for a local file, a direct upstream URL for YouTube. */
	url: string;
	contentType: string;
	expiresAt: number | null;
}

export type TrackStreamOutcome =
	| { status: 'ok'; stream: TrackStream; albumId: string }
	| { status: 'missing' }
	| { status: 'not-stream-backed' }
	| { status: 'provider-unavailable'; detail: string };

interface TrackRow {
	id: string;
	title: string;
	duration: number | null;
	albumId: string;
	albumTitle: string;
	albumPath: string | null;
	streamSource: string | null;
	/** The upload this track last resolved to, if any. */
	streamVideoId: string | null;
	artist: string;
	filePath: string | null;
}

interface CacheEntry {
	expiresAt: number;
	stream: TrackStream;
	albumId: string;
}

const cache = new Map<string, CacheEntry>();

function loadTrack(trackId: string): TrackRow | null {
	const row = db
		.select({
			id: tracks.id,
			title: tracks.title,
			duration: tracks.duration,
			albumId: albums.id,
			albumTitle: albums.title,
			albumPath: albums.path,
			streamSource: albums.streamSource,
			streamVideoId: tracks.streamVideoId,
			artist: artists.name,
			filePath: trackFiles.relativePath
		})
		.from(tracks)
		.innerJoin(albums, eq(tracks.albumId, albums.id))
		.innerJoin(artists, eq(albums.artistId, artists.id))
		.leftJoin(trackFiles, eq(trackFiles.trackId, tracks.id))
		.where(eq(tracks.id, trackId))
		.get();

	return row ?? null;
}

function cached(trackId: string): CacheEntry | null {
	const entry = cache.get(trackId);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		cache.delete(trackId);
		return null;
	}
	return entry;
}

/** True while the track can be served without touching the provider. */
export function isTrackStreamCached(trackId: string): boolean {
	return cached(trackId) !== null;
}

function remember(trackId: string, stream: TrackStream, albumId: string): void {
	const expiresAt = Math.min(Date.now() + CACHE_TTL_MS, stream.expiresAt ?? Number.POSITIVE_INFINITY);
	cache.set(trackId, { expiresAt, stream, albumId });
}

export function invalidateTrackStream(trackId: string): void {
	cache.delete(trackId);
	try {
		db.delete(trackStreamCache).where(eq(trackStreamCache.trackId, trackId)).run();
	} catch (error) {
		logger.warn(
			{ trackId, err: error instanceof Error ? error.message : String(error) },
			'[MusicPlayback] Could not drop the cached stream link'
		);
	}
}

/**
 * The provider link this track last resolved to, if it has not expired.
 *
 * An in-memory hit is faster, but a restart empties it — and the link itself
 * stays valid for hours, so re-resolving on every deploy is wasted minutes.
 */
function persistedStream(trackId: string): { stream: TrackStream; albumId: string } | null {
	const row = db
		.select({
			url: trackStreamCache.url,
			contentType: trackStreamCache.contentType,
			expiresAt: trackStreamCache.expiresAt,
			albumId: tracks.albumId
		})
		.from(trackStreamCache)
		.innerJoin(tracks, eq(trackStreamCache.trackId, tracks.id))
		.where(and(eq(trackStreamCache.trackId, trackId), gt(trackStreamCache.expiresAt, Date.now())))
		.get();

	if (!row) return null;

	return {
		stream: {
			source: 'youtube',
			url: row.url,
			contentType: row.contentType,
			expiresAt: row.expiresAt
		},
		albumId: row.albumId
	};
}

/** Keeps the link for the next process, and drops whatever has expired. */
function persistStream(trackId: string, stream: TrackStream): void {
	const expiresAt = stream.expiresAt ?? Date.now() + CACHE_TTL_MS;

	try {
		db.insert(trackStreamCache)
			.values({ trackId, url: stream.url, contentType: stream.contentType, expiresAt })
			.onConflictDoUpdate({
				target: trackStreamCache.trackId,
				set: { url: stream.url, contentType: stream.contentType, expiresAt }
			})
			.run();
		db.delete(trackStreamCache).where(lt(trackStreamCache.expiresAt, Date.now())).run();
	} catch (error) {
		logger.warn(
			{ trackId, err: error instanceof Error ? error.message : String(error) },
			'[MusicPlayback] Could not keep the resolved stream link'
		);
	}
}

/**
 * Keeps the upload a track plays from, so a replay skips the search and the
 * pick stays stable (a fresh search can land on a lyrics video one day and the
 * official audio the next). A failed write must not fail playback — the stream
 * has already resolved, and the next attempt will simply search again.
 */
function rememberVideoId(trackId: string, videoId: string): void {
	try {
		db.update(tracks).set({ streamVideoId: videoId }).where(eq(tracks.id, trackId)).run();
	} catch (error) {
		logger.warn(
			{ trackId, videoId, err: error instanceof Error ? error.message : String(error) },
			'[MusicPlayback] Could not remember the resolved upload'
		);
	}
}

interface ProviderPick {
	videoId: string;
	uploadTitle: string | null;
	audio: ResolvedAudio;
}

type ProviderOutcome = { ok: true; pick: ProviderPick } | { ok: false; detail: string };

/**
 * The provider upload for a track: the remembered one when it still resolves,
 * otherwise the best match of a fresh search.
 */
async function resolveFromProvider(trackId: string, row: TrackRow): Promise<ProviderOutcome> {
	if (row.streamVideoId) {
		const audio = await resolveAudio(row.streamVideoId).catch((error: unknown) => {
			logger.warn(
				{
					trackId,
					videoId: row.streamVideoId,
					err: error instanceof Error ? error.message : String(error)
				},
				'[MusicPlayback] Remembered upload no longer resolves, searching again'
			);
			return null;
		});
		if (audio) {
			return { ok: true, pick: { videoId: row.streamVideoId, uploadTitle: null, audio } };
		}
	}

	const query = `${row.artist} ${row.title}`;
	const candidates = await searchYoutube(query, 5).catch((error: unknown) => {
		logger.warn(
			{ trackId, query, err: error instanceof Error ? error.message : String(error) },
			'[MusicPlayback] YouTube search failed'
		);
		return [];
	});

	const best = pickBestCandidate(candidates, {
		title: row.title,
		artist: row.artist,
		duration: row.duration
	});
	if (!best) {
		logger.warn({ trackId, query, candidates: candidates.length }, '[MusicPlayback] No matching upload');
		return { ok: false, detail: 'No matching upload found' };
	}

	const audio = await resolveAudio(best.id).catch((error: unknown) => {
		logger.warn(
			{ trackId, videoId: best.id, err: error instanceof Error ? error.message : String(error) },
			'[MusicPlayback] YouTube resolve failed'
		);
		return null;
	});
	if (!audio) {
		return { ok: false, detail: 'Could not resolve an audio stream' };
	}

	return { ok: true, pick: { videoId: best.id, uploadTitle: best.title, audio } };
}

/**
 * Playback and the warmer ask for the same track at the same time — Jellyfin
 * even fires two requests for one play. Without this, each of them ran its own
 * yt-dlp pair; with it, the second caller waits for the first.
 */
const inFlight = new Map<string, Promise<TrackStreamOutcome>>();

export async function resolveTrackStream(trackId: string): Promise<TrackStreamOutcome> {
	const running = inFlight.get(trackId);
	if (running) return running;

	const pending = resolveUncached(trackId).finally(() => inFlight.delete(trackId));
	inFlight.set(trackId, pending);
	return pending;
}

async function resolveUncached(trackId: string): Promise<TrackStreamOutcome> {
	const hit = cached(trackId);
	if (hit) return { status: 'ok', stream: hit.stream, albumId: hit.albumId };

	const row = loadTrack(trackId);
	if (!row) return { status: 'missing' };

	if (row.filePath && row.albumPath) {
		const absolutePath = join(row.albumPath, row.filePath);
		if (await isPathInsideManagedRoot(absolutePath)) {
			try {
				const stats = statSync(absolutePath);
				if (stats.isFile()) {
					const stream: TrackStream = {
						source: 'local',
						url: absolutePath,
						contentType: getContentType(row.filePath),
						expiresAt: null
					};
					remember(trackId, stream, row.albumId);
					return { status: 'ok', stream, albumId: row.albumId };
				}
			} catch {
				logger.warn({ trackId, absolutePath }, '[MusicPlayback] Track file missing on disk');
			}
		} else {
			logger.warn({ trackId, absolutePath }, '[MusicPlayback] Track file outside managed roots');
		}
	}

	if (!row.streamSource) {
		return { status: 'not-stream-backed' };
	}

	const stored = persistedStream(trackId);
	if (stored) {
		remember(trackId, stored.stream, stored.albumId);
		return { status: 'ok', stream: stored.stream, albumId: stored.albumId };
	}

	if (!(await isYtDlpAvailable())) {
		return {
			status: 'provider-unavailable',
			detail: 'yt-dlp is not installed or not on PATH (set YTDLP_PATH)'
		};
	}

	const outcome = await resolveFromProvider(trackId, row);
	if (!outcome.ok) {
		return { status: 'provider-unavailable', detail: outcome.detail };
	}

	const { pick } = outcome;
	if (row.streamVideoId !== pick.videoId) {
		rememberVideoId(trackId, pick.videoId);
	}

	const stream: TrackStream = {
		source: 'youtube',
		url: pick.audio.url,
		contentType: pick.audio.contentType,
		expiresAt: pick.audio.expiresAt
	};
	remember(trackId, stream, row.albumId);
	persistStream(trackId, stream);

	logger.info(
		{
			trackId,
			query: `${row.artist} ${row.title}`,
			videoId: pick.videoId,
			upload: pick.uploadTitle,
			contentType: pick.audio.contentType
		},
		'[MusicPlayback] Resolved YouTube audio'
	);

	return { status: 'ok', stream, albumId: row.albumId };
}
