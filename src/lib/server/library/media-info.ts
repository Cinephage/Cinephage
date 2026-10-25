/**
 * Media Info Service
 *
 * Extracts detailed video/audio metadata from media files using ffprobe CLI.
 * This includes codec info, resolution, HDR format, audio channels, languages, and subtitles.
 *
 * Uses ffprobe JSON output instead of native bindings to avoid Vite SSR bundling issues.
 * This follows the same approach used by Sonarr/Radarr.
 */

import {
	runFFprobe,
	runFFprobeExtended,
	getPrimaryVideoStream,
	getPrimaryAudioStream,
	getAudioStreams,
	getSubtitleStreams,
	hasDolbyVisionSideData,
	hasHDR10PlusSideData,
	hasHDR10MasteringMetadata,
	getDolbyVisionProfile,
	parseFrameRate,
	type FFprobeStream,
	type FFprobeOutput
} from './ffprobe.js';
import { readFile } from 'node:fs/promises';
import type { movieFiles } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import { isVideoFile as isBaseVideoFile } from '#lib/config/constants.js';

const logger = createChildLogger({ logDomain: 'scans' as const });

// Type for the mediaInfo JSON field in our schema
type MediaInfo = NonNullable<typeof movieFiles.$inferSelect.mediaInfo>;

/**
 * HDR format detection based on color primaries and transfer characteristics
 * Following Radarr/Sonarr patterns
 */
const HDR_DETECTION = {
	// BT.2020 color primaries indicate HDR-capable content
	hdrColorPrimaries: ['bt2020', 'bt2020nc', 'bt2020c'],
	// Transfer functions that indicate specific HDR formats
	hlgTransfer: ['arib-std-b67'],
	pqTransfer: ['smpte2084', 'smpte-st-2084', 'smpte st 2084']
} as const;

const EXTRA_VIDEO_EXTENSIONS = ['.ogv', '.3gp', '.strm'] as const;

export function isVideoFile(filePath: string): boolean {
	return isBaseVideoFile(filePath, EXTRA_VIDEO_EXTENSIONS);
}

/**
 * Extract language code from stream tags
 */
function getLanguageFromStream(stream: FFprobeStream): string | undefined {
	const tags = stream.tags || {};
	return tags.language || tags.LANGUAGE || undefined;
}

function parseStrmUrl(content: string): string | null {
	const lines = content.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		return line;
	}
	return null;
}

/**
 * Detect HDR format from video stream properties and side data
 * Enhanced detection using ffprobe side_data_list for accurate HDR10+/DV detection
 */
function detectHdrFormat(stream: FFprobeStream): string | undefined {
	const primaries = stream.color_primaries?.toLowerCase() || '';
	const transfer = stream.color_transfer?.toLowerCase() || '';
	const codec = stream.codec_name?.toLowerCase() || '';
	const profile = stream.profile?.toLowerCase() || '';

	// Check for Dolby Vision via side data (most reliable)
	if (hasDolbyVisionSideData(stream)) {
		const dvProfile = getDolbyVisionProfile(stream);

		// DV profile determines compatibility layer
		// Profile 5: DV with no base layer (DV only)
		// Profile 7: DV with HDR10 base layer
		// Profile 8: DV with SDR/HDR10/HLG base layer
		if (dvProfile === 7 || dvProfile === 8) {
			// Check for HDR10+ compatibility
			if (hasHDR10PlusSideData(stream)) {
				return 'Dolby Vision HDR10+';
			}
			return 'Dolby Vision HDR10';
		}
		if (dvProfile === 4) {
			return 'Dolby Vision HLG';
		}
		if (dvProfile === 2 || dvProfile === 3) {
			return 'Dolby Vision SDR';
		}
		return 'Dolby Vision';
	}

	// Check for Dolby Vision via codec name (fallback)
	const dvCodecPatterns = ['dvhe', 'dvh1', 'dva1', 'dvav'];
	for (const pattern of dvCodecPatterns) {
		if (codec.includes(pattern) || profile.includes(pattern)) {
			return 'Dolby Vision';
		}
	}

	// Check if content uses BT.2020 color space (required for HDR)
	const isBt2020 = HDR_DETECTION.hdrColorPrimaries.some((p) => primaries.includes(p));
	if (!isBt2020) {
		return undefined; // Not HDR
	}

	// Detect specific HDR format based on transfer function
	if (HDR_DETECTION.hlgTransfer.some((t) => transfer.includes(t))) {
		return 'HLG';
	}

	if (HDR_DETECTION.pqTransfer.some((t) => transfer.includes(t))) {
		// Check for HDR10+ dynamic metadata
		if (hasHDR10PlusSideData(stream)) {
			return 'HDR10+';
		}

		// Check for HDR10 static metadata (mastering display/content light level)
		if (hasHDR10MasteringMetadata(stream)) {
			return 'HDR10';
		}

		// PQ transfer without metadata = generic PQ10
		return 'PQ10';
	}

	// BT.2020 without specific transfer = generic HDR
	return 'HDR';
}

