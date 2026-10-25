/**
 * Release Parser Module
 *
 * Exports for parsing release titles into structured metadata
 */

// Main parser
export { ReleaseParser, releaseParser, parseRelease } from './ReleaseParser.js';
export type { ParseOptions } from './ReleaseParser.js';

// Types
export type {
	ParsedRelease,
	EpisodeInfo,
	Resolution,
	Source,
	Codec,
	BitDepth,
	HdrFormat,
	AudioCodec,
	AudioChannels
} from './types.js';

export {
	RESOLUTION_ORDER,
	SOURCE_ORDER,
	CODEC_ORDER,
	AUDIO_CODEC_ORDER,
	HDR_FORMAT_ORDER,
	sortHdrFormats,
	bestHdrFormat,
	isHdrFormat
} from './types.js';

// Individual pattern extractors (for advanced use)
export { extractResolution, hasResolutionInfo } from './patterns/resolution.js';
export { extractSource, hasSourceInfo } from './patterns/source.js';
export { extractCodec, extractBitDepth, hasCodecInfo, hasBitDepthInfo } from './patterns/codec.js';
export {
	extractEnhancedAudio,
	extractHdr,
	extractHdrFormats,
	hasAudioInfo,
	hasHdrInfo,
	hasAtmos,
	extractChannels
} from './patterns/audio.js';
export { extractLanguages, hasExplicitLanguage } from './patterns/language.js';
export { extractEpisode, isTvRelease, extractTitleBeforeEpisode } from './patterns/episode.js';
export { extractReleaseGroup, hasReleaseGroup } from './patterns/releaseGroup.js';
