/**
 * Resolution labelling for streaming (.strm) imports.
 *
 * A .strm file has no intrinsic resolution: the source is resolved at playback
 * time and the gateway can now return real 2160p streams. The probed height is
 * the only authoritative signal, so prefer it; fall back to the parsed release
 * name, and report 'unknown' rather than inventing a tier when neither says
 * anything. Stamping 1080p here used to hide 4K sources from quality badges,
 * best-file selection and multi-quality bookkeeping.
 */
import type { ParsedRelease, Resolution } from '#lib/server/indexers/parser/types.js';

/** The subset of a probe result that carries resolution evidence. */
export interface ProbedVideoInfo {
	height?: number | null;
	containerFormat?: string | null;
}

/** Map a probed video height to the release-resolution vocabulary. */
export function resolutionFromHeight(height: number | null | undefined): Resolution | undefined {
	if (!height || height <= 0) return undefined;
	if (height >= 2160) return '2160p';
	if (height >= 1080) return '1080p';
	if (height >= 720) return '720p';
	if (height >= 480) return '480p';
	return 'unknown';
}

/**
 * True for the synthetic metadata `getStrmMediaInfo` returns when a .strm could
 * not be probed. Its 1920x1080 fields are placeholder constants, not evidence,
 * so they must never decide the stored resolution.
 */
function isSyntheticStrmInfo(mediaInfo: ProbedVideoInfo | null | undefined): boolean {
	return mediaInfo?.containerFormat === 'strm';
}

/**
 * Resolve the stored resolution for a streaming import.
 *
 * Order: real probed height, then the parsed release title, then 'unknown'.
 */
export function resolveStreamingResolution(
	mediaInfo: ProbedVideoInfo | null | undefined,
	parsedResolution: Resolution | undefined
): Resolution {
	const probed = isSyntheticStrmInfo(mediaInfo)
		? undefined
		: resolutionFromHeight(mediaInfo?.height);
	if (probed) return probed;
	return parsedResolution && parsedResolution !== 'unknown' ? parsedResolution : 'unknown';
}

/** Persisted quality blob for a streaming (.strm) file row. */
export interface StreamingQuality {
	resolution: Resolution;
	source: 'Streaming';
	codec: 'HLS';
	hdr: undefined;
}

/** Build the stored quality blob from a probe result and the parsed release. */
export function buildStreamingQuality(
	mediaInfo: ProbedVideoInfo | null | undefined,
	parsedRelease: Pick<ParsedRelease, 'resolution'> | undefined
): StreamingQuality {
	return {
		resolution: resolveStreamingResolution(mediaInfo, parsedRelease?.resolution),
		source: 'Streaming',
		codec: 'HLS',
		hdr: undefined
	};
}
