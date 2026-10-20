/**
 * Built-in Scoring Profiles
 *
 * Philosophy: Clean Additive Scoring (0-1000+ scale, no cap)
 *
 * Each attribute contributes its own score independently:
 * - Resolution: 2160p > 1080p > 720p > 480p
 * - Source: Remux > BluRay > WEB-DL > WEBRip > HDTV > DVD
 * - Codec: AV1 > x265 > x264
 * - Audio: Lossless > HQ Lossy > Standard
 * - HDR: DV > HDR10+ > HDR10 > HLG > SDR
 * - Release Groups: Quality groups get bonus, bad groups get penalty
 *
 * NO combo formats - resolution and source are scored SEPARATELY.
 *
 * Score Ranges:
 * - Resolution: 0-300 (2160p=300, 1080p=200, 720p=100, 480p=50)
 * - Source: 0-250 (Remux=250, BluRay=200, WEB-DL=180, WEBRip=150, HDTV=100, DVD=50)
 * - Codec: 0-200 (AV1=200, x265=180, x264=100)
 * - Audio: 0-150 (Lossless=150, HQ lossy=100, Standard=50)
 * - HDR: 0-100 (DV/HDR10+=100, HDR10=80, HLG=60, SDR=0)
 * - Release Groups: +100 for good, -100 for bad
 * - Editions: 0-50
 */

import type { ScoringProfile } from './types.js';
import { BANNED_SCORE, DEFAULT_RESOLUTION_ORDER } from './types.js';

// =============================================================================
// Shared Constants
// =============================================================================

/**
 * Banned formats applied to ALL profiles
 * These are deceptive, unusable, or unwanted content that should always be blocked
 */
const UNIVERSAL_BANNED_FORMATS: Record<string, number> = {
	// Deceptive groups (retagging, fake HDR)
	'banned-aroma': BANNED_SCORE,
	'banned-telly': BANNED_SCORE,
	'banned-vd0n': BANNED_SCORE,
	'banned-bitor': BANNED_SCORE,
	'banned-visionxpert': BANNED_SCORE,
	'banned-sasukeduck': BANNED_SCORE,
	'banned-jennaortegauhd': BANNED_SCORE,

	// Unusable sources
	'banned-cam': BANNED_SCORE,
	'banned-telesync': BANNED_SCORE,
	'banned-telecine': BANNED_SCORE,
	'banned-screener': BANNED_SCORE,

	// Unwanted content
	'banned-extras': BANNED_SCORE,
	'banned-sample': BANNED_SCORE,
	'banned-soundtrack': BANNED_SCORE,
	'banned-game-repack': BANNED_SCORE,

	// Technical issues
	'banned-upscaled': BANNED_SCORE,
	'banned-ai-tv': BANNED_SCORE,
	'banned-ai-movie': BANNED_SCORE,
	'banned-full-disc': BANNED_SCORE,
	'banned-xvid': BANNED_SCORE
};

// =============================================================================
// Quality Profile - Maximum Quality
// =============================================================================

/**
 * Quality Profile: Absolute best quality, no compromise
 *
 * Target: 4K Remux with lossless audio and HDR
 * - Remux > Encode (preserves original quality)
 * - Lossless audio (TrueHD, DTS-HD MA) highly valued
 * - HDR/DV essential for 4K content
 * - Top-tier encoding groups valued
 * - File size is not a concern
 *
 * Ideal for: Home theater enthusiasts, quality purists, unlimited storage
 */
