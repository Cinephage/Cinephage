import type { PlaybackSession, PlaybackSessionSubtitle, SessionResourceKind } from '../types';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';
import { resolveHlsUrl } from '../utils/hls-rewrite.js';
import {
	languageSatisfies,
	matchesRequirement
} from '#lib/server/subtitles/requirement-matcher.js';
import { normalizeLanguageCode } from '#lib/shared/languages.js';

/**
 * Index of the track that should carry DEFAULT=YES, chosen from the item's
 * effective subtitle requirements.
 *
 * Requirement-aware mode (full tuple: language + variant + accessibility via
 * the shared matcher): the first track satisfying the highest-priority
 * requirement wins. Legacy mode (language list only, sessions created before
 * requirement snapshots existed): the first track whose language satisfies the
 * preferred language. Returns null when nothing matches so the caller falls
 * back to the provider default / first-track rule.
 */
export function pickDefaultSubtitleIndex(
	subtitles: PlaybackSessionSubtitle[],
	preferredLanguages?: string[],
	preferredRequirements?: SubtitleRequirement[]
): number | null {
	if (preferredRequirements?.length) {
		for (const requirement of preferredRequirements) {
			const index = subtitles.findIndex((subtitle) =>
				matchesRequirement(
					{
						language: subtitle.language,
						isForced: subtitle.isForced,
						isHearingImpaired: subtitle.isHearingImpaired
					},
					requirement
				)
			);
			if (index >= 0) return index;
		}
		return null;
	}

	if (!preferredLanguages?.length) return null;

	const normalized = subtitles.map((subtitle) => ({
		subtitle,
		language: normalizeLanguageCode(subtitle.language || '')
	}));

	for (const preferred of preferredLanguages) {
		const match = normalized.find(({ language }) => languageSatisfies(language, preferred));
		if (match) {
			return subtitles.indexOf(match.subtitle);
		}
	}
	return null;
}

interface RewritePlaylistOptions {
	playlist: string;
	playlistUrl: string;
	baseUrl: string;
	session: PlaybackSession;
	apiKey?: string;
	registerResource: (
		url: string,
		kind: SessionResourceKind,
		extension: string,
		segmentFallbackExtension?: string
	) => string;
	injectSubtitles?: boolean;
	segmentFallbackExtension?: string;
}

const URI_ATTRIBUTE_TAGS = {
	'#EXT-X-MEDIA:': 'playlist',
	'#EXT-X-KEY:': 'asset',
	'#EXT-X-MAP:': 'segment',
	'#EXT-X-I-FRAME-STREAM-INF:': 'playlist',
	'#EXT-X-PART:': 'segment',
	'#EXT-X-PRELOAD-HINT:': 'segment',
	'#EXT-X-RENDITION-REPORT:': 'playlist'
} as const;

function inferExtension(url: string, fallback: string): string {
	try {
		const pathname = new URL(url).pathname;
		const lastSegment = pathname.split('/').pop() ?? '';
		const match = lastSegment.match(/\.([a-zA-Z0-9]+)$/);
		return match?.[1]?.toLowerCase() ?? fallback;
	} catch {
		return fallback;
	}
}

const SAFE_SEGMENT_EXTENSIONS = new Set(['ts', 'm4s', 'mp4', 'aac', 'mp3', 'vtt', 'webvtt']);

function normalizeSessionExtension(kind: SessionResourceKind, extension: string): string {
	const normalized = extension.replace(/^\./, '').toLowerCase();

	if (kind === 'playlist') {
		return 'm3u8';
	}

	if (kind === 'segment') {
		return SAFE_SEGMENT_EXTENSIONS.has(normalized) ? normalized : 'ts';
	}

	return normalized || 'bin';
}

function inferResourceKind(url: string, previousWasExtinf: boolean): SessionResourceKind {
	const normalized = url.toLowerCase();
	if (previousWasExtinf) {
		return 'segment';
	}
	if (
		normalized.includes('.m3u8') ||
		normalized.includes('.txt') ||
		normalized.includes('playlist') ||
		normalized.includes('index.m3u8')
	) {
		return 'playlist';
	}
	if (
		normalized.includes('.ts') ||
		normalized.includes('.m4s') ||
		normalized.includes('.jpg') ||
		normalized.includes('.jpeg') ||
		normalized.includes('.mp4') ||
		normalized.includes('.aac')
	) {
		return 'segment';
	}
	return 'asset';
}

/**
 * Resolve a session path against the configured base URL while PRESERVING any
 * reverse-proxy subpath (`https://host/cinephage` -> `.../cinephage/api/...`).
 * A leading-slash `new URL('/api', base)` would silently drop the subpath.
 */
function resolveAgainstBase(baseUrl: string, path: string): URL {
	const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
	return new URL(path.replace(/^\/+/, ''), normalizedBase);
}

function buildSessionUrl(
	baseUrl: string,
	token: string,
	resourceId: string,
	kind: SessionResourceKind,
	extension: string,
	apiKey?: string
): string {
	let path: string;
	if (kind === 'playlist') {
		path = `/api/streaming/session/${token}/playlist/${resourceId}.m3u8`;
	} else if (kind === 'segment') {
		path = `/api/streaming/session/${token}/segment/${resourceId}.${extension}`;
	} else {
		path = `/api/streaming/session/${token}/asset/${resourceId}`;
	}

	const url = resolveAgainstBase(baseUrl, path);
	if (apiKey) {
		url.searchParams.set('api_key', apiKey);
	}
	return url.toString();
}

