import parseTorrent from 'parse-torrent';

export interface EpisodePointerTarget {
	season?: number;
	episode: number;
	token: string;
}

export interface EpisodePointerFileSelection {
	fileIndices: number[];
	allFileIndices: number[];
	filePaths: string[];
	/** Episode numbers whose files were selected (sorted, unique). */
	matchedEpisodes: number[];
	/** Total size in bytes of the selected files, when the torrent carries lengths. */
	selectedSize?: number;
}

interface TorrentFileEntry {
	index: number;
	path: string;
	length?: number;
}

const EPISODE_POINTER_TITLE_REGEX = /\[Episode Pointer\s+((?:S\d{2})?E\d{2})\]/i;
const EPISODE_POINTER_GUID_REGEX = /::episode-pointer::((?:s\d{2})?e\d{2})$/i;
const HUMAN_EPISODE_POINTER_REGEX = /^Season\s+(\d{1,2})\s+Episode\s+(\d{1,2})\s*-\s*/i;
const HUMAN_EPISODE_ONLY_POINTER_REGEX = /^Episode\s+(\d{1,2})\s*-\s*/i;
const MEDIA_EXTENSIONS = new Set([
	'mkv',
	'mp4',
	'avi',
	'mov',
	'm4v',
	'ts',
	'm2ts',
	'wmv',
	'flv',
	'webm',
	'srt',
	'ass',
	'ssa',
	'vtt',
	'sub'
]);

function normalizePath(value: string): string {
	return value.replace(/\\/g, '/').trim();
}

function getExtension(value: string): string {
	const dotIndex = value.lastIndexOf('.');
	if (dotIndex <= 0 || dotIndex >= value.length - 1) {
		return '';
	}
	return value.slice(dotIndex + 1).toLowerCase();
}

/**
 * Canonical token form: `S01E07`, or `E07` when the season is unknown.
 * Inverse of parsePointerToken; the only place the format is spelled.
 */
export function formatEpisodePointerToken(season: number | undefined, episode: number): string {
	const padded = String(episode).padStart(2, '0');
	return season === undefined ? `E${padded}` : `S${String(season).padStart(2, '0')}E${padded}`;
}

function parsePointerToken(rawToken: string): EpisodePointerTarget | null {
	const normalized = rawToken.trim().toUpperCase();
	const seasonEpisode = normalized.match(/^S(\d{2})E(\d{2})$/);
	if (seasonEpisode) {
		const season = parseInt(seasonEpisode[1], 10);
		const episode = parseInt(seasonEpisode[2], 10);
		return { season, episode, token: formatEpisodePointerToken(season, episode) };
	}

	const episodeOnly = normalized.match(/^E(\d{2})$/);
	if (!episodeOnly) {
		return null;
	}

	const episode = parseInt(episodeOnly[1], 10);
	return { episode, token: formatEpisodePointerToken(undefined, episode) };
}

function detectSeasonFromPath(path: string): number | undefined {
	const normalized = path.toLowerCase();
	const seasonMatches = [
		normalized.match(/(?:^|[^a-z0-9])s(?:eason)?\s*0?(\d{1,2})(?:[^a-z0-9]|$)/i),
		normalized.match(/(?:^|[^a-z0-9])season[\s._-]*0?(\d{1,2})(?:[^a-z0-9]|$)/i)
	];

	for (const match of seasonMatches) {
		if (match?.[1]) {
			return parseInt(match[1], 10);
		}
	}

	return undefined;
}

function includesEpisodeToken(path: string, season: number | undefined, episode: number): boolean {
	const normalized = path.toLowerCase();
	const episodePadded = String(episode).padStart(2, '0');

	if (season !== undefined) {
		const seasonPadded = String(season).padStart(2, '0');
		const seasonPatterns = [
			new RegExp(`(?:^|[^a-z0-9])s0?${season}[^a-z0-9]?e0?${episode}(?:[^a-z0-9]|$)`, 'i'),
			new RegExp(`(?:^|[^a-z0-9])s${seasonPadded}[^a-z0-9]*e${episodePadded}(?:[^a-z0-9]|$)`, 'i'),
			new RegExp(`(?:^|[^a-z0-9])${season}x0?${episode}(?:[^a-z0-9]|$)`, 'i'),
			new RegExp(`(?:^|[^a-z0-9])${seasonPadded}x${episodePadded}(?:[^a-z0-9]|$)`, 'i')
		];

		if (seasonPatterns.some((pattern) => pattern.test(normalized))) {
			return true;
		}
	}

	const episodePatterns = [
		new RegExp(`(?:^|[^a-z0-9])e(?:p(?:isode)?)?\\s*0?${episode}(?:[^a-z0-9]|$)`, 'i'),
		new RegExp(`(?:^|[^a-z0-9])${episodePadded}(?:[^a-z0-9]|$)`, 'i')
	];

	return episodePatterns.some((pattern) => pattern.test(normalized));
}