export const QUALITY_PROFILE: ScoringProfile = {
	id: 'quality',
	name: 'Quality',
	description: 'Maximum quality - Remux, lossless audio, HDR, no compromise',
	tags: ['quality', 'remux', 'lossless', '4k', 'hdr'],
	icon: 'Star',
	color: 'text-yellow-500',
	category: 'quality',
	upgradesAllowed: true,
	preventDowngrades: true,
	minScore: 0,
	upgradeUntilScore: 100000,
	minScoreIncrement: 50,
	resolutionOrder: DEFAULT_RESOLUTION_ORDER,
	// Filtering - no restrictions, accept everything except known bad sources
	minResolution: null,
	maxResolution: null,
	allowedSources: null,
	excludedSources: ['cam', 'telesync', 'telecine', 'screener'],
	allowedProtocols: ['torrent', 'usenet'],
	formatScores: {
		// ===========================================
		// Resolution (Primary quality indicator)
		// ===========================================
		'resolution-2160p': 300,
		'resolution-1080p': 200,
		'resolution-720p': 100,
		'resolution-480p': 50,

		// ===========================================
		// Source (How it was obtained)
		// ===========================================
		'source-remux': 250,
		'source-bluray': 200,
		'source-webdl': 180,
		'source-webrip': 150,
		'source-hdtv': 100,
		'source-dvd': 50,

		// ===========================================
		// Audio - Lossless highly valued
		// ===========================================
		'audio-truehd': 150,
		'audio-dts-x': 150,
		'audio-dts-hdma': 140,
		'audio-pcm': 140,
		'audio-flac': 130,

		// HQ Lossy - Good alternatives
		'audio-atmos': 120,
		'audio-dts-hd-hra': 100,
		'audio-dts-es': 80,
		'audio-opus': 80,
		'audio-ddplus': 100,
		'audio-dts': 70,
		'audio-dd': 60,

		// Standard - Acceptable
		'audio-aac': 40,
		'audio-mp3': 20,

		// ===========================================
		// HDR - Essential for 4K
		// ===========================================
		'hdr-dolby-vision': 100,
		'hdr-hdr10plus': 90,
		'hdr-hdr10': 80,
		'hdr-generic': 60,
		'hdr-hlg': 50,
		'hdr-pq': 40,
		'hdr-sdr': 0,

		// ===========================================
		// Release Groups - Top tier valued
		// ===========================================
		// Premier remux groups
		'group-framestor': 100,
		'group-cinephiles': 90,
		'group-epsilon': 80,
		'group-sicfoi': 70,
		'group-wildcat': 60,
		'group-bluranium': 50,
		'group-bizkit': 40,
		'group-3l': 30,

		// Top encode groups
		'group-don': 80,
		'group-d-z0n3': 80,
		'group-ebp': 70,
		'group-ctrlhd': 60,
		'group-decibel': 60,
		'group-playbd': 50,
		'group-ea': 40,
		'group-hifi': 40,

		// Quality 4K groups
		'group-sa89': 60,
		'group-reborn': 60,
		'group-solar': 50,
		'group-hqmux': 40,
		'group-ift': 40,
		'group-zq': 30,
		'group-w4nk3r': 20,

		// Quality WEB-DL groups
		'group-ntb': 40,
		'group-ntg': 30,
		'group-flux': 25,
		'group-cmrg': 20,
		'group-thefarm': 25,

		// Efficient encoders (less valued in Quality - not lossless)
		'group-tigole': 10,
		'group-qxr': 5,
		'group-taoe': 5,

		// Micro encoders (heavily penalized - sacrifices quality)
		'group-yts': -100,
		'group-yify': -100,
		'group-rarbg': -30,
		'group-psa': -50,
		'group-galaxyrg': -50,

		// Low quality groups (penalized)
		'group-nahom': -80,
		'group-nogroup': -80,
		'group-stuttershit': -80,

		// ===========================================
		// Streaming Services - Premium valued
		// ===========================================
		'streaming-atvp': 25,
		'streaming-amzn': 20,
		'streaming-nf': 20,
		'streaming-dsnp': 20,
		'streaming-hmax': 15,
		'streaming-max': 15,
		'streaming-bcore': 25,
		'streaming-crit': 20,
		'streaming-mubi': 15,

		// ===========================================
		// Editions & Enhancements
		// ===========================================
		'edition-imax-enhanced': 50,
		'edition-imax': 30,
		'edition-criterion': 40,
		'edition-directors-cut': 20,
		'edition-extended': 15,
		'edition-remastered': 20,
		'edition-theatrical': 5,
		'edition-unrated': 10,
		'edition-open-matte': 15,
		'edition-hybrid': 20,
		'edition-final-cut': 15,

		'repack-3': 40,
		'repack-2': 30,
		'repack-1': 20,
		proper: 20,

		// Codecs
		'codec-x265': 30,
		'codec-x264': 10,
		'codec-av1': 50,

		// 3D - Penalized (not banned, but usually unwanted)
		'banned-3d': -100,

		// x264 at 2160p - Penalized (inefficient)
		'banned-x264-2160p': -150,

		// Banned formats
		...UNIVERSAL_BANNED_FORMATS
	}
};

