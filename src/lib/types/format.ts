/**
 * Format Type Definitions for UI
 *
 * These types are used by the custom formats UI components.
 * They mirror the server-side types with additional UI-specific properties.
 */

import type {
	FormatCategory,
	FormatCondition,
	ConditionType,
	Resolution,
	Source,
	Codec,
	AudioCodec,
	AudioChannels,
	HdrFormat
} from '#lib/server/scoring/index.js';

// Re-export server types for convenience
export type {
	FormatCategory,
	FormatCondition,
	ConditionType,
	Resolution,
	Source,
	Codec,
	AudioCodec,
	AudioChannels,
	HdrFormat
};

/**
 * Category labels for display in the UI
 */
export const FORMAT_CATEGORY_LABELS: Record<FormatCategory, string> = {
	resolution: 'Resolution & Source',
	source: 'Source Only',
	release_group_tier: 'Release Groups',
	audio: 'Audio',
	hdr: 'HDR',
	streaming: 'Streaming Services',
	micro: 'Micro Encoders',
	low_quality: 'Low Quality',
	banned: 'Banned',
	enhancement: 'Enhancements',
	codec: 'Codec',
	other: 'Other'
};

/**
 * Category descriptions for tooltips/help text
 */
export const FORMAT_CATEGORY_DESCRIPTIONS: Record<FormatCategory, string> = {
	resolution: 'Resolution and source quality combinations (e.g., 2160p Remux, 1080p WEB-DL)',
	source: 'Source-only fallback formats when resolution cannot be detected',
	release_group_tier: 'Quality tiers for known release groups',
	audio: 'Audio codec formats (TrueHD, DTS-HD MA, Atmos, etc.)',
	hdr: 'HDR formats (Dolby Vision, HDR10+, HDR10, HLG)',
	streaming: 'Streaming service detection (Netflix, Amazon, Apple TV+, etc.)',
	micro: 'Micro encoder groups (Tigole, QxR, YTS, etc.)',
	low_quality: 'Groups with lower quality standards (penalized but not banned)',
	banned: 'Hard-blocked releases (fake, deceptive, unusable sources)',
	enhancement: 'Special editions and quality indicators (Repack, IMAX, etc.)',
	codec: 'Video codec detection (x265, AV1, etc.)',
	other: 'Miscellaneous formats'
};

/**
 * Category display order in the UI
 */
export const FORMAT_CATEGORY_ORDER: FormatCategory[] = [
	'resolution',
	'source',
	'audio',
	'hdr',
	'release_group_tier',
	'streaming',
	'enhancement',
	'codec',
	'micro',
	'low_quality',
	'banned',
	'other'
];

/**
 * Category icons (Lucide icon names)
 */
export const FORMAT_CATEGORY_ICONS: Record<FormatCategory, string> = {
	resolution: 'Monitor',
	source: 'Film',
	release_group_tier: 'Users',
	audio: 'Volume2',
	hdr: 'Sun',
	streaming: 'Tv',
	micro: 'Minimize2',
	low_quality: 'AlertTriangle',
	banned: 'Ban',
	enhancement: 'Sparkles',
	codec: 'FileCode',
	other: 'MoreHorizontal'
};

/**
 * Condition type labels for the UI
 */
export const CONDITION_TYPE_LABELS: Record<ConditionType, string> = {
	resolution: 'Resolution',
	source: 'Source',
	release_title: 'Release Title (Regex)',
	release_group: 'Release Group (Regex)',
	codec: 'Video Codec',
	audio_codec: 'Audio Codec',
	audio_channels: 'Audio Channels',
	audio_atmos: 'Atmos',
	hdr: 'HDR Format',
	streaming_service: 'Streaming Service',
	flag: 'Special Flag',
	indexer: 'Indexer Name',
	language: 'Audio Language'
};

/**
 * Condition type descriptions for help text
 */
export const CONDITION_TYPE_DESCRIPTIONS: Record<ConditionType, string> = {
	resolution: 'Match against the detected resolution (2160p, 1080p, etc.)',
	source: 'Match against the release source (Remux, BluRay, WEB-DL, etc.)',
	release_title: 'Match a regex pattern against the full release title',
	release_group: 'Match a regex pattern against the release group name',
	codec: 'Match against the detected video codec (x265, AV1, etc.)',
	audio_codec: 'Match against the detected audio codec (TrueHD, DTS-HD MA, DD+, etc.)',
	audio_channels: 'Match against the detected audio channel layout (7.1, 5.1, etc.)',
	audio_atmos: 'Match when Dolby Atmos is detected as an audio feature',
	hdr: 'Match against the detected HDR format (Dolby Vision, HDR10+, etc.)',
	streaming_service: 'Match against the detected streaming service (Netflix, Amazon, etc.)',
	flag: 'Match against special release flags (Remux, Repack, Proper, 3D)',
	indexer: 'Match against the indexer name that provided the release (YTS, etc.)',
	language:
		'Match against languages parsed from the release name, incl. the Multi and Original markers'
};

