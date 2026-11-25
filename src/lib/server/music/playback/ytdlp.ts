/**
 * yt-dlp adapter.
 *
 * The only external binary in the music path: search returns candidates, a
 * second call resolves the chosen video to a direct audio URL. Everything is
 * spawned with an argument array — no shell — so a track title can never turn
 * into a command.
 *
 * The binary is a managed dependency, not a prerequisite a self-hoster is
 * expected to satisfy: without it every stream-backed track answers "Track is
 * not playable", which reads as a broken track rather than a missing tool. It
 * is resolved from `YTDLP_PATH`, then a copy Cinephage keeps in its data
 * directory, then `yt-dlp` on PATH — and if none of those exist, downloaded
 * once into the data directory and checksum-verified against the pinned
 * release before it is ever executed.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createChildLogger } from '#lib/logging/index.js';
import type { YoutubeCandidate } from './match.js';

const logger = createChildLogger({ module: 'MusicYtDlp', logDomain: 'system' });

/** Pinned: the version this adapter has been exercised against. */
const MANAGED_VERSION = '2026.10.26';
const MANAGED_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${MANAGED_VERSION}/yt-dlp`;
const MANAGED_SHA256 = 'e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3';
const MANAGED_PATH = path.resolve(process.env.DATA_DIR ?? 'data', 'tools', 'yt-dlp');
const CONFIGURED_PATH = process.env.YTDLP_PATH ?? null;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const SEARCH_TIMEOUT_MS = 20_000;
const RESOLVE_TIMEOUT_MS = 25_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export interface ResolvedAudio {
	url: string;
	contentType: string;
	/** Epoch ms from the URL's `expire` parameter, when present. */
	expiresAt: number | null;
}

function spawn(binary: string, args: string[], timeout: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(binary, args, { timeout, maxBuffer: MAX_BUFFER }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

async function binaryWorks(candidate: string): Promise<boolean> {
	try {
		await spawn(candidate, ['--version'], 5_000);
		return true;
	} catch {
		return false;
	}
}

/**
 * Fetch the pinned release into the data directory.
 *
 * Written next to its final name and renamed into place, so a half-downloaded
 * file can never be executed, and the checksum is checked before the rename:
 * an auto-downloaded binary is only acceptable if it is the bytes we pinned.
 */
async function installManagedCopy(): Promise<boolean> {
	try {
		const response = await fetch(MANAGED_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
		if (!response.ok) {
			logger.warn({ status: response.status }, '[MusicYtDlp] could not download yt-dlp');
			return false;
		}
		const bytes = Buffer.from(await response.arrayBuffer());
		const digest = createHash('sha256').update(bytes).digest('hex');
		if (digest !== MANAGED_SHA256) {
			logger.error(
				{ expected: MANAGED_SHA256, actual: digest },
				'[MusicYtDlp] downloaded yt-dlp does not match the pinned checksum; refusing to run it'
			);
			return false;
		}
		await mkdir(path.dirname(MANAGED_PATH), { recursive: true });
		const staging = `${MANAGED_PATH}.download`;
		await writeFile(staging, bytes, { mode: 0o755 });
		await chmod(staging, 0o755);
		await rename(staging, MANAGED_PATH);
		logger.info({ path: MANAGED_PATH, version: MANAGED_VERSION, bytes: bytes.length }, '[MusicYtDlp] installed managed yt-dlp');
		return true;
	} catch (err) {
		logger.warn({ err: err instanceof Error ? err.message : String(err) }, '[MusicYtDlp] yt-dlp install failed');
		return false;
	}
}

let resolved: { at: number; path: string | null } | null = null;
/** A failed resolution is worth retrying; a machine that was offline may not be. */
const RESOLVE_TTL_MS = 10 * 60 * 1000;

/**
 * Where yt-dlp is, installing the managed copy if the machine has none.
 *
 * Order is deliberate: an operator's `YTDLP_PATH` wins, the managed copy is
 * next because it is the one this code was tested against, and a system binary
 * on PATH is the fallback for anyone already maintaining their own.
 */
export async function resolveYtDlp(): Promise<string | null> {
	const now = Date.now();
	if (resolved && now - resolved.at < RESOLVE_TTL_MS) return resolved.path;

	for (const candidate of [CONFIGURED_PATH, MANAGED_PATH, 'yt-dlp']) {
		if (candidate && (await binaryWorks(candidate))) {
			resolved = { at: now, path: candidate };
			return candidate;
		}
	}

	if (await installManagedCopy()) {
		if (await binaryWorks(MANAGED_PATH)) {
			resolved = { at: now, path: MANAGED_PATH };
			return MANAGED_PATH;
		}
	}

	logger.warn('[MusicYtDlp] yt-dlp is unavailable; stream-backed tracks cannot play until it is');
	resolved = { at: now, path: null };
	return null;
}

async function run(args: string[], timeout: number): Promise<string> {
	const binary = await resolveYtDlp();
	if (!binary) throw new Error('yt-dlp is not available');
	return spawn(binary, args, timeout);
}

export async function isYtDlpAvailable(): Promise<boolean> {
	return (await resolveYtDlp()) !== null;
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