// =============================================================================
// Balanced Profile - Quality with Efficient Encoding
// =============================================================================

/**
 * Balanced Profile: High quality with efficient encoding
 *
 * Target: Quality x265/AV1 encodes with good audio
 * - Encodes > Remux (efficient use of space)
 * - x265/AV1 highly valued for efficiency
 * - DD+ Atmos over TrueHD (transparent at smaller size)
 * - Quality encode groups prioritized
 *
 * Ideal for: Quality-conscious users with reasonable storage
 */
export const BALANCED_PROFILE: ScoringProfile = {
	id: 'balanced',
	name: 'Balanced',
	description: 'High quality with efficient encoding - x265/AV1, quality groups',
	tags: ['quality', 'efficient', 'x265', 'av1'],
	icon: 'Zap',
	color: 'text-green-500',
	category: 'efficient',
	upgradesAllowed: true,
	preventDowngrades: true,
	minScore: 0,
	upgradeUntilScore: 30000,
	minScoreIncrement: 20,
	resolutionOrder: DEFAULT_RESOLUTION_ORDER,
	// Filtering - no restrictions
	minResolution: null,
	maxResolution: null,
	allowedSources: null,
	excludedSources: ['cam', 'telesync', 'telecine', 'screener'],
	allowedProtocols: ['torrent', 'usenet'],
	formatScores: {
		// ===========================================
		// Resolution
		// ===========================================
		'resolution-2160p': 250,
		'resolution-1080p': 200,
		'resolution-720p': 100,
		'resolution-480p': 50,

		// ===========================================
		// Source
		// ===========================================
		'source-remux': 150,
		'source-bluray': 200,
		'source-webdl': 180,
		'source-webrip': 140,
		'source-hdtv': 80,
		'source-dvd': 40,

		// ===========================================
		// Audio - Efficient formats valued
		// ===========================================
		// HQ Lossy preferred for efficiency
		'audio-atmos': 120,
		'audio-ddplus': 100,
		'audio-opus': 80,

		// Lossless - Good but not essential
		'audio-truehd': 90,
		'audio-dts-x': 100,
		'audio-dts-hdma': 80,
		'audio-pcm': 70,
		'audio-flac': 80,

		// Standard lossy
		'audio-dts-hd-hra': 70,
		'audio-dts-es': 50,
		'audio-dts': 50,
		'audio-dd': 50,
		'audio-aac': 40,
		'audio-mp3': 20,

		// ===========================================
		// HDR
		// ===========================================
		'hdr-dolby-vision': 80,
		'hdr-hdr10plus': 70,
		'hdr-hdr10': 50,
		'hdr-generic': 40,
		'hdr-hlg': 30,
		'hdr-pq': 20,
		'hdr-sdr': 0,

		// ===========================================
		// Release Groups - Efficient encoders highly valued
		// ===========================================
		// Efficient x265 masters
		'group-tigole': 100,
		'group-qxr': 90,
		'group-taoe': 80,
		'group-darq': 70,
		'group-dkore': 70,
		'group-edge2020': 60,
		'group-grimm': 60,
		'group-lst': 60,
		'group-nan0': 60,
		'group-ralphy': 60,
		'group-rcvr': 60,
		'group-sampa': 60,
		'group-silence': 60,
		'group-tonato': 60,
		'group-vialle': 60,
		'group-vyndros': 60,
		'group-yello': 60,

		// Quality encode groups
		'group-don': 60,
		'group-d-z0n3': 60,
		'group-ebp': 50,
		'group-ctrlhd': 40,
		'group-decibel': 40,
		'group-playbd': 35,
		'group-ea': 30,
		'group-hifi': 30,

		// Remux groups (still good, just not optimal)
		'group-framestor': 40,
		'group-cinephiles': 30,
		'group-epsilon': 25,

		// WEB-DL groups
		'group-ntb': 40,
		'group-ntg': 30,
		'group-flux': 25,
		'group-cmrg': 20,
		'group-thefarm': 25,

		// Micro encoders (neutral to slight penalty)
		'group-rarbg': 15,
		'group-yts': -20,
		'group-yify': -20,
		'group-psa': 0,
		'group-galaxyrg': 5,

		// Low quality groups
		'group-nahom': -50,
		'group-nogroup': -50,
		'group-stuttershit': -50,

		// ===========================================
		// Streaming Services
		// ===========================================
		'streaming-atvp': 30,
		'streaming-amzn': 25,
		'streaming-nf': 25,
		'streaming-dsnp': 20,
		'streaming-hmax': 20,
		'streaming-max': 20,
		'streaming-bcore': 25,
		'streaming-crit': 15,
		'streaming-mubi': 15,

		// ===========================================
		// Editions & Enhancements
		// ===========================================
		'edition-imax-enhanced': 40,
		'edition-imax': 25,
		'edition-criterion': 30,
		'edition-directors-cut': 15,
		'edition-extended': 10,
		'edition-remastered': 15,
		'edition-theatrical': 5,
		'edition-hybrid': 20,

		'repack-3': 30,
		'repack-2': 20,
		'repack-1': 10,
		proper: 15,

		// Codecs - x265/AV1 highly valued
		'codec-x265': 100,
		'codec-av1': 120,
		'codec-x264': 10,

		// 3D
		'banned-3d': -100,
		'banned-x264-2160p': -150,

		// Banned formats
		...UNIVERSAL_BANNED_FORMATS
	}
};

