/**
 * YouTube playlists, read through yt-dlp.
 *
 * yt-dlp is already the music path's only external binary (streaming search and
 * resolve), so a YouTube playlist needs no API key and no new dependency. The
 * price is that a YouTube entry is a *video title*, not track metadata, so the
 * title has to be parsed here before MusicBrainz is asked anything.
 */
import { execFile } from 'node:child_process';
import { PlaylistError } from '../errors.js';
import type { PlaylistPage, PlaylistSource, PlaylistTrack } from '../types.js';

const YTDLP_PATH = process.env.YTDLP_PATH ?? 'yt-dlp';
const FETCH_TIMEOUT_MS = 90_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/** Bracketed segments that name the upload, never the song. */
const NOISE = [
	'official\\s+(music\\s+)?video',
	'official\\s+audio',
	'official\\s+lyric\\s+video',
	'lyric\\s+video',
	'lyrics?',
	'video\\s+oficial',
	'video\\s+lyric',
	'performance\\s+video',
	'visuali[sz]er',
	'audio',
	'm\\/v',
	'mv',
	'hd',
	'hq',
	'4k',
	'explicit'
];

const NOISE_SEGMENT = new RegExp(`^\\s*(?:${NOISE.join('|')})\\s*$`, 'i');
const TRAILING_NOISE = new RegExp(`\\s+(?:${NOISE.join('|')})\\s*$`, 'i');

/** `Artist - Track` and `Track - Artist` both exist; the channel decides which. */
const SEPARATORS = /\s+[-–—]\s+/;

/** Lowercase, diacritics stripped, punctuation collapsed — for comparisons only. */
function fold(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/**
 * Drop the parenthesised upload noise: a segment is removed only when the whole
 * bracket is noise, so "(Remastered 2015)" and "(Live at Wembley)" survive — a
 * remaster is the same recording, a live cut is not.
 */
export function stripUploadNoise(raw: string): string {
	const withoutBrackets = raw.replace(/[([][^)\]]*[)\]]/g, (segment) => {
		const inner = segment.slice(1, -1);
		return NOISE_SEGMENT.test(inner) ? ' ' : segment;
	});
	let text = withoutBrackets.replace(/\s+/g, ' ').trim();
	// "Song Name Official Video" without brackets, usually at the end.
	while (TRAILING_NOISE.test(text)) text = text.replace(TRAILING_NOISE, '').trim();
	return text.replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();
}

/** The channel's own name, without the suffixes YouTube adds for music uploads. */
export function cleanChannel(channel: string | null): string | null {
	if (!channel) return null;
	const cleaned = channel
		.replace(/\s*-\s*Topic$/i, '')
		.replace(/\s*VEVO$/i, '')
		.replace(/\s+Official$/i, '')
		.trim();
	return cleaned || null;
}

function splitArtists(text: string): string[] {
	return text
		.split(/\s*(?:,|&|\band\b|\bfeat\.?\b|\bft\.?\b|\bwith\b)\s*/i)
		.map((part) => part.trim())
		.filter(Boolean);
}

function overlapFraction(a: string, b: string): number {
	const left = new Set(fold(a).split(' ').filter(Boolean));
	const right = new Set(fold(b).split(' ').filter(Boolean));
	if (left.size === 0 || right.size === 0) return 0;
	let hits = 0;
	for (const token of left) if (right.has(token)) hits += 1;
	return hits / left.size;
}

/**
 * Turn a YouTube entry into a track query.
 *
 * Two orders are common — `Artist - Title` (official uploads) and
 * `Title - Artist` (label compilations) — and guessing wrong sends MusicBrainz
 * a query that matches nothing. The channel name breaks the tie: the side that
 * looks like the channel is the artist. With no channel match the conventional
 * `Artist - Title` order wins, and the channel becomes the artist.
 */
