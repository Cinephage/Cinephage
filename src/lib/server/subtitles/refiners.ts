/**
 * Release Parsing and Refiners - Based on Bazarr/Subliminal architecture
 *
 * Uses guessit for parsing release names to extract:
 * - Source (BluRay, Web, HDTV)
 * - Release group
 * - Resolution
 * - Video/Audio codecs
 * - Streaming service
 */

import type {
	Video,
	VideoSource,
	VideoResolution,
	VideoCodec,
	AudioCodec,
	StreamingService
} from './video';
import { Movie, Episode } from './video';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });

/**
 * Guessit result interface (based on guessit output)
 */
export interface GuessitResult {
	title?: string;
	year?: number;
	season?: number;
	episode?: number | number[];
	episode_title?: string;
	type?: 'movie' | 'episode';
	release_group?: string;
	source?: string;
	screen_size?: string;
	video_codec?: string;
	audio_codec?: string;
	streaming_service?: string;
	edition?: string;
	proper?: boolean;
	repack?: boolean;
	container?: string;
	mimetype?: string;
	language?: string | string[];
	subtitle_language?: string | string[];
}

/**
 * Parse a release name using guessit
 *
 * Uses guessit-js WASM package for accurate parsing
 */
export async function parseReleaseName(releaseName: string): Promise<GuessitResult> {
	try {
		// Dynamic import guessit-js WASM package
		const { guess } = await import('guessit-js');
		const result = await guess(releaseName);
		return result as GuessitResult;
	} catch (error) {
		// Fallback to basic regex parsing if guessit not available
		logger.debug(
			{
				error: error instanceof Error ? error.message : String(error)
			},
			'Guessit not available, using fallback parser'
		);
		return parseReleaseNameFallback(releaseName);
	}
}

/**
 * Fallback release name parser (regex-based)
 */
export function parseReleaseNameFallback(releaseName: string): GuessitResult {
	const result: GuessitResult = {};

	// Normalize
	const normalized = releaseName.replace(/\./g, ' ').replace(/_/g, ' ').replace(/-/g, ' ').trim();

	// Detect type and extract season/episode
	const episodeMatch = normalized.match(/[Ss](\d{1,2})[Ee](\d{1,2})(?:[Ee](\d{1,2}))?/);
	if (episodeMatch) {
		result.type = 'episode';
		result.season = parseInt(episodeMatch[1], 10);
		result.episode = episodeMatch[3]
			? [parseInt(episodeMatch[2], 10), parseInt(episodeMatch[3], 10)]
			: parseInt(episodeMatch[2], 10);
	} else {
		result.type = 'movie';
	}

	// Extract year
	const yearMatch = normalized.match(/\b(19\d{2}|20\d{2})\b/);
	if (yearMatch) {
		result.year = parseInt(yearMatch[1], 10);
	}

	// Extract resolution
	const resolutionMatch = normalized.match(/\b(2160p|1080p|1080i|720p|576p|480p|4K|UHD)\b/i);
	if (resolutionMatch) {
		result.screen_size = resolutionMatch[1].toLowerCase();
	}

	// Extract source
	const sourcePatterns: Array<[RegExp, string]> = [
		[/\b(?:blu[\s-]?ray|bdrip|brrip)\b/i, 'BluRay'],
		[/\b(?:web[\s-]?dl|webrip|web)\b/i, 'Web'],
		[/\b(?:hdtv|pdtv|dsr|dvb)\b/i, 'HDTV'],
		[/\b(?:dvd(?:rip|scr)?)\b/i, 'DVD'],
		[/\b(?:cam(?:rip)?|ts|telesync)\b/i, 'CAM'],
		[/\bscreener\b/i, 'Screener']
	];

	for (const [pattern, source] of sourcePatterns) {
		if (pattern.test(normalized)) {
			result.source = source;
			break;
		}
	}

	// Extract video codec
	const codecPatterns: Array<[RegExp, string]> = [
		[/\b(?:hevc|h[\s.]?265|x265)\b/i, 'HEVC'],
		[/\b(?:avc|h[\s.]?264|x264)\b/i, 'H.264'],
		[/\bxvid\b/i, 'XviD'],
		[/\bdivx\b/i, 'DivX'],
		[/\bvp9\b/i, 'VP9'],
		[/\bav1\b/i, 'AV1']
	];

	for (const [pattern, codec] of codecPatterns) {
		if (pattern.test(normalized)) {
			result.video_codec = codec;
			break;
		}
	}

	// Extract audio codec
	const audioPatterns: Array<[RegExp, string]> = [
		[/\b(?:dts[\s-]?hd[\s-]?ma)\b/i, 'DTS-HD MA'],
		[/\b(?:dts[\s-]?hd)\b/i, 'DTS-HD'],
		[/\bdts\b/i, 'DTS'],
		[/\b(?:truehd|true[\s-]?hd)\b/i, 'TrueHD'],
		[/\b(?:atmos)\b/i, 'Dolby Atmos'],
		[/\b(?:ddp|dd\+|dolby digital plus|e[\s-]?ac3)\b/i, 'DD+'],
		[/\b(?:dd|dolby digital|ac3)\b/i, 'DD'],
		[/\baac\b/i, 'AAC'],
		[/\bflac\b/i, 'FLAC'],
		[/\bmp3\b/i, 'MP3']
	];

	for (const [pattern, codec] of audioPatterns) {
		if (pattern.test(normalized)) {
			result.audio_codec = codec;
			break;
		}
	}

	// Extract streaming service
	const streamingPatterns: Array<[RegExp, string]> = [
		[/\b(?:netflix|nf)\b/i, 'Netflix'],
		[/\b(?:amazon|amzn|prime)\b/i, 'Amazon Prime'],
		[/\b(?:disney\+?|dsnp)\b/i, 'Disney+'],
		[/\b(?:apple|atvp|atv\+)\b/i, 'Apple TV+'],
		[/\b(?:hbo|hmax)\b/i, 'HBO Max'],
		[/\b(?:hulu)\b/i, 'Hulu'],
		[/\b(?:peacock|pcok)\b/i, 'Peacock'],
		[/\b(?:paramount\+?|p\+)\b/i, 'Paramount+'],
		[/\b(?:crunchyroll|cr)\b/i, 'Crunchyroll'],
		[/\b(?:funimation|funi)\b/i, 'Funimation']
	];

	for (const [pattern, service] of streamingPatterns) {
		if (pattern.test(normalized)) {
			result.streaming_service = service;
			break;
		}
	}

	// Extract release group (usually at the end after a dash)
	const groupMatch = releaseName.match(/[-]([A-Za-z0-9]+)(?:\.[a-z]{2,4})?$/);
	if (groupMatch) {
		// Filter out common false positives
		const group = groupMatch[1];
		if (!/^(?:x264|x265|HEVC|AAC|DTS|AC3|WEB|HDTV|BluRay|mkv|mp4|avi)$/i.test(group)) {
			result.release_group = group;
		}
	}

	// Extract title
	const titleEndPatterns = [
		/[Ss]\d{1,2}[Ee]\d{1,2}/,
		/\b(19|20)\d{2}\b/,
		/\b(2160p|1080p|720p|480p)\b/i,
		/\b(bluray|web|hdtv|dvd)\b/i
	];

	let titleEnd = normalized.length;
	for (const pattern of titleEndPatterns) {
		const match = normalized.match(pattern);
		if (match && match.index && match.index < titleEnd) {
			titleEnd = match.index;
		}
	}

	const title = normalized.substring(0, titleEnd).trim();
	if (title) {
		result.title = title;
	}

	return result;
}