// =============================================================================
// Compact Profile - Small Files, Decent Quality
// =============================================================================

/**
 * Compact Profile: Quality-focused micro encodes
 *
 * Target: Best quality in small packages (~1-4GB)
 * - Micro encoders are heroes (Tigole, QxR)
 * - x265/AV1 essential for efficiency
 * - Lossy audio is fine (AAC, DD+)
 * - Remux/lossless penalized (too big)
 *
 * Ideal for: Limited storage, large libraries, Plex/streaming to devices
 */
export const COMPACT_PROFILE: ScoringProfile = {
	id: 'compact',
	name: 'Compact',
	description: 'Small files with decent quality - micro encoders, efficient codecs',
	tags: ['compact', 'micro', 'efficient', 'small'],
	icon: 'Minimize2',
	color: 'text-purple-500',
	category: 'micro',
	upgradesAllowed: true,
	preventDowngrades: true,
	minScore: -5000,
	upgradeUntilScore: 15000,
	minScoreIncrement: 10,
	resolutionOrder: DEFAULT_RESOLUTION_ORDER,
	// Filtering - prefer smaller resolutions, exclude bad sources
	minResolution: '480p',
	allowedSources: null,
	excludedSources: ['cam', 'telesync', 'telecine', 'screener'],
	allowedProtocols: ['torrent', 'usenet'],
	formatScores: {
		// ===========================================
		// Resolution - 1080p is sweet spot, 4K too large
		// ===========================================
		'resolution-2160p': 100,
		'resolution-1080p': 200,
		'resolution-720p': 150,
		'resolution-480p': 80,

		// ===========================================
		// Source - WEB preferred for efficiency
		// ===========================================
		'source-remux': -50,
		'source-bluray': 80,
		'source-webdl': 150,
		'source-webrip': 120,
		'source-hdtv': 100,
		'source-dvd': 60,

		// ===========================================
		// Audio - Efficient formats preferred
		// ===========================================
		// Small/efficient preferred
		'audio-aac': 80,
		'audio-opus': 100,
		'audio-ddplus': 70,
		'audio-dd': 50,
		'audio-mp3': 40,

		// Lossy surround
		'audio-atmos': 30,
		'audio-dts': 25,
		'audio-dts-es': 15,
		'audio-dts-hd-hra': 10,

		// Lossless - Penalized (too big)
		'audio-truehd': -20,
		'audio-dts-x': -25,
		'audio-dts-hdma': -15,
		'audio-pcm': -15,
		'audio-flac': -10,

		// ===========================================
		// HDR - Nice to have, not essential
		// ===========================================
		'hdr-dolby-vision': 40,
		'hdr-hdr10plus': 35,
		'hdr-hdr10': 25,
		'hdr-generic': 15,
		'hdr-hlg': 10,
		'hdr-pq': 5,
		'hdr-sdr': 0,

		// ===========================================
		// Release Groups - Micro encoders are kings
		// ===========================================
		// Quality micro encoders
		'group-tigole': 150,
		'group-qxr': 130,
		'group-taoe': 100,

		// Efficient x265 encoders
		'group-darq': 90,
		'group-dkore': 90,
		'group-edge2020': 80,
		'group-grimm': 80,
		'group-lst': 80,
		'group-nan0': 80,
		'group-ralphy': 80,
		'group-rcvr': 80,
		'group-sampa': 80,
		'group-silence': 80,
		'group-tonato': 80,
		'group-vialle': 80,
		'group-vyndros': 80,
		'group-yello': 80,

		// Public tracker micro encoders
		'group-rarbg': 100,
		'group-yts': 80,
		'group-yify': 70,
		'group-psa': 90,
		'group-galaxyrg': 90,
		'group-megusta': 70,
		'group-tgx': 60,
		'group-etrg': 60,
		'group-ettv': 60,
		'group-eztv': 60,
		'group-x0r': 60,
		'group-ion10': 60,

		// WEB-DL groups (good, usually reasonable size)
		'group-ntb': 50,
		'group-ntg': 40,
		'group-flux': 30,
		'group-cmrg': 25,
		'group-thefarm': 30,

		// Quality encode groups (files might be big)
		'group-don': 15,
		'group-d-z0n3': 15,
		'group-ebp': 10,
		'group-ctrlhd': 10,

		// Remux groups (penalized - too big)
		'group-framestor': -40,
		'group-cinephiles': -30,
		'group-epsilon': -25,

		// Low quality - Still acceptable in Compact (small files)
		'group-nahom': 15,
		'group-nogroup': 5,
		'group-stuttershit': 0,

		// ===========================================
		// Streaming Services
		// ===========================================
		'streaming-atvp': 15,
		'streaming-amzn': 12,
		'streaming-nf': 12,
		'streaming-dsnp': 10,
		'streaming-hmax': 8,
		'streaming-max': 8,

		// ===========================================
		// Editions & Enhancements
		// ===========================================
		'edition-imax-enhanced': 10,
		'edition-imax': 5,
		'edition-directors-cut': 5,
		'edition-extended': 5,
		'edition-remastered': 5,

		'repack-3': 15,
		'repack-2': 10,
		'repack-1': 5,
		proper: 5,

		// Codecs - x265/AV1 essential
		'codec-x265': 100,
		'codec-av1': 120,
		'codec-x264': 5,

		// 3D
		'banned-3d': -100,
		'banned-x264-2160p': -80,

		// Banned formats
		...UNIVERSAL_BANNED_FORMATS
	}
};