/**
 * Extract bit depth from pixel format string
 */
function extractBitDepth(pixelFormat?: string, bitsPerRawSample?: string): number | undefined {
	// Use bits_per_raw_sample if available
	if (bitsPerRawSample) {
		const bits = parseInt(bitsPerRawSample, 10);
		if (!isNaN(bits) && bits > 0) {
			return bits;
		}
	}

	if (!pixelFormat) return undefined;

	const fmt = pixelFormat.toLowerCase();

	// 10-bit formats
	if (
		fmt.includes('10le') ||
		fmt.includes('10be') ||
		fmt.includes('p010') ||
		fmt.includes('yuv420p10') ||
		fmt.includes('yuv422p10') ||
		fmt.includes('yuv444p10')
	) {
		return 10;
	}

	// 12-bit formats
	if (
		fmt.includes('12le') ||
		fmt.includes('12be') ||
		fmt.includes('yuv420p12') ||
		fmt.includes('yuv422p12') ||
		fmt.includes('yuv444p12')
	) {
		return 12;
	}

	// 8-bit formats (common default)
	if (
		fmt === 'yuv420p' ||
		fmt === 'yuv422p' ||
		fmt === 'yuv444p' ||
		fmt.includes('nv12') ||
		fmt.includes('nv21')
	) {
		return 8;
	}

	return undefined;
}

/**
 * Map ffprobe codec names to friendly names
 */
function getCodecDisplayName(codecName?: string): string | undefined {
	if (!codecName) return undefined;

	const name = codecName.toLowerCase();

	// Video codecs
	const videoCodecMap: Record<string, string> = {
		h264: 'H.264',
		avc: 'H.264',
		hevc: 'HEVC',
		h265: 'HEVC',
		vp8: 'VP8',
		vp9: 'VP9',
		av1: 'AV1',
		mpeg1video: 'MPEG-1',
		mpeg2video: 'MPEG-2',
		mpeg4: 'MPEG-4',
		xvid: 'Xvid',
		divx: 'DivX',
		wmv3: 'WMV3',
		vc1: 'VC-1',
		theora: 'Theora',
		// DV profiles
		dvhe: 'HEVC (Dolby Vision)',
		dvh1: 'HEVC (Dolby Vision)',
		dva1: 'AV1 (Dolby Vision)',
		dvav: 'AVC (Dolby Vision)'
	};

	// Audio codecs
	const audioCodecMap: Record<string, string> = {
		aac: 'AAC',
		ac3: 'DD',
		eac3: 'DD+',
		truehd: 'TrueHD',
		dts: 'DTS',
		'dts-hd': 'DTS-HD',
		dtshd: 'DTS-HD',
		flac: 'FLAC',
		mp3: 'MP3',
		opus: 'Opus',
		vorbis: 'Vorbis',
		pcm_s16le: 'PCM',
		pcm_s24le: 'PCM',
		pcm_s32le: 'PCM',
		alac: 'ALAC',
		wmav2: 'WMA'
	};

	return videoCodecMap[name] || audioCodecMap[name] || codecName.toUpperCase();
}

/**
 * MediaInfoService - Extract metadata from video files using ffprobe
 */