/**
 * Available resolutions for condition matching
 */
export const AVAILABLE_RESOLUTIONS: Resolution[] = ['2160p', '1080p', '720p', '480p', 'unknown'];

/**
 * Resolution labels for the UI
 */
export const RESOLUTION_LABELS: Record<Resolution, string> = {
	'2160p': '4K (2160p)',
	'1080p': 'Full HD (1080p)',
	'720p': 'HD (720p)',
	'480p': 'SD (480p)',
	unknown: 'Unknown'
};

/**
 * Available sources for condition matching
 */
export const AVAILABLE_SOURCES: Source[] = [
	'remux',
	'bluray',
	'hdrip',
	'webdl',
	'webrip',
	'hdtv',
	'dvd',
	'cam',
	'telesync',
	'telecine',
	'screener',
	'unknown'
];

/**
 * Source labels for the UI
 */
export const SOURCE_LABELS: Record<Source, string> = {
	remux: 'Remux',
	bluray: 'BluRay Encode',
	hdrip: 'HDRip',
	webdl: 'WEB-DL',
	webrip: 'WEBRip',
	hdtv: 'HDTV',
	dvd: 'DVD',
	cam: 'CAM',
	telesync: 'Telesync',
	telecine: 'Telecine',
	screener: 'Screener',
	unknown: 'Unknown'
};

/**
 * Available codecs for condition matching
 */
export const AVAILABLE_CODECS: Codec[] = [
	'av1',
	'vvc',
	'h265',
	'h264',
	'vp9',
	'vc1',
	'xvid',
	'divx',
	'mpeg2',
	'unknown'
];

/**
 * Codec labels for the UI
 */
export const CODEC_LABELS: Record<Codec, string> = {
	av1: 'AV1',
	vvc: 'VVC (H.266)',
	h265: 'HEVC (H.265/x265)',
	h264: 'AVC (H.264/x264)',
	vp9: 'VP9',
	vc1: 'VC-1',
	xvid: 'XviD',
	divx: 'DivX',
	mpeg2: 'MPEG-2',
	unknown: 'Unknown'
};

/**
 * Available audio codecs for condition matching
 */
export const AVAILABLE_AUDIO_CODECS: AudioCodec[] = [
	'truehd',
	'dts-x',
	'dts-hdma',
	'dts-hd-hra',
	'dts-hd',
	'dts-es',
	'dts',
	'dd+',
	'dd',
	'flac',
	'pcm',
	'opus',
	'aac',
	'mp3',
	'unknown'
];

/**
 * Audio codec labels for the UI
 */
export const AUDIO_CODEC_LABELS: Record<AudioCodec, string> = {
	truehd: 'TrueHD',
	'dts-x': 'DTS:X',
	'dts-hdma': 'DTS-HD Master Audio',
	'dts-hd-hra': 'DTS-HD HRA',
	'dts-hd': 'DTS-HD',
	'dts-es': 'DTS-ES',
	dts: 'DTS',
	'dd+': 'Dolby Digital Plus (DD+)',
	dd: 'Dolby Digital (DD)',
	flac: 'FLAC',
	pcm: 'PCM',
	opus: 'Opus',
	aac: 'AAC',
	mp3: 'MP3',
	unknown: 'Unknown'
};

export const AVAILABLE_AUDIO_CHANNELS: AudioChannels[] = ['7.1', '5.1', '2.0', '1.0', 'unknown'];

export const AUDIO_CHANNEL_LABELS: Record<AudioChannels, string> = {
	'7.1': '7.1 Surround',
	'5.1': '5.1 Surround',
	'2.0': '2.0 Stereo',
	'1.0': '1.0 Mono',
	unknown: 'Unknown'
};

/**
 * Available HDR formats for condition matching
 * Note: null represents SDR (no HDR)
 */
export const AVAILABLE_HDR: (HdrFormat | 'sdr')[] = [
	'dolby-vision',
	'hdr10+',
	'hdr10',
	'hdr',
	'hlg',
	'pq',
	'sdr'
];

/**
 * HDR format labels for the UI
 */
export const HDR_LABELS: Record<NonNullable<HdrFormat> | 'sdr', string> = {
	'dolby-vision': 'Dolby Vision',
	'hdr10+': 'HDR10+',
	hdr10: 'HDR10',
	hdr: 'HDR (Generic)',
	hlg: 'HLG',
	pq: 'PQ',
	sdr: 'SDR (No HDR)'
};