// =============================================================================
// Anime Profile - Fansub/Group Aware
// =============================================================================

/**
 * Anime Profile: Tuned for anime release conventions
 *
 * Target: Dual-audio, group-aware anime releases
 * - Dual Audio (EN+JP) is a defining preference, scored heavily
 * - Simulcast WEB-DL groups (SubsPlease, Erai-raws) and top-tier BD batch
 *   groups (LYS1TH3A, MTBB, OZR, Vodes, etc.) are the gold standard
 * - Any recognized anime fansub group outscores an unidentified non-anime
 *   group, since anime releases are near-universally group-muxed
 * - x265 valued for efficiency, but x264 is still extremely common for
 *   anime (official WEB-DL, older BD encodes) and isn't penalized much
 * - HDR and lossless surround audio are rare for anime and barely move
 *   the score either way - resolution, source, dual-audio, and group
 *   identity carry nearly all the weight
 *
 * Ideal for: Anime libraries, fansub-aware grabbing, dual-audio preference
 */
export const ANIME_PROFILE: ScoringProfile = {
	id: 'anime',
	name: 'Anime',
	description: 'Tuned for anime - dual-audio bonus, fansub group awareness, x265 efficient encodes',
	tags: ['anime', 'dual-audio', 'fansub', 'x265'],
	icon: 'Sparkles',
	color: 'text-pink-500',
	category: 'anime',
	upgradesAllowed: true,
	preventDowngrades: true,
	minScore: 0,
	upgradeUntilScore: 50000,
	minScoreIncrement: 20,
	resolutionOrder: DEFAULT_RESOLUTION_ORDER,
	// Filtering - no restrictions; plenty of anime only ever gets a 720p release
	minResolution: null,
	maxResolution: null,
	allowedSources: null,
	excludedSources: ['cam', 'telesync', 'telecine', 'screener'],
	allowedProtocols: ['torrent', 'usenet'],
	formatScores: {
		// ===========================================
		// Resolution - 1080p is the anime ceiling for most releases, but a
		// genuine 4K release should never score below 1080p
		// ===========================================
		'resolution-2160p': 210,
		'resolution-1080p': 200,
		'resolution-720p': 120,
		'resolution-480p': 40,

		// ===========================================
		// Source
		// ===========================================
		'source-webdl': 160,
		'source-bluray': 150,
		'source-webrip': 110,
		'source-hdtv': 60,
		'source-dvd': 30,

		// ===========================================
		// Language - Dual Audio is the headline anime preference
		// ===========================================
		'lang-dual-audio': 180,
		'lang-multi': 60,

		// ===========================================
		// Codec - x265 preferred, x264 still common and not punished
		// ===========================================
		'codec-x265': 100,
		'codec-av1': 80,
		'codec-x264': 40,

		// ===========================================
		// Audio - lossy formats are the anime norm, lossless is a small bonus
		// ===========================================
		'audio-opus': 70,
		'audio-flac': 60,
		'audio-ddplus': 50,
		'audio-aac': 50,
		'audio-atmos': 40,
		'audio-truehd': 40,
		'audio-dts': 30,
		'audio-dd': 30,
		'audio-mp3': 10,

		// ===========================================
		// HDR - rare for anime, barely moves the needle
		// ===========================================
		'hdr-dolby-vision': 20,
		'hdr-hdr10plus': 20,
		'hdr-hdr10': 15,
		'hdr-generic': 10,
		'hdr-hlg': 10,
		'hdr-pq': 10,
		'hdr-sdr': 0,

		// ===========================================
		// Release Groups - Simulcast WEB sources
		// ===========================================
		'group-subsplease': 150,
		'group-erai-raws': 140,
		'group-horriblesubs': 40,

		// Top tier anime groups (BD batch re-encoders)
		'group-lys1th3a': 160,
		'group-mtbb': 160,
		'group-vodes': 160,
		'group-ozr': 150,
		'group-sam': 150,
		'group-scy': 150,
		'group-smol': 150,

		// Other recognized anime groups - any identified anime group beats
		// an unidentified one, since anime is near-universally group-muxed
		'group-arid': 70,
		'group-cbt': 70,
		'group-ctr': 70,
		'group-dekinai': 70,
		'group-drag': 70,
		'group-exp': 70,
		'group-flugel': 70,
		'group-headpatter': 70,
		'group-holomux': 70,
		'group-hydes': 70,
		'group-ik': 70,
		'group-kametsu': 70,
		'group-kh': 70,
		'group-kuchikirukia': 70,
		'group-lulu': 70,
		'group-mysteria': 70,
		'group-netaro': 70,
		'group-okay-subs': 70,
		'group-pog42': 70,
		'group-pookie': 70,
		'group-quetzal': 70,
		'group-rasetsu': 70,
		'group-senjou': 70,
		'group-udf': 70,
		'group-wbdp': 70,
		'group-yuri': 70,
		'group-zr': 70,

		// Non-anime-aware micro/scene groups that occasionally rehost anime
		// without care for subs/audio tracks
		'group-yts': -50,
		'group-yify': -50,
		'group-rarbg': -20,
		'group-nahom': -50,
		'group-nogroup': -50,
		'group-stuttershit': -50,

		// ===========================================
		// Repacks / Propers
		// ===========================================
		'repack-3': 30,
		'repack-2': 20,
		'repack-1': 10,
		proper: 15,

		'banned-3d': -100,
		'banned-x264-2160p': -100,

		// Banned formats
		...UNIVERSAL_BANNED_FORMATS
	}
};

