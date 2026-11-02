/**
 * Release Parser Types
 *
 * Types and enums for parsing release names to extract structured metadata
 * like resolution, source, codec, canonical audio attributes, and TV episode information.
 */

// =============================================================================
// Quality Attributes
// =============================================================================

export type Resolution = '2160p' | '1080p' | '720p' | '480p' | 'unknown';

export type Source =
	| 'remux'
	| 'bluray'
	| 'hdrip'
	| 'webdl'
	| 'webrip'
	| 'hdtv'
	| 'dvd'
	| 'cam'
	| 'telesync'
	| 'telecine'
	| 'screener'
	| 'unknown';

export type Codec =
	'av1' | 'vvc' | 'h265' | 'h264' | 'vp9' | 'vc1' | 'xvid' | 'divx' | 'mpeg2' | 'unknown';

export type BitDepth = '8' | '10' | '12' | 'unknown';

/**
 * HDR Format Types
 * - dolby-vision: Dolby Vision
 * - hdr10+: Samsung's dynamic HDR format
 * - hdr10: Static HDR metadata
 * - hdr: Generic HDR (assume HDR10)
 * - hlg: Hybrid Log-Gamma (broadcast HDR)
 * - pq: Perceptual Quantizer
 * - sdr: Standard Dynamic Range (explicit)
 */
export type HdrFormat = 'dolby-vision' | 'hdr10+' | 'hdr10' | 'hdr' | 'hlg' | 'pq' | 'sdr';

/**
 * HDR formats ordered best-first. A release can legitimately carry several at
 * once (DV is routinely muxed over an HDR10/HDR10+ base layer), so detection
 * returns a set rather than a single value.
 */
export const HDR_FORMAT_ORDER: readonly HdrFormat[] = [
	'dolby-vision',
	'hdr10+',
	'hdr10',
	'hdr',
	'hlg',
	'pq',
	'sdr'
];

/**
 * Sort HDR formats into canonical best-first order and drop duplicates.
 */
export function sortHdrFormats(formats: Iterable<HdrFormat>): HdrFormat[] {
	const seen = new Set<HdrFormat>();
	for (const format of formats) {
		seen.add(format);
	}
	return HDR_FORMAT_ORDER.filter((format) => seen.has(format));
}

/**
 * Pick the best HDR format from a set, or null when none were detected.
 */
export function bestHdrFormat(formats: readonly HdrFormat[]): HdrFormat | null {
	return formats.length > 0 ? sortHdrFormats(formats)[0] : null;
}

/**
 * Type guard for a canonical HDR format value. Persisted quality and API
 * payloads carry plain strings, so they need validating before use.
 */
export function isHdrFormat(value: unknown): value is HdrFormat {
	return typeof value === 'string' && (HDR_FORMAT_ORDER as readonly string[]).includes(value);
}

/**
 * Extract every HDR format named by a MediaInfo-style label.
 *
 * Probe tools report combos in one string ("Dolby Vision HDR10+", "Dolby
 * Vision HDR10"), so labels are scanned for every format rather than mapped
 * to a single value. Returns canonical best-first order, empty when nothing
 * was recognised.
 */
export function hdrFormatsFromLabel(label: string | null | undefined): HdrFormat[] {
	if (!label) return [];
	const normalized = label.toLowerCase();
	const found: HdrFormat[] = [];

	if (normalized.includes('dolby') && normalized.includes('vision')) {
		found.push('dolby-vision');
	}
	if (normalized.includes('hdr10+') || normalized.includes('hdr10plus')) {
		found.push('hdr10+');
	} else if (normalized.includes('hdr10')) {
		found.push('hdr10');
	}
	if (normalized.includes('hlg')) {
		found.push('hlg');
	}
	if (normalized.includes('pq')) {
		found.push('pq');
	}
	if (normalized.includes('sdr')) {
		found.push('sdr');
	}
	// Bare "HDR" means unspecified HDR; only meaningful on its own.
	if (found.length === 0 && normalized.includes('hdr')) {
		found.push('hdr');
	}

	return sortHdrFormats(found);
}

/**
 * Audio Codec Types (base codec, not including Atmos modifier)
 * Atmos is tracked separately via hasAtmos.
 */
export type AudioCodec =
	| 'truehd'
	| 'dts-x'
	| 'dts-hdma'
	| 'dts-hd-hra'
	| 'dts-hd'
	| 'dts-es'
	| 'dts'
	| 'dd+'
	| 'dd'
	| 'flac'
	| 'pcm'
	| 'opus'
	| 'aac'
	| 'mp3'
	| 'unknown';

/**
 * Audio Channel Configuration
 * Detected from release title for metadata/display
 */
export type AudioChannels = '7.1' | '5.1' | '2.0' | '1.0' | 'unknown';

/**
 * Parsed episode information for TV releases
 */
export interface EpisodeInfo {
	/** Season number (1-based) - for single season releases */
	season?: number;
	/** Season numbers (1-based) - for multi-season packs like S01-S05 */
	seasons?: number[];
	/** Episode numbers within season (1-based) */
	episodes?: number[];
	/** Absolute episode number for anime */
	absoluteEpisode?: number;
	/** Whether this is a full season pack */
	isSeasonPack: boolean;
	/** Whether this is a complete series pack */
	isCompleteSeries: boolean;
	/** Whether this is a daily show (uses date instead of episode) */
	isDaily: boolean;
	/** Air date for daily shows (YYYY-MM-DD) */
	airDate?: string;
}