/**
 * Refine a Video object with parsed release information
 */
export async function refineVideo(video: Video, releaseName?: string): Promise<Video> {
	const nameToparse = releaseName ?? video.originalPath;
	if (!nameToparse) return video;

	try {
		const parsed = await parseReleaseName(nameToparse);

		// Map source
		if (parsed.source) {
			video.source = mapSource(parsed.source);
		}

		// Map resolution
		if (parsed.screen_size) {
			video.resolution = mapResolution(parsed.screen_size);
		}

		// Map video codec
		if (parsed.video_codec) {
			video.videoCodec = mapVideoCodec(parsed.video_codec);
		}

		// Map audio codec
		if (parsed.audio_codec) {
			video.audioCodec = mapAudioCodec(parsed.audio_codec);
		}

		// Set streaming service
		if (parsed.streaming_service) {
			video.streamingService = mapStreamingService(parsed.streaming_service);
		}

		// Set release group
		if (parsed.release_group) {
			video.releaseGroup = parsed.release_group;
		}

		// Set edition
		if (parsed.edition) {
			video.edition = parsed.edition;
		}
	} catch (error) {
		logger.debug(
			{
				error: error instanceof Error ? error.message : String(error)
			},
			'Failed to refine video'
		);
	}

	return video;
}

/**
 * Map guessit source to VideoSource
 */
function mapSource(source: string): VideoSource {
	const mapping: Record<string, VideoSource> = {
		BluRay: 'BluRay',
		'Blu-ray': 'BluRay',
		Web: 'Web',
		'WEB-DL': 'Web',
		WEBRip: 'Web',
		HDTV: 'HDTV',
		PDTV: 'PDTV',
		DVD: 'DVD',
		DVDRip: 'DVD',
		CAM: 'CAM',
		Screener: 'Screener',
		VOD: 'VOD'
	};
	return mapping[source] ?? 'unknown';
}