export class MediaInfoService {
	private static instance: MediaInfoService;

	private constructor() {}

	static getInstance(): MediaInfoService {
		if (!MediaInfoService.instance) {
			MediaInfoService.instance = new MediaInfoService();
		}
		return MediaInfoService.instance;
	}

	/**
	 * Extract media information from a video file
	 *
	 * @param filePath - Full path to the video file
	 * @param options - Extraction options
	 * @returns MediaInfo object or null if extraction fails
	 */
	async extractMediaInfo(
		filePath: string,
		options: {
			allowStrmProbe?: boolean;
			onStrmProbeFallback?: (reason: string) => void;
			failOnInvalidStrmUrl?: boolean;
		} = {}
	): Promise<MediaInfo | null> {
		try {
			const { allowStrmProbe = true, onStrmProbeFallback, failOnInvalidStrmUrl = false } = options;
			// Handle .strm files specially - they are streaming placeholders, not real video files
			const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
			if (ext === '.strm') {
				if (!allowStrmProbe) {
					onStrmProbeFallback?.('STRM probing disabled');
					return this.getStrmMediaInfo();
				}
				const content = await readFile(filePath, 'utf8');
				const strmUrl = parseStrmUrl(content);
				if (!strmUrl) {
					if (failOnInvalidStrmUrl) {
						throw new Error('STRM file has no URL');
					}
					onStrmProbeFallback?.('STRM file has no URL');
					return this.getStrmMediaInfo();
				}

				let parsedUrl: URL;
				try {
					parsedUrl = new URL(strmUrl);
				} catch {
					if (failOnInvalidStrmUrl) {
						throw new Error('Invalid STRM URL');
					}
					onStrmProbeFallback?.('Invalid STRM URL');
					return this.getStrmMediaInfo();
				}

				if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
					if (failOnInvalidStrmUrl) {
						throw new Error(`Unsupported STRM URL protocol: ${parsedUrl.protocol}`);
					}
					onStrmProbeFallback?.(`Unsupported STRM URL protocol: ${parsedUrl.protocol}`);
					return this.getStrmMediaInfo();
				}

				try {
					const output = await runFFprobe(strmUrl, {
						timeout: 8000,
						rwTimeoutMs: 8000,
						probeSize: 5_000_000,
						analyzeDuration: 5_000_000
					});

					if (!output) {
						onStrmProbeFallback?.('FFprobe returned no output');
						return this.getStrmMediaInfo();
					}

					return this.parseFFprobeOutput(output);
				} catch (error) {
					logger.debug(
						{
							filePath,
							error: error instanceof Error ? error.message : String(error)
						},
						'[MediaInfoService] STRM probe failed'
					);
					onStrmProbeFallback?.(
						error instanceof Error ? error.message : 'Unknown STRM probe error'
					);
					return this.getStrmMediaInfo();
				}
			}

			// Run ffprobe on the file
			let output = await runFFprobe(filePath);

			// If no video stream found, try extended analysis
			if (output && !getPrimaryVideoStream(output)) {
				logger.debug(
					{ filePath },
					'[MediaInfoService] No video stream in initial probe, trying extended analysis'
				);
				output = await runFFprobeExtended(filePath);
			}

			if (!output) {
				logger.error({ filePath }, '[MediaInfoService] FFprobe failed');
				return null;
			}

			return this.parseFFprobeOutput(output);
		} catch (error) {
			logger.error(
				{ err: error instanceof Error ? error : undefined, ...{ filePath } },
				'[MediaInfoService] Failed to extract info'
			);
			// Allow callers (e.g. reprobe task) to treat malformed .strm URLs as hard failures.
			if (options.failOnInvalidStrmUrl) {
				throw error instanceof Error ? error : new Error(String(error));
			}
			return null;
		}
	}

	/**
	 * Generate synthetic media info for .strm streaming files
	 * These are placeholders that point to HLS streams, not actual video files
	 */
	private getStrmMediaInfo(): MediaInfo {
		return {
			containerFormat: 'strm',
			videoCodec: 'HLS',
			videoProfile: 'Streaming',
			width: 1920,
			height: 1080,
			fps: 24,
			audioCodec: 'AAC',
			audioChannels: 2
		};
	}

	/**
	 * Parse FFprobe output into MediaInfo object
	 */
	private parseFFprobeOutput(output: FFprobeOutput): MediaInfo {
		const videoStream = getPrimaryVideoStream(output);
		const audioStream = getPrimaryAudioStream(output);
		const audioStreams = getAudioStreams(output);
		const subtitleStreams = getSubtitleStreams(output);

		// Build media info object
		const mediaInfo: MediaInfo = {
			containerFormat: output.format.format_name || undefined
		};

		// Extract video info
		if (videoStream) {
			mediaInfo.videoCodec = getCodecDisplayName(videoStream.codec_name);
			mediaInfo.videoProfile = videoStream.profile || undefined;
			mediaInfo.videoBitrate = videoStream.bit_rate
				? parseInt(videoStream.bit_rate, 10)
				: undefined;
			mediaInfo.videoBitDepth = extractBitDepth(
				videoStream.pix_fmt,
				videoStream.bits_per_raw_sample
			);
			mediaInfo.width = videoStream.width || undefined;
			mediaInfo.height = videoStream.height || undefined;

			// Calculate FPS from frame rate
			mediaInfo.fps = parseFrameRate(videoStream.avg_frame_rate || videoStream.r_frame_rate);

			// Detect HDR format from color properties and side data
			mediaInfo.videoHdrFormat = detectHdrFormat(videoStream);
		}

		// Extract duration/runtime from format
		if (output.format.duration) {
			mediaInfo.runtime = Math.round(parseFloat(output.format.duration));
		}

		// Extract audio info from primary audio stream
		if (audioStream) {
			mediaInfo.audioCodec = getCodecDisplayName(audioStream.codec_name);
			mediaInfo.audioChannels = audioStream.channels || undefined;
			mediaInfo.audioBitrate = audioStream.bit_rate
				? parseInt(audioStream.bit_rate, 10)
				: undefined;
		}

		// Collect all audio languages
		if (audioStreams.length > 0) {
			mediaInfo.audioLanguages = audioStreams
				.map(getLanguageFromStream)
				.filter((lang): lang is string => lang !== undefined);
		}

		// Extract subtitle languages
		if (subtitleStreams.length > 0) {
			mediaInfo.subtitleLanguages = subtitleStreams
				.map(getLanguageFromStream)
				.filter((lang): lang is string => lang !== undefined);
		}

		return mediaInfo;
	}

	/**
	 * Get a human-readable resolution string from dimensions
	 */
	static getResolutionLabel(width?: number, height?: number): string {
		if (!height) return 'Unknown';

		if (height >= 2160) return '4K';
		if (height >= 1440) return '1440p';
		if (height >= 1080) return '1080p';
		if (height >= 720) return '720p';
		if (height >= 576) return '576p';
		if (height >= 480) return '480p';
		return `${height}p`;
	}

	/**
	 * Get a human-readable audio channel layout string
	 */
	static getAudioChannelLabel(channels?: number): string {
		if (!channels) return 'Unknown';

		switch (channels) {
			case 1:
				return 'Mono';
			case 2:
				return 'Stereo';
			case 6:
				return '5.1';
			case 8:
				return '7.1';
			default:
				return `${channels}ch`;
		}
	}

	/**
	 * Format file size in human-readable format
	 */
	static formatFileSize(bytes?: number): string {
		if (!bytes) return 'Unknown';

		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		let size = bytes;
		let unitIndex = 0;

		while (size >= 1024 && unitIndex < units.length - 1) {
			size /= 1024;
			unitIndex++;
		}

		return `${size.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
	}

	/**
	 * Format runtime in human-readable format
	 */
	static formatRuntime(seconds?: number): string {
		if (!seconds) return 'Unknown';

		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);

		if (hours > 0) {
			return `${hours}h ${minutes}m`;
		}
		return `${minutes}m`;
	}
}

export const mediaInfoService = MediaInfoService.getInstance();