// =============================================================================
// Streamer Profile - Streaming Only
// =============================================================================

/**
 * Streamer Profile: Streaming-only via .strm files
 *
 * Target: Instant playback from streaming sources
 * - Only accepts streaming protocol releases
 * - Rejects torrents and usenet completely
 * - No local storage required
 *
 * Ideal for: Users who want streaming-only, no downloads
 */
export const STREAMER_PROFILE: ScoringProfile = {
	id: 'streamer',
	name: 'Streamer',
	description: 'Streaming-only via .strm files - instant playback, no downloads',
	tags: ['streaming', 'instant', 'strm', 'cloud'],
	icon: 'Play',
	color: 'text-cyan-500',
	category: 'streaming',
	upgradesAllowed: true,
	preventDowngrades: true,
	minScore: 0,
	upgradeUntilScore: 100000,
	minScoreIncrement: 50,
	resolutionOrder: DEFAULT_RESOLUTION_ORDER,
	// Streaming only
	minResolution: null,
	maxResolution: null,
	allowedSources: null,
	excludedSources: null,
	allowedProtocols: ['streaming'],
	formatScores: {
		// Streaming protocol is the only thing that matters
		'streaming-protocol': 500,

		// Resolution preferences (if available)
		'resolution-2160p': 150,
		'resolution-1080p': 120,
		'resolution-720p': 80,
		'resolution-480p': 40,

		// Source preferences
		'source-webdl': 100,
		'source-webrip': 70,
		'source-hdtv': 40,

		// HDR is nice
		'hdr-dolby-vision': 50,
		'hdr-hdr10plus': 40,
		'hdr-hdr10': 30,

		// Banned formats - still apply
		...UNIVERSAL_BANNED_FORMATS
	}
};

// =============================================================================
// Exports
// =============================================================================

/**
 * All built-in profiles
 */
export const DEFAULT_PROFILES: ScoringProfile[] = [
	QUALITY_PROFILE,
	BALANCED_PROFILE,
	COMPACT_PROFILE,
	ANIME_PROFILE,
	STREAMER_PROFILE
];

/**
 * Profile lookup by ID
 */
export const PROFILE_BY_ID: Map<string, ScoringProfile> = new Map(
	DEFAULT_PROFILES.map((p) => [p.id, p])
);

/**
 * Get a built-in profile by ID
 */
export function getProfile(id: string): ScoringProfile | undefined {
	return PROFILE_BY_ID.get(id);
}

/**
 * Get all built-in profile IDs
 */
export function getBuiltInProfileIds(): string[] {
	return DEFAULT_PROFILES.map((p) => p.id);
}

/**
 * Check if a profile ID is a built-in profile
 */
export function isBuiltInProfile(id: string): boolean {
	return PROFILE_BY_ID.has(id);
}