function buildSubtitlePlaylistUrl(
	baseUrl: string,
	token: string,
	subtitleId: string,
	apiKey?: string
): string {
	const url = resolveAgainstBase(
		baseUrl,
		`/api/streaming/session/${token}/subtitle/${subtitleId}.m3u8`
	);
	if (apiKey) {
		url.searchParams.set('api_key', apiKey);
	}
	return url.toString();
}

function injectSubtitleTracks(
	playlist: string,
	baseUrl: string,
	session: PlaybackSession,
	apiKey?: string
): string {
	if (!session.subtitles.length || !playlist.includes('#EXT-X-STREAM-INF')) {
		return playlist;
	}

	const lines = playlist.split('\n');
	const defaultIndex = pickDefaultSubtitleIndex(
		session.subtitles,
		session.preferredSubtitleLanguages,
		session.preferredSubtitleRequirements
	);
	const mediaTags = session.subtitles.map((subtitle, index) => {
		const playlistUrl = buildSubtitlePlaylistUrl(baseUrl, session.token, subtitle.id, apiKey);
		const isDefault =
			defaultIndex !== null ? index === defaultIndex : subtitle.isDefault || index === 0;
		// Strip CR/LF and escape backslashes/quotes so provider metadata cannot
		// inject HLS attributes or break the playlist.
		const label = subtitle.label
			.replace(/[\r\n]+/g, ' ')
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"');
		const language = (subtitle.language || 'und')
			.replace(/[\r\n]+/g, '')
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"');
		return `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="cinephage-subs",NAME="${label}",DEFAULT=${isDefault ? 'YES' : 'NO'},AUTOSELECT=YES,FORCED=${subtitle.isForced ? 'YES' : 'NO'},LANGUAGE="${language}",URI="${playlistUrl}"`;
	});

	const withMediaTags: string[] = [];
	let inserted = false;
	for (const line of lines) {
		withMediaTags.push(line);
		if (!inserted && line.trim() === '#EXTM3U') {
			withMediaTags.push(...mediaTags);
			inserted = true;
		}
	}

	return withMediaTags
		.map((line) => {
			if (line.startsWith('#EXT-X-STREAM-INF:') && !line.includes('SUBTITLES=')) {
				return `${line},SUBTITLES="cinephage-subs"`;
			}
			return line;
		})
		.join('\n');
}

export function rewriteSessionPlaylist(options: RewritePlaylistOptions): string {
	const lines = options.playlist.split('\n');
	const result: string[] = [];
	const base = new URL(options.playlistUrl);
	const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);

	let previousWasExtinf = false;
	let previousWasStreamInf = false;

	for (const line of lines) {
		const trimmed = line.trim();

		const tagEntry = Object.entries(URI_ATTRIBUTE_TAGS).find(([tag]) => trimmed.startsWith(tag));
		if (tagEntry) {
			const uriMatch = line.match(/URI="([^"]+)"/);
			if (uriMatch) {
				const [, originalUri] = uriMatch;
				const absoluteUri = resolveHlsUrl(originalUri, base, basePath);
				const kind = tagEntry[1] as SessionResourceKind;
				const extension = normalizeSessionExtension(
					kind,
					inferExtension(
						absoluteUri,
						kind === 'playlist' ? 'm3u8' : kind === 'segment' ? 'ts' : 'bin'
					)
				);
				const segmentFallbackExtension =
					kind === 'playlist'
						? trimmed.startsWith('#EXT-X-MEDIA:') &&
							/(?:^|[,:])TYPE=SUBTITLES(?:,|$)/i.test(trimmed)
							? 'vtt'
							: options.segmentFallbackExtension
						: undefined;
				const resourceId = options.registerResource(
					absoluteUri,
					kind,
					extension,
					segmentFallbackExtension
				);
				const sessionUrl = buildSessionUrl(
					options.baseUrl,
					options.session.token,
					resourceId,
					kind,
					extension,
					options.apiKey
				);
				result.push(line.replace(`URI="${originalUri}"`, `URI="${sessionUrl}"`));
				previousWasExtinf = false;
				continue;
			}
		}

		if (trimmed.startsWith('#EXTINF:')) {
			result.push(line);
			previousWasExtinf = true;
			previousWasStreamInf = false;
			continue;
		}

		if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
			result.push(line);
			previousWasExtinf = false;
			previousWasStreamInf = true;
			continue;
		}

		if (line.startsWith('#') || trimmed === '') {
			result.push(line);
			continue;
		}

		const absoluteUrl = resolveHlsUrl(trimmed, base, basePath);
		const kind = previousWasStreamInf
			? 'playlist'
			: inferResourceKind(absoluteUrl, previousWasExtinf);
		const extension = normalizeSessionExtension(
			kind,
			inferExtension(
				absoluteUrl,
				kind === 'playlist'
					? 'm3u8'
					: kind === 'segment'
						? (options.segmentFallbackExtension ?? 'ts')
						: 'bin'
			)
		);
		const resourceId = options.registerResource(
			absoluteUrl,
			kind,
			extension,
			kind === 'playlist' ? options.segmentFallbackExtension : undefined
		);
		result.push(
			buildSessionUrl(
				options.baseUrl,
				options.session.token,
				resourceId,
				kind,
				extension,
				options.apiKey
			)
		);
		previousWasExtinf = false;
		previousWasStreamInf = false;
	}

	const rewritten = result.join('\n');

	if (options.injectSubtitles) {
		return injectSubtitleTracks(rewritten, options.baseUrl, options.session, options.apiKey);
	}

	return rewritten;
}