export function parseYoutubeEntry(
	rawTitle: string,
	channel: string | null
): { title: string; artists: string[] } {
	const cleanedChannel = cleanChannel(channel);
	const text = stripUploadNoise(rawTitle);

	const parts = text.split(SEPARATORS).map((part) => part.trim());
	if (parts.length >= 2) {
		const [left, right] = parts;
		if (cleanedChannel) {
			const leftScore = overlapFraction(left, cleanedChannel);
			const rightScore = overlapFraction(right, cleanedChannel);
			// A channel covering the side is stronger evidence than an incidental
			// shared word, hence the 0.5 floor rather than "whichever is larger".
			if (rightScore >= 0.5 && rightScore > leftScore) {
				return { title: left, artists: splitArtists(right) };
			}
		}
		return { title: right, artists: splitArtists(left) };
	}

	return {
		title: text,
		artists: cleanedChannel ? splitArtists(cleanedChannel) : []
	};
}

interface YtDlpPlaylist {
	id?: string;
	title?: string;
	description?: string | null;
	channel?: string | null;
	uploader?: string | null;
	playlist_count?: number;
	thumbnails?: Array<{ url?: string }>;
	entries?: Array<{
		id?: string;
		title?: string;
		channel?: string | null;
		uploader?: string | null;
		duration?: number | null;
	}>;
}

function run(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			YTDLP_PATH,
			args,
			{ timeout: FETCH_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
			(error, stdout) => {
				if (error) reject(error);
				else resolve(stdout);
			}
		);
	});
}

function youtubePlaylistId(url: URL): string | null {
	const host = url.hostname.replace(/^www\.|^m\./, '');
	const isYoutube =
		host === 'youtube.com' ||
		host === 'music.youtube.com' ||
		host === 'youtu.be' ||
		host.endsWith('.youtube.com');
	if (!isYoutube) return null;
	const list = url.searchParams.get('list');
	return list && /^[A-Za-z0-9_-]{10,}$/.test(list) ? list : null;
}

export const youtubeSource: PlaylistSource = {
	id: 'youtube',
	label: 'YouTube',
	parseUrl: youtubePlaylistId,

	async fetchPlaylist(url, { limit }): Promise<PlaylistPage> {
		const id = youtubePlaylistId(url);
		if (!id) throw new PlaylistError('Not a YouTube playlist URL', 400);

		let stdout: string;
		try {
			stdout = await run([
				'--no-warnings',
				'--flat-playlist',
				// One dead video must not fail the whole paste.
				'--ignore-errors',
				'--playlist-end',
				String(limit),
				'-J',
				url.toString()
			]);
		} catch (err) {
			throw new PlaylistError(
				`YouTube did not return the playlist: ${err instanceof Error ? err.message : String(err)}`,
				502
			);
		}

		let parsed: YtDlpPlaylist;
		try {
			parsed = JSON.parse(stdout) as YtDlpPlaylist;
		} catch {
			throw new PlaylistError('YouTube returned something that was not a playlist', 502);
		}

		const entries = parsed.entries ?? [];
		if (entries.length === 0) {
			throw new PlaylistError('That playlist is empty, private, or unavailable', 422);
		}

		const tracks: PlaylistTrack[] = entries.flatMap((entry) => {
			if (!entry.title) return [];
			const track = parseYoutubeEntry(entry.title, entry.channel ?? entry.uploader ?? null);
			return [
				{
					title: track.title,
					artists: track.artists,
					album: null,
					year: null,
					durationMs: typeof entry.duration === 'number' ? entry.duration * 1000 : null,
					isrc: null
				}
			];
		});

		const declared =
			typeof parsed.playlist_count === 'number' ? parsed.playlist_count : tracks.length;

		return {
			playlist: {
				provider: 'youtube',
				id,
				url: url.toString(),
				title: parsed.title?.trim() || 'YouTube playlist',
				description: parsed.description?.trim() || null,
				owner: parsed.channel ?? parsed.uploader ?? null,
				coverUrl: parsed.thumbnails?.at(-1)?.url ?? null,
				trackCount: Math.max(declared, tracks.length)
			},
			tracks,
			truncated: declared > tracks.length
		};
	}
};
