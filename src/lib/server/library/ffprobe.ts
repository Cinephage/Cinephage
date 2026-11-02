/**
 * FFprobe Executor
 *
 * Spawns ffprobe CLI to extract media metadata as JSON.
 * This replaces native node-av bindings to avoid Vite SSR bundling issues.
 *
 * Follows the same approach used by Sonarr/Radarr.
 */

import { spawn } from 'child_process';
import { access } from 'fs/promises';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'scans' as const });

// =============================================================================
// Types
// =============================================================================

/**
 * FFprobe stream disposition flags
 */
export interface FFprobeDisposition {
	default: number;
	dub: number;
	original: number;
	comment: number;
	lyrics: number;
	karaoke: number;
	forced: number;
	hearing_impaired: number;
	visual_impaired: number;
	clean_effects: number;
	attached_pic: number;
	timed_thumbnails: number;
}

/**
 * FFprobe stream tags
 */
export interface FFprobeTags {
	language?: string;
	title?: string;
	handler_name?: string;
	DURATION?: string;
	BPS?: string;
	NUMBER_OF_FRAMES?: string;
	NUMBER_OF_BYTES?: string;
	[key: string]: string | undefined;
}

/**
 * FFprobe side data (for HDR metadata)
 */
export interface FFprobeSideData {
	side_data_type: string;
	// Mastering display metadata
	red_x?: string;
	red_y?: string;
	green_x?: string;
	green_y?: string;
	blue_x?: string;
	blue_y?: string;
	white_point_x?: string;
	white_point_y?: string;
	min_luminance?: string;
	max_luminance?: string;
	// Content light level
	max_content?: number;
	max_average?: number;
	// Dolby Vision
	dv_version_major?: number;
	dv_version_minor?: number;
	dv_profile?: number;
	dv_level?: number;
	dv_bl_present_flag?: number;
	dv_el_present_flag?: number;
	dv_bl_signal_compatibility_id?: number;
	// HDR10+
	application_version?: number;
}

/**
 * FFprobe stream information
 */
export interface FFprobeStream {
	index: number;
	codec_name?: string;
	codec_long_name?: string;
	codec_type: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment';
	codec_tag_string?: string;
	codec_tag?: string;
	profile?: string;

	// Video-specific
	width?: number;
	height?: number;
	coded_width?: number;
	coded_height?: number;
	has_b_frames?: number;
	pix_fmt?: string;
	level?: number;
	color_range?: string;
	color_space?: string;
	color_transfer?: string;
	color_primaries?: string;
	chroma_location?: string;
	refs?: number;
	r_frame_rate?: string;
	avg_frame_rate?: string;
	bits_per_raw_sample?: string;
	field_order?: string;

	// Audio-specific
	sample_fmt?: string;
	sample_rate?: string;
	channels?: number;
	channel_layout?: string;
	bits_per_sample?: number;

	// Common
	bit_rate?: string;
	duration?: string;
	duration_ts?: number;
	start_pts?: number;
	start_time?: string;
	nb_frames?: string;
	disposition?: FFprobeDisposition;
	tags?: FFprobeTags;
	side_data_list?: FFprobeSideData[];
}

/**
 * FFprobe format information
 */
export interface FFprobeFormat {
	filename: string;
	nb_streams: number;
	nb_programs: number;
	format_name: string;
	format_long_name: string;
	start_time?: string;
	duration?: string;
	size?: string;
	bit_rate?: string;
	probe_score: number;
	tags?: FFprobeTags;
}

/**
 * Complete FFprobe output
 */
export interface FFprobeOutput {
	streams: FFprobeStream[];
	format: FFprobeFormat;
}

/**
 * FFprobe execution options
 */
export interface FFprobeOptions {
	/** Timeout in milliseconds (default: 30000) */
	timeout?: number;
	/** Custom ffprobe path (default: 'ffprobe' from PATH) */
	ffprobePath?: string;
	/** Probe size in bytes (default: 50MB for better HDR detection) */
	probeSize?: number;
	/** Analyze duration in microseconds */
	analyzeDuration?: number;
	/** Network read/write timeout in milliseconds (applies to http/https) */
	rwTimeoutMs?: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_TIMEOUT = 30000; // 30 seconds
const DEFAULT_PROBE_SIZE = 50_000_000; // 50MB - needed for proper HDR metadata detection
const DEFAULT_FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';

// =============================================================================
// Concurrency limiter
// =============================================================================

// Caps simultaneous ffprobe processes at 1. On NAS-backed Docker volumes (e.g.
// TerraStation OS), ffprobe enters an uninterruptible D-state wait on file I/O.
// SIGKILL cannot terminate D-state processes, so timed-out probes accumulate as
// zombie processes that continue to saturate the NAS I/O queue. A semaphore of 1
// ensures at most one probe is running at any time, bounding the blast radius to
// a single hung process even when the scan processes many files.
class Semaphore {
	private slots: number;
	private readonly queue: Array<() => void> = [];

