/**
 * yt-dlp adapter.
 *
 * The only external binary in the music path: search returns candidates, a
 * second call resolves the chosen video to a direct audio URL. Everything is
 * spawned with an argument array — no shell — so a track title can never turn
 * into a command.
 */
import { execFile } from 'node:child_process';
import { createChildLogger } from '#lib/logging/index.js';
import type { YoutubeCandidate } from './match.js';

const logger = createChildLogger({ module: 'MusicYtDlp', logDomain: 'system' });

const YTDLP_PATH = process.env.YTDLP_PATH ?? 'yt-dlp';
const SEARCH_TIMEOUT_MS = 20_000;
const RESOLVE_TIMEOUT_MS = 25_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export interface ResolvedAudio {
	url: string;
	contentType: string;
	/** Epoch ms from the URL's `expire` parameter, when present. */
	expiresAt: number | null;
}

function run(args: string[], timeout: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(YTDLP_PATH, args, { timeout, maxBuffer: MAX_BUFFER }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

let availability: { checkedAt: number; available: boolean } | null = null;
const AVAILABILITY_TTL_MS = 5 * 60 * 1000;

export async function isYtDlpAvailable(): Promise<boolean> {
	const now = Date.now();
	if (availability && now - availability.checkedAt < AVAILABILITY_TTL_MS) {
		return availability.available;
	}
	try {
		await run(['--version'], 5_000);
		availability = { checkedAt: now, available: true };
	} catch {
		availability = { checkedAt: now, available: false };
	}
	return availability.available;
}

export async function searchYoutube(query: string, limit = 5): Promise<YoutubeCandidate[]> {
	const stdout = await run(
		['--no-warnings', '--flat-playlist', '-J', `ytsearch${limit}:${query}`],
		SEARCH_TIMEOUT_MS
	);

	const parsed = JSON.parse(stdout) as {
		entries?: Array<{
			id?: string;
			title?: string;
			duration?: number | null;
			channel?: string | null;
		}>;
	};

	return (parsed.entries ?? [])
		.filter((entry): entry is { id: string; title: string } & typeof entry => Boolean(entry.id && entry.title))
		.map((entry) => ({
			id: entry.id,
			title: entry.title,
			duration: typeof entry.duration === 'number' ? entry.duration : null,
			channel: entry.channel ?? null
		}));
}

const CONTENT_TYPES: Record<string, string> = {
	m4a: 'audio/mp4',
	webm: 'audio/webm',
	opus: 'audio/ogg',
	mp3: 'audio/mpeg'
};

/** `"<url>|<ext>"` as printed by yt-dlp's `--print`. */
export function parseResolvedAudio(line: string): ResolvedAudio | null {
	const trimmed = line.trim();
	const separator = trimmed.lastIndexOf('|');
	if (separator <= 0) return null;

	const url = trimmed.slice(0, separator).trim();
	const ext = trimmed.slice(separator + 1).trim().toLowerCase();
	if (!url.startsWith('https://')) return null;

	let expiresAt: number | null = null;
	try {
		const expire = new URL(url).searchParams.get('expire');
		if (expire && /^\d+$/.test(expire)) expiresAt = Number(expire) * 1000;
	} catch {
		return null;
	}

	return {
		url,
		contentType: CONTENT_TYPES[ext] ?? 'audio/webm',
		expiresAt
	};
}

export async function resolveAudio(videoId: string): Promise<ResolvedAudio | null> {
	const stdout = await run(
		[
			'--no-warnings',
			'-f',
			'bestaudio[ext=m4a]/bestaudio',
			'--print',
			'%(url)s|%(ext)s',
			`https://www.youtube.com/watch?v=${videoId}`
		],
		RESOLVE_TIMEOUT_MS
	);

	const firstLine = stdout.split('\n').find((line) => line.trim().length > 0) ?? '';
	const resolved = parseResolvedAudio(firstLine);
	if (!resolved) {
		logger.warn({ videoId }, '[MusicYtDlp] yt-dlp printed no usable audio URL');
	}
	return resolved;
}