/**
 * Available streaming services for condition matching
 */
export const AVAILABLE_STREAMING_SERVICES = [
	'AMZN',
	'NF',
	'ATVP',
	'DSNP',
	'HMAX',
	'MAX',
	'PCOK',
	'PMTP',
	'HULU',
	'iT',
	'STAN',
	'CRAV',
	'NOW',
	'SHO',
	'ROKU'
] as const;

export type StreamingService = (typeof AVAILABLE_STREAMING_SERVICES)[number];

/**
 * Streaming service labels for the UI
 */
export const STREAMING_SERVICE_LABELS: Record<StreamingService, string> = {
	AMZN: 'Amazon Prime Video',
	NF: 'Netflix',
	ATVP: 'Apple TV+',
	DSNP: 'Disney+',
	HMAX: 'HBO Max',
	MAX: 'Max',
	PCOK: 'Peacock',
	PMTP: 'Paramount+',
	HULU: 'Hulu',
	iT: 'iTunes',
	STAN: 'Stan',
	CRAV: 'Crave',
	NOW: 'NOW',
	SHO: 'Showtime',
	ROKU: 'Roku Channel'
};

/**
 * Available flags for condition matching
 */
export const AVAILABLE_FLAGS = ['isRemux', 'isRepack', 'isProper', 'is3d'] as const;

export type ReleaseFlag = (typeof AVAILABLE_FLAGS)[number];

/**
 * Flag labels for the UI
 */
export const FLAG_LABELS: Record<ReleaseFlag, string> = {
	isRemux: 'Is Remux',
	isRepack: 'Is Repack',
	isProper: 'Is Proper',
	is3d: 'Is 3D'
};

/**
 * Flag descriptions for the UI
 */
export const FLAG_DESCRIPTIONS: Record<ReleaseFlag, string> = {
	isRemux: 'Release is a lossless extraction from disc (Remux)',
	isRepack: 'Release is a replacement for a previous bad release',
	isProper: 'Release fixes issues in a prior release',
	is3d: 'Release is in 3D format'
};

/**
 * Extended format for UI display
 * Matches ExtendedCustomFormat from FormatRegistry
 *
 * Note: Formats no longer have defaultScore. Scores are defined per-profile
 * in the profile's formatScores mapping.
 */
export interface UICustomFormat {
	id: string;
	name: string;
	description?: string;
	category: FormatCategory;
	tags: string[];
	conditions: FormatCondition[];
	isBuiltIn: boolean;
	enabled: boolean;
	createdAt?: string;
	updatedAt?: string;
}

export interface CustomFormatFormData {
	name: string;
	description?: string;
	category: FormatCategory;
	tags: string[];
	conditions: FormatCondition[];
	enabled: boolean;
}

/**
 * Format score entry with metadata
 *
 * Note: Without defaultScore, scores are simply what the profile defines.
 * A score of 0 means the profile doesn't prioritize this format.
 */
export interface FormatScoreEntry {
	formatId: string;
	formatName: string;
	formatCategory: FormatCategory;
	score: number;
}

/**
 * Grouped format scores by category
 */
export type GroupedFormatScores = Map<FormatCategory, FormatScoreEntry[]>;

/**
 * Helper to group format scores by category
 */
export function groupFormatScoresByCategory(
	formatScores: Record<
		string,
		{
			score: number;
			formatName: string;
			formatCategory: string;
		}
	>
): GroupedFormatScores {
	const grouped = new Map<FormatCategory, FormatScoreEntry[]>();

	for (const [formatId, entry] of Object.entries(formatScores)) {
		const category = entry.formatCategory as FormatCategory;
		const existing = grouped.get(category) || [];
		existing.push({
			formatId,
			formatName: entry.formatName,
			formatCategory: category,
			score: entry.score
		});
		grouped.set(category, existing);
	}

	// Sort each category by format name
	for (const [, entries] of grouped) {
		entries.sort((a, b) => a.formatName.localeCompare(b.formatName));
	}

	return grouped;
}

/**
 * Filter format scores by search query
 */
export function filterFormatScores(scores: FormatScoreEntry[], query: string): FormatScoreEntry[] {
	if (!query) return scores;
	const lowerQuery = query.toLowerCase();
	return scores.filter((s) => s.formatName.toLowerCase().includes(lowerQuery));
}

/**
 * Count non-zero scores in a group (formats that have been assigned a score)
 */
export function countNonZeroScores(scores: FormatScoreEntry[]): number {
	return scores.filter((s) => s.score !== 0).length;
}