	constructor(limit: number) {
		this.slots = limit;
	}

	acquire(): Promise<void> {
		if (this.slots > 0) {
			this.slots--;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => this.queue.push(resolve));
	}

	release(): void {
		const next = this.queue.shift();
		if (next) {
			next();
		} else {
			this.slots++;
		}
	}
}

const ffprobeSemaphore = new Semaphore(Number(process.env.FFPROBE_CONCURRENCY ?? 1));

// =============================================================================
// FFprobe Executor
// =============================================================================

/**
 * Check if ffprobe is available in PATH
 */
export async function isFFprobeAvailable(ffprobePath?: string): Promise<boolean> {
	const path = ffprobePath || DEFAULT_FFPROBE_PATH;

	return new Promise((resolve) => {
		const proc = spawn(path, ['-version'], {
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let output = '';
		proc.stdout.on('data', (data) => {
			output += data.toString();
		});

		proc.on('error', () => {
			resolve(false);
		});

		const timeoutId = setTimeout(() => {
			proc.kill();
			resolve(false);
		}, 5000);

		proc.on('close', (code) => {
			clearTimeout(timeoutId);
			resolve(code === 0 && output.includes('ffprobe'));
		});
	});
}

/**
 * Get ffprobe version string
 */
export async function getFFprobeVersion(ffprobePath?: string): Promise<string | null> {
	const path = ffprobePath || DEFAULT_FFPROBE_PATH;

	return new Promise((resolve) => {
		const proc = spawn(path, ['-version'], {
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let output = '';
		proc.stdout.on('data', (data) => {
			output += data.toString();
		});

		proc.on('error', () => {
			resolve(null);
		});

		const timeoutId = setTimeout(() => {
			proc.kill();
			resolve(null);
		}, 5000);

		proc.on('close', (code) => {
			clearTimeout(timeoutId);
			if (code === 0) {
				// Extract version from first line: "ffprobe version X.X.X ..."
				const match = output.match(/ffprobe version (\S+)/);
				resolve(match ? match[1] : null);
			} else {
				resolve(null);
			}
		});
	});
}

/**
 * Execute ffprobe on a file and return parsed JSON output
 *
 * @param filePath - Path to the media file
 * @param options - Execution options
 * @returns Parsed FFprobe output or null on failure
 */
export async function runFFprobe(
	filePath: string,
	options: FFprobeOptions = {}
): Promise<FFprobeOutput | null> {
	const {
		timeout = DEFAULT_TIMEOUT,
		ffprobePath = DEFAULT_FFPROBE_PATH,
		probeSize = DEFAULT_PROBE_SIZE,
		analyzeDuration,
		rwTimeoutMs
	} = options;

	// Verify file exists first
	try {
		const isRemote = /^https?:\/\//i.test(filePath);
		if (!isRemote) {
			await access(filePath);
		}
	} catch {
		logger.error({ filePath }, '[FFprobe] File not accessible');
		return null;
	}

	// Build ffprobe arguments
	const args = [
		'-v',
		'quiet', // Suppress logging
		'-print_format',
		'json', // Output as JSON
		'-show_format', // Include format/container info
		'-show_streams', // Include stream info
		'-probesize',
		probeSize.toString()
	];

	if (analyzeDuration) {
		args.push('-analyzeduration', analyzeDuration.toString());
	}
	if (rwTimeoutMs && rwTimeoutMs > 0) {
		// ffprobe expects microseconds
		args.push('-rw_timeout', String(Math.floor(rwTimeoutMs * 1000)));
	}

	args.push(filePath);

	await ffprobeSemaphore.acquire();
	try {
		return await new Promise((resolve) => {
			const proc = spawn(ffprobePath, args, {
				stdio: ['ignore', 'pipe', 'pipe']
			});

			let stdout = '';
			let stderr = '';

			proc.stdout.on('data', (data) => {
				stdout += data.toString();
			});

			proc.stderr.on('data', (data) => {
				stderr += data.toString();
			});

			proc.on('error', (err) => {
				logger.error({ err }, '[FFprobe] Failed to spawn');
				resolve(null);
			});

			proc.on('close', (code) => {
				if (code !== 0) {
					const isRemote = /^https?:\/\//i.test(filePath);
					if (isRemote) {
						const stderrText = stderr.trim();
						// STRM URL probes often fail and fall back to placeholder media info.
						// Silence expected remote failures unless ffprobe emitted useful diagnostics.
						if (stderrText) {
							logger.debug(
								{
									code,
									stderr: stderrText
								},
								'[FFprobe] Remote probe exited with non-zero code'
							);
						}
					} else {
						logger.error({ code, stderr }, '[FFprobe] Exited with non-zero code');
					}
					resolve(null);
					return;
				}

				try {
					const output = JSON.parse(stdout) as FFprobeOutput;
					resolve(output);
				} catch (err) {
					logger.error({ err }, '[FFprobe] Failed to parse JSON output');
					resolve(null);
				}
			});

			// Timeout handler
			const timeoutId = setTimeout(() => {
				logger.error({ timeout, filePath }, '[FFprobe] Timeout');
				proc.kill('SIGKILL');
				resolve(null);
			}, timeout);

			proc.on('close', () => {
				clearTimeout(timeoutId);
			});
		});
	} finally {
		ffprobeSemaphore.release();
	}
}

/**
 * Run ffprobe with extended analysis for problematic files
 * Uses larger probe size and analyze duration
 */
export async function runFFprobeExtended(
	filePath: string,
	options: FFprobeOptions = {}
): Promise<FFprobeOutput | null> {
	return runFFprobe(filePath, {
		...options,
		probeSize: 150_000_000, // 150MB
		analyzeDuration: 150_000_000, // 150 seconds in microseconds
		timeout: options.timeout || 60000 // 60 second timeout for extended analysis
	});
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get audio streams from FFprobe output
 */
export function getAudioStreams(output: FFprobeOutput): FFprobeStream[] {
	return output.streams.filter((s) => s.codec_type === 'audio');
}

/**
 * Get subtitle streams from FFprobe output
 */
export function getSubtitleStreams(output: FFprobeOutput): FFprobeStream[] {
	return output.streams.filter((s) => s.codec_type === 'subtitle');
}

/**
 * Get primary video stream (first video stream)
 */
export function getPrimaryVideoStream(output: FFprobeOutput): FFprobeStream | undefined {
	return output.streams.find((s) => s.codec_type === 'video');
}

/**
 * Get primary audio stream (first audio or one marked as default)
 */
export function getPrimaryAudioStream(output: FFprobeOutput): FFprobeStream | undefined {
	const audioStreams = getAudioStreams(output);
	if (audioStreams.length === 0) return undefined;

	// Prefer stream marked as default
	const defaultStream = audioStreams.find((s) => s.disposition?.default === 1);
	return defaultStream || audioStreams[0];
}

/**
 * Check if stream has Dolby Vision side data
 */
export function hasDolbyVisionSideData(stream: FFprobeStream): boolean {
	if (!stream.side_data_list) return false;
	return stream.side_data_list.some(
		(sd) => sd.side_data_type === 'DOVI configuration record' || sd.dv_profile !== undefined
	);
}

/**
 * Check if stream has HDR10+ side data
 */
export function hasHDR10PlusSideData(stream: FFprobeStream): boolean {
	if (!stream.side_data_list) return false;
	return stream.side_data_list.some(
		(sd) =>
			sd.side_data_type === 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)' ||
			sd.side_data_type?.includes('SMPTE2094') ||
			sd.side_data_type?.includes('HDR10+')
	);
}

/**
 * Check if stream has HDR10 mastering display metadata
 */
export function hasHDR10MasteringMetadata(stream: FFprobeStream): boolean {
	if (!stream.side_data_list) return false;
	return stream.side_data_list.some(
		(sd) =>
			sd.side_data_type === 'Mastering display metadata' ||
			sd.side_data_type === 'Content light level metadata'
	);
}

/**
 * Get Dolby Vision profile from side data
 */
export function getDolbyVisionProfile(stream: FFprobeStream): number | undefined {
	if (!stream.side_data_list) return undefined;
	const dvData = stream.side_data_list.find(
		(sd) => sd.side_data_type === 'DOVI configuration record' || sd.dv_profile !== undefined
	);
	return dvData?.dv_profile;
}

/**
 * Parse frame rate string (e.g., "24000/1001") to number
 */
export function parseFrameRate(frameRateStr?: string): number | undefined {
	if (!frameRateStr) return undefined;

	if (frameRateStr.includes('/')) {
		const [num, den] = frameRateStr.split('/').map(Number);
		if (den === 0) return undefined;
		return Math.round((num / den) * 100) / 100;
	}

	const rate = parseFloat(frameRateStr);
	return isNaN(rate) ? undefined : rate;
}