function normalizeTargets(
	target: EpisodePointerTarget | EpisodePointerTarget[]
): EpisodePointerTarget[] {
	const list = Array.isArray(target) ? target : [target];
	const seen = new Set<string>();
	const targets: EpisodePointerTarget[] = [];

	for (const entry of list) {
		const key = `${entry.season ?? ''}:${entry.episode}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		targets.push(entry);
	}

	return targets;
}

function matchEpisodeFiles(
	files: TorrentFileEntry[],
	target: EpisodePointerTarget | EpisodePointerTarget[]
): EpisodePointerFileSelection {
	const targets = normalizeTargets(target);
	const mediaFiles = files.filter((file) => MEDIA_EXTENSIONS.has(getExtension(file.path)));
	const include = new Map<number, TorrentFileEntry>();
	const matchedEpisodes = new Set<number>();

	for (const entry of targets) {
		let matchedTarget = false;

		for (const file of mediaFiles) {
			const normalizedPath = normalizePath(file.path);
			if (!includesEpisodeToken(normalizedPath, entry.season, entry.episode)) {
				continue;
			}

			if (entry.season !== undefined) {
				const detectedSeason = detectSeasonFromPath(normalizedPath);
				if (detectedSeason !== undefined && detectedSeason !== entry.season) {
					continue;
				}
			}

			include.set(file.index, { ...file, path: normalizedPath });
			matchedEpisodes.add(entry.episode);
			matchedTarget = true;
		}

		// Fallback: episode number in filename with matching season folder.
		// Runs per target so a pack that names files numerically still selects
		// every wanted episode, not just the first one.
		if (matchedTarget || entry.season === undefined) {
			continue;
		}

		for (const file of mediaFiles) {
			const normalizedPath = normalizePath(file.path);
			const detectedSeason = detectSeasonFromPath(normalizedPath);
			if (detectedSeason !== entry.season) {
				continue;
			}

			const segments = normalizedPath.split('/');
			const fileName = segments[segments.length - 1] || '';
			const firstNumber = fileName.match(/^(?:[^0-9]*)(\d{1,2})(?:[^0-9]|$)/);
			if (!firstNumber) {
				continue;
			}
			if (parseInt(firstNumber[1], 10) !== entry.episode) {
				continue;
			}

			include.set(file.index, { ...file, path: normalizedPath });
			matchedEpisodes.add(entry.episode);
		}
	}

	const selected = Array.from(include.values()).sort((a, b) => a.index - b.index);
	const totalSize = selected.reduce(
		(sum, file) => sum + (typeof file.length === 'number' ? file.length : 0),
		0
	);
	const hasKnownSize = selected.some((file) => typeof file.length === 'number');

	return {
		fileIndices: selected.map((file) => file.index),
		allFileIndices: files.map((file) => file.index),
		filePaths: selected.map((file) => file.path),
		matchedEpisodes: Array.from(matchedEpisodes).sort((a, b) => a - b),
		selectedSize: hasKnownSize ? totalSize : undefined
	};
}

export function buildEpisodePointerFileSelectionFromPaths(
	paths: string[],
	target: EpisodePointerTarget | EpisodePointerTarget[]
): EpisodePointerFileSelection {
	const files: TorrentFileEntry[] = paths
		.map((path, index) => ({ index, path: normalizePath(path) }))
		.filter((file) => file.path.length > 0);

	return matchEpisodeFiles(files, target);
}

export function parseEpisodePointerFromTitle(
	title: string | undefined
): EpisodePointerTarget | null {
	if (!title) {
		return null;
	}

	const humanMatch = title.match(HUMAN_EPISODE_POINTER_REGEX);
	if (humanMatch?.[1] && humanMatch?.[2]) {
		const season = parseInt(humanMatch[1], 10);
		const episode = parseInt(humanMatch[2], 10);
		return { season, episode, token: formatEpisodePointerToken(season, episode) };
	}

	const episodeOnlyMatch = title.match(HUMAN_EPISODE_ONLY_POINTER_REGEX);
	if (episodeOnlyMatch?.[1]) {
		const episode = parseInt(episodeOnlyMatch[1], 10);
		return { episode, token: formatEpisodePointerToken(undefined, episode) };
	}

	const match = title.match(EPISODE_POINTER_TITLE_REGEX);
	if (!match?.[1]) {
		return null;
	}

	return parsePointerToken(match[1]);
}

export function parseEpisodePointerFromGuid(guid: string | undefined): EpisodePointerTarget | null {
	if (!guid) {
		return null;
	}

	const match = guid.match(EPISODE_POINTER_GUID_REGEX);
	if (!match?.[1]) {
		return null;
	}

	return parsePointerToken(match[1]);
}

export async function buildEpisodePointerFileSelection(
	torrentFile: Buffer,
	target: EpisodePointerTarget | EpisodePointerTarget[]
): Promise<EpisodePointerFileSelection> {
	const parsed = await parseTorrent(Buffer.from(torrentFile));
	if (
		!parsed ||
		!('files' in parsed) ||
		!Array.isArray(parsed.files) ||
		parsed.files.length === 0
	) {
		return {
			fileIndices: [],
			allFileIndices: [],
			filePaths: [],
			matchedEpisodes: []
		};
	}

	const parsedFiles = parsed.files as Array<{ path?: string; name?: string; length?: number }>;
	const files: TorrentFileEntry[] = parsedFiles
		.map((file, index) => ({
			index,
			path: normalizePath(String(file.path || file.name || '')),
			length: typeof file.length === 'number' ? file.length : undefined
		}))
		.filter((file) => file.path.length > 0);

	return matchEpisodeFiles(files, target);
}