/**
 * Map guessit resolution to VideoResolution
 */
function mapResolution(resolution: string): VideoResolution {
	const normalized = resolution.toLowerCase();
	if (normalized.includes('2160') || normalized === '4k' || normalized === 'uhd') return '2160p';
	if (normalized.includes('1080p')) return '1080p';
	if (normalized.includes('1080i')) return '1080i';
	if (normalized.includes('720')) return '720p';
	if (normalized.includes('576')) return '576p';
	if (normalized.includes('480')) return '480p';
	if (normalized.includes('360')) return '360p';
	return 'unknown';
}

/**
 * Map guessit video codec to VideoCodec
 */
function mapVideoCodec(codec: string): VideoCodec {
	const mapping: Record<string, VideoCodec> = {
		HEVC: 'H.265',
		'H.265': 'H.265',
		x265: 'H.265',
		'H.264': 'H.264',
		x264: 'H.264',
		AVC: 'H.264',
		'MPEG-4': 'MPEG-4',
		'MPEG-2': 'MPEG-2',
		XviD: 'XviD',
		DivX: 'DivX',
		'VC-1': 'VC-1',
		VP9: 'VP9',
		AV1: 'AV1'
	};
	return mapping[codec] ?? 'unknown';
}

/**
 * Map guessit audio codec to AudioCodec
 */
function mapAudioCodec(codec: string): AudioCodec {
	const mapping: Record<string, AudioCodec> = {
		'DTS-HD MA': 'DTS-HD MA',
		'DTS-HD': 'DTS-HD',
		DTS: 'DTS',
		TrueHD: 'TrueHD',
		'Dolby Atmos': 'Dolby Atmos',
		'DD+': 'DD+',
		'E-AC3': 'DD+',
		DD: 'DD',
		AC3: 'DD',
		AAC: 'AAC',
		FLAC: 'FLAC',
		MP3: 'MP3',
		PCM: 'PCM',
		Opus: 'Opus'
	};
	return mapping[codec] ?? 'unknown';
}

/**
 * Map streaming service name to StreamingService
 */
function mapStreamingService(service: string): StreamingService {
	const mapping: Record<string, StreamingService> = {
		Netflix: 'Netflix',
		'Amazon Prime': 'Amazon Prime',
		Amazon: 'Amazon Prime',
		'Disney+': 'Disney+',
		'Disney Plus': 'Disney+',
		'Apple TV+': 'Apple TV+',
		'AppleTV+': 'Apple TV+',
		'HBO Max': 'HBO Max',
		Hulu: 'Hulu',
		Peacock: 'Peacock',
		'Paramount+': 'Paramount+',
		Crunchyroll: 'Crunchyroll',
		Funimation: 'Funimation'
	};
	return mapping[service] ?? 'unknown';
}

/**
 * Create a Video from a filename/path
 */
export async function videoFromPath(filePath: string): Promise<Video> {
	const parsed = await parseReleaseName(filePath);

	if (parsed.type === 'episode' && parsed.season !== undefined) {
		const episode = new Episode(
			filePath,
			parsed.title ?? 'Unknown',
			parsed.season,
			parsed.episode ?? 1,
			{
				title: parsed.episode_title,
				year: parsed.year
			}
		);
		return refineVideo(episode, filePath);
	} else {
		const movie = new Movie(filePath, parsed.title ?? 'Unknown', {
			year: parsed.year
		});
		return refineVideo(movie, filePath);
	}
}

/**
 * Extract release info for matching
 */
export function extractReleaseInfo(releaseName: string): ReleaseInfo {
	const parsed = parseReleaseNameFallback(releaseName);

	return {
		source: parsed.source,
		resolution: parsed.screen_size,
		videoCodec: parsed.video_codec,
		audioCodec: parsed.audio_codec,
		releaseGroup: parsed.release_group,
		streamingService: parsed.streaming_service,
		isProper: parsed.proper ?? false,
		isRepack: parsed.repack ?? false
	};
}

/**
 * Release info interface
 */
export interface ReleaseInfo {
	source?: string;
	resolution?: string;
	videoCodec?: string;
	audioCodec?: string;
	releaseGroup?: string;
	streamingService?: string;
	isProper: boolean;
	isRepack: boolean;
}

/**
 * Compare release info for matching
 */
export function releaseInfoMatches(a: ReleaseInfo, b: ReleaseInfo): boolean {
	// Check source match
	if (a.source && b.source && a.source !== b.source) return false;

	// Check release group match (case insensitive)
	if (a.releaseGroup && b.releaseGroup) {
		if (a.releaseGroup.toLowerCase() !== b.releaseGroup.toLowerCase()) return false;
	}

	return true;
}