/**
 * Parsed release information extracted from a release title
 */
export interface ParsedRelease {
	/** Original release title */
	originalTitle: string;

	/** Cleaned title (media name without quality/group info) */
	cleanTitle: string;

	/** Release year if present */
	year?: number;

	// Quality attributes
	resolution: Resolution;
	source: Source;
	codec: Codec;
	/**
	 * Every HDR format detected in the title, best-first.
	 *
	 * Combo releases (DV over an HDR10+ or HDR10 base layer) legitimately carry
	 * more than one format. Requirements, bans and the UI must see the whole
	 * set; scoring picks one via HDR_FORMAT_ORDER to avoid double-counting.
	 */
	hdrFormats: HdrFormat[];
	/**
	 * Best detected HDR format, or null when none was detected.
	 * Derived from `hdrFormats` — kept for consumers that only need the
	 * headline format (naming, display, persisted quality).
	 */
	hdr: HdrFormat | null;
	bitDepth: BitDepth;

	// Canonical audio attributes
	/** Audio codec (base codec without Atmos modifier) */
	audioCodec: AudioCodec;
	/** Audio channel configuration */
	audioChannels: AudioChannels;
	/** Whether Atmos object audio is present (stackable modifier) */
	hasAtmos: boolean;

	// TV-specific information
	/** Episode info if this appears to be a TV release */
	episode?: EpisodeInfo;

	// Additional metadata
	/**
	 * Languages asserted by the release title (ISO 639-1 codes, plus the
	 * pseudo-codes 'multi' and 'orig'). Empty when the title names no
	 * language — absence of evidence is never expanded to 'en'.
	 */
	languages: string[];

	/**
	 * Source indexer language (ISO 639-1 code) - where the release came from.
	 * Source metadata only; never merged into `languages`.
	 */
	sourceLanguage?: string;

	/** Detected streaming service tag (AMZN, NF, MA, etc.) */
	streamingService?: string;

	/** Release group name */
	releaseGroup?: string;

	/** Edition info (director's cut, extended, etc.) */
	edition?: string;

	/** Whether this is a PROPER release (fixes issues in prior release) */
	isProper: boolean;

	/** Whether this is a REPACK (replacement for bad release) */
	isRepack: boolean;

	/** Whether this is a REMUX (lossless extraction from disc) */
	isRemux: boolean;

	/** Whether this is a 3D release */
	is3d: boolean;

	/** Whether this contains hardcoded subtitles */
	hasHardcodedSubs: boolean;

	/** Confidence score (0-1) for parsing accuracy */
	confidence: number;
}

/**
 * Resolution hierarchy for comparison (higher = better quality)
 */
export const RESOLUTION_ORDER: Record<Resolution, number> = {
	'2160p': 4,
	'1080p': 3,
	'720p': 2,
	'480p': 1,
	unknown: 0
};

/**
 * Source quality hierarchy (higher = better quality)
 */
export const SOURCE_ORDER: Record<Source, number> = {
	remux: 10,
	bluray: 9,
	hdrip: 8,
	webdl: 7,
	webrip: 6,
	hdtv: 5,
	dvd: 4,
	screener: 3,
	telecine: 2,
	telesync: 1,
	cam: 0,
	unknown: -1
};

/**
 * Codec efficiency hierarchy (higher = more efficient/modern)
 */
export const CODEC_ORDER: Record<Codec, number> = {
	av1: 6,
	vvc: 7, // VVC/H.266 is newest but rarely used
	h265: 5,
	h264: 4,
	vp9: 3,
	vc1: 2,
	mpeg2: 1,
	xvid: 0,
	divx: 0,
	unknown: -1
};

/**
 * Audio codec quality hierarchy (higher = better quality)
 * Note: This is for the base codec, Atmos is scored separately as a modifier
 */
export const AUDIO_CODEC_ORDER: Record<AudioCodec, number> = {
	truehd: 10, // Dolby TrueHD (lossless)
	'dts-x': 9, // DTS:X object-based (lossless core)
	'dts-hdma': 8, // DTS-HD Master Audio (lossless)
	pcm: 7, // Uncompressed PCM (lossless)
	flac: 6, // FLAC (lossless)
	'dts-hd-hra': 5, // DTS-HD High Resolution Audio (lossy but HQ)
	'dts-hd': 4, // DTS-HD (unspecified, assume lossy)
	'dts-es': 3, // DTS Extended Surround (legacy)
	dts: 2, // Standard DTS
	'dd+': 2, // Dolby Digital Plus (E-AC3)
	opus: 2, // Opus (efficient modern lossy)
	dd: 1, // Dolby Digital (AC3)
	aac: 1, // AAC
	mp3: 0, // MP3
	unknown: -1
};

/**
 * HDR format quality hierarchy (higher = better/more capable).
 *
 * Derived from HDR_FORMAT_ORDER so priority is declared in exactly one place.
 */
export const HDR_ORDER: Record<HdrFormat, number> = Object.fromEntries(
	HDR_FORMAT_ORDER.map((format, index) => [format, HDR_FORMAT_ORDER.length - index])
) as Record<HdrFormat, number>;

/**
 * Audio channel configuration hierarchy (higher = more channels)
 */
export const AUDIO_CHANNELS_ORDER: Record<AudioChannels, number> = {
	'7.1': 4,
	'5.1': 3,
	'2.0': 2,
	'1.0': 1,
	unknown: 0
};
