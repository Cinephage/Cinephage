/**
 * Turning a track row into something an <audio> element can play.
 *
 * Order is deliberate: a file on disk always wins — the stream is a fallback
 * for albums the Streamer owns, never a replacement for owned media. A track
 * with neither a file nor a stream-backed album is not playable, and saying so
 * is better than silently searching YouTube for a normal library album.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { albums, artists, trackFiles, tracks } from '#lib/server/db/schema.js';
import { isPathInsideManagedRoot } from '#lib/server/filesystem/path-guard.js';
import { getContentType } from '#lib/server/streaming/usenet/types.js';
import { createChildLogger } from '#lib/logging/index.js';
import { pickBestCandidate } from './match.js';
import { isYtDlpAvailable, resolveAudio, searchYoutube } from './ytdlp.js';

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
	| { status: 'ok'; stream: TrackStream }
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
	artist: string;
	filePath: string | null;
}

const cache = new Map<string, { expiresAt: number; stream: TrackStream }>();

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

function cached(trackId: string): TrackStream | null {
	const entry = cache.get(trackId);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		cache.delete(trackId);
		return null;
	}
	return entry.stream;
}

function remember(trackId: string, stream: TrackStream): void {
	const expiresAt = Math.min(Date.now() + CACHE_TTL_MS, stream.expiresAt ?? Number.POSITIVE_INFINITY);
	cache.set(trackId, { expiresAt, stream });
}

export function invalidateTrackStream(trackId: string): void {
	cache.delete(trackId);
}

export async function resolveTrackStream(trackId: string): Promise<TrackStreamOutcome> {
	const hit = cached(trackId);
	if (hit) return { status: 'ok', stream: hit };

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
					remember(trackId, stream);
					return { status: 'ok', stream };
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

	if (!(await isYtDlpAvailable())) {
		return {
			status: 'provider-unavailable',
			detail: 'yt-dlp is not installed or not on PATH (set YTDLP_PATH)'
		};
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
		return { status: 'provider-unavailable', detail: 'No matching upload found' };
	}

	const audio = await resolveAudio(best.id).catch((error: unknown) => {
		logger.warn(
			{ trackId, videoId: best.id, err: error instanceof Error ? error.message : String(error) },
			'[MusicPlayback] YouTube resolve failed'
		);
		return null;
	});
	if (!audio) {
		return { status: 'provider-unavailable', detail: 'Could not resolve an audio stream' };
	}

	const stream: TrackStream = {
		source: 'youtube',
		url: audio.url,
		contentType: audio.contentType,
		expiresAt: audio.expiresAt
	};
	remember(trackId, stream);

	logger.info(
		{
			trackId,
			query,
			videoId: best.id,
			upload: best.title,
			duration: best.duration,
			contentType: audio.contentType
		},
		'[MusicPlayback] Resolved YouTube audio'
	);

	return { status: 'ok', stream };
}
