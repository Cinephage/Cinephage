/**
 * HLS-to-TS Converter
 *
 * Converts an HLS live stream into a continuous MPEG-TS byte stream for
 * media server consumption (Jellyfin, Plex, Emby).
 *
 * BACKGROUND / WHY THIS EXISTS:
 * Media servers' M3U tuners (e.g. Jellyfin's HDHomeRun/M3U tuner) expect a
 * continuous MPEG-TS byte stream when tuning to a channel. They cannot consume
 * HLS playlists directly. Meanwhile, stalker portal IPTV providers enforce
 * single-use play_tokens with per-token session time limits (~24 seconds of
 * wall-clock streaming in raw TS mode). When the TS connection drops and
 * reconnects with a new token, the server replays ~20 seconds of overlapping
 * content from its internal buffer origin, creating a visible 30-45 second
 * loop for the viewer.
 *
 * HLS mode avoids the replay problem entirely because:
 * - Each playlist fetch consumes a token but returns independently-addressable
 *   segment URLs (hash-based paths on the backend, e.g. /hls/{hash}/xxx.ts)
 * - Segments are fetchable without additional auth after the initial redirect
 * - Calling createLink() again yields a fresh token and a new playlist with
 *   overlapping + new segments, tracked by EXT-X-MEDIA-SEQUENCE
 *
 * This converter bridges the gap: it speaks HLS to the portal (avoiding
 * replay) and speaks continuous TS to the media server (meeting its format
 * expectation).
 *
 * FLOW:
 * 1. Resolve a fresh stream URL via createLink (new play_token)
 * 2. Fetch the HLS playlist (consumes the token on 302 redirect)
 * 3. If master playlist detected, fetch the best quality variant
 * 4. Parse segment URLs from the media playlist
 * 5. Download segments in order, skipping already-delivered ones
 * 6. Write segment bytes to the output ReadableStream
 * 7. Wait for half the target duration, then repeat from step 1
 *
 * SEGMENT TRACKING:
 * Uses EXT-X-MEDIA-SEQUENCE + position to assign a global sequence number
 * to each segment. Only segments with sequence > lastDelivered are fetched.
 * This prevents duplicate content even across playlist refreshes with
 * overlapping segment lists.
 *
 * ERROR HANDLING:
 * - Individual segment fetch failures are logged and skipped (stream continues)
 * - Playlist-level errors trigger exponential backoff (1s, 2s, 4s, 8s, 16s)
 * - After maxConsecutiveErrors (default 5), the stream terminates with an error
 * - Client disconnect (AbortSignal) cleanly cancels the loop
 */

import { createChildLogger } from '#lib/logging/index.js';
import { getStreamUrlCache } from './StreamUrlCache.js';
import { getLiveTvStreamService } from './LiveTvStreamService.js';
import { resolveHlsUrl } from '#lib/server/streaming/utils/hls-rewrite.js';
import { resolveAndValidateUrl } from '#lib/server/http/ssrf-protection.js';

const logger = createChildLogger({ module: 'HlsToTsConverter' });

/** Parsed segment from an HLS playlist */
interface HlsSegment {
	url: string;
	duration: number;
	sequence: number;
}

/** Parsed HLS playlist metadata */
interface ParsedPlaylist {
	segments: HlsSegment[];
	mediaSequence: number;
	targetDuration: number;
}

/** HLS variant stream from a master playlist */
interface HlsVariant {
	url: string;
	bandwidth: number;
	resolution?: string;
	codecs?: string;
}

/**
 * Parse an HLS media playlist into structured segment data.
 *
 * @param playlistText - Raw HLS playlist text
 * @param playlistUrl - The final URL of the playlist (after redirects) for resolving relative URLs
 * @returns Parsed playlist with segments and metadata
 */
function parseHlsPlaylist(playlistText: string, playlistUrl: string): ParsedPlaylist {
	const lines = playlistText.split('\n');
	const segments: HlsSegment[] = [];

	let mediaSequence = 0;
	let targetDuration = 10;
	let currentDuration = 0;
	let segmentIndex = 0;

	const base = new URL(playlistUrl);
	const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
			mediaSequence = parseInt(trimmed.split(':')[1], 10) || 0;
		} else if (trimmed.startsWith('#EXT-X-TARGETDURATION:')) {
			targetDuration = parseInt(trimmed.split(':')[1], 10) || 10;
		} else if (trimmed.startsWith('#EXTINF:')) {
			// Parse duration: #EXTINF:10.243556,
			const durationStr = trimmed.substring(8).split(',')[0];
			currentDuration = parseFloat(durationStr) || 0;
		} else if (trimmed && !trimmed.startsWith('#')) {
			// This is a segment URL line
			const absoluteUrl = resolveHlsUrl(trimmed, base, basePath);
			segments.push({
				url: absoluteUrl,
				duration: currentDuration,
				sequence: mediaSequence + segmentIndex
			});
			segmentIndex++;
			currentDuration = 0;
		}
	}

	return { segments, mediaSequence, targetDuration };
}

/**
 * Check if the playlist is a master playlist (contains variant streams)
 */
function isMasterPlaylist(playlistText: string): boolean {
	return playlistText.includes('#EXT-X-STREAM-INF');
}

/**
 * Parse an HLS master playlist and extract variant streams.
 *
 * @param playlistText - Raw master playlist text
 * @param playlistUrl - The final URL of the playlist for resolving relative URLs
 * @returns Array of variant streams sorted by bandwidth (highest first)
 */
function parseMasterPlaylist(playlistText: string, playlistUrl: string): HlsVariant[] {
	const lines = playlistText.split('\n');
	const variants: HlsVariant[] = [];

	const base = new URL(playlistUrl);
	const basePath = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);

	let currentVariant: Partial<HlsVariant> = {};

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed.startsWith('#EXT-X-STREAM-INF:')) {
			// Parse variant attributes: BANDWIDTH, RESOLUTION, CODECS
			const attributes = trimmed.substring(18); // Remove '#EXT-X-STREAM-INF:'

			// Extract BANDWIDTH
			const bandwidthMatch = attributes.match(/BANDWIDTH=(\d+)/);
			currentVariant.bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;

			// Extract RESOLUTION
			const resolutionMatch = attributes.match(/RESOLUTION=(\d+x\d+)/);
			currentVariant.resolution = resolutionMatch ? resolutionMatch[1] : undefined;

			// Extract CODECS
			const codecsMatch = attributes.match(/CODECS="([^"]+)"/);
			currentVariant.codecs = codecsMatch ? codecsMatch[1] : undefined;
		} else if (trimmed && !trimmed.startsWith('#') && currentVariant.bandwidth !== undefined) {
			// This is a variant URL line
			const absoluteUrl = resolveHlsUrl(trimmed, base, basePath);
			variants.push({
				url: absoluteUrl,
				bandwidth: currentVariant.bandwidth || 0,
				resolution: currentVariant.resolution,
				codecs: currentVariant.codecs
			});
			currentVariant = {};
		}
	}

	// Sort by bandwidth (highest first)
	variants.sort((a, b) => b.bandwidth - a.bandwidth);

	return variants;
}

/**
 * Select the best variant from a master playlist.
 * Prefers variants with video codecs, falling back to highest bandwidth.
 *
 * @param variants - Array of variant streams (should be sorted by bandwidth desc)
 * @returns The best variant URL or null if no variants found
 */
function selectBestVariant(variants: HlsVariant[]): string | null {
	if (variants.length === 0) {
		return null;
	}

	// Prefer variants with video codecs (avc1, hvc1, etc.)
	// Filter out audio-only streams
	const videoVariants = variants.filter((v) => {
		if (!v.codecs) return true; // Assume video if no codec info
		const hasVideoCodec = /avc1|hvc1|hev1|av01|vp9/.test(v.codecs);
		return hasVideoCodec;
	});

	// Use first video variant, or fallback to first variant overall
	const selected = videoVariants.length > 0 ? videoVariants[0] : variants[0];

	logger.debug(
		{
			bandwidth: selected.bandwidth,
			resolution: selected.resolution,
			codecs: selected.codecs,
			totalVariants: variants.length
		},
		'[HlsToTsConverter] Selected variant from master playlist'
	);

	return selected.url;
}

/** Options for the HLS-to-TS converter */
export interface HlsToTsConverterOptions {
	/** Lineup item ID for stream URL resolution */
	lineupItemId: string;
	/** Already-fetched playlist body from the request handler's HLS probe */
	initialPlaylist?: {
		body: ReadableStream<Uint8Array>;
		finalUrl: string;
		providerHeaders?: Record<string, string>;
	};
	/** Timeout for individual segment fetches (ms) */
	segmentFetchTimeoutMs?: number;
	/** Maximum consecutive errors before giving up */
	maxConsecutiveErrors?: number;
	/** AbortSignal to cancel the conversion */
	signal?: AbortSignal;
}

const DEFAULT_SEGMENT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
// How long to wait between playlist refreshes (fraction of target duration)
const PLAYLIST_REFRESH_RATIO = 0.5;
// Minimum interval between playlist refreshes (ms)
const MIN_PLAYLIST_REFRESH_MS = 2_000;
const MAX_HLS_PLAYLIST_BYTES = 5 * 1024 * 1024;
const MAX_HLS_REDIRECTS = 5;
const MAX_HLS_SEGMENT_BYTES = 50 * 1024 * 1024;

async function readBoundedText(response: Response, signal?: AbortSignal): Promise<string> {
	if (!response.body) throw new Error('HLS response has no body');
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytesRead = 0;
	let text = '';
	const abort = () => void reader.cancel();
	signal?.addEventListener('abort', abort, { once: true });
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return text + decoder.decode();
			bytesRead += value.byteLength;
			if (bytesRead > MAX_HLS_PLAYLIST_BYTES) {
				await reader.cancel();
				throw new Error('HLS playlist exceeds the maximum allowed size');
			}
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		signal?.removeEventListener('abort', abort);
		reader.releaseLock();
	}
}

/**
 * Create a ReadableStream that converts an HLS live stream into continuous TS bytes.
 *
 * The stream will continue indefinitely until cancelled (client disconnects)
 * or too many consecutive errors occur. Each playlist refresh cycle requests
 * a new play_token from the portal via createLink(), so the stream is not
 * limited by the portal's per-token session timeout.
 *
 * @param options - Configuration including lineupItemId, timeouts, and abort signal
 * @returns ReadableStream of MPEG-TS bytes suitable for media server consumption
 */
export function createHlsToTsStream(options: HlsToTsConverterOptions): ReadableStream<Uint8Array> {
	const {
		lineupItemId,
		segmentFetchTimeoutMs = DEFAULT_SEGMENT_FETCH_TIMEOUT_MS,
		maxConsecutiveErrors = DEFAULT_MAX_CONSECUTIVE_ERRORS,
		signal,
		initialPlaylist
	} = options;

	let lastDeliveredSequence = -1;
	let consecutiveErrors = 0;
	let cancelled = false;
	let tsFallbackActive = false;
	let pendingInitialPlaylist = initialPlaylist;
	const conversionController = new AbortController();
	const conversionSignal = conversionController.signal;
	const abortConversion = () => {
		cancelled = true;
		conversionController.abort(signal?.reason);
	};

	async function pipeTsStream(
		response: Response,
		controller: ReadableStreamDefaultController<Uint8Array>
	): Promise<void> {
		const reader = response.body!.getReader();
		try {
			while (!cancelled) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value && value.length > 0) {
					controller.enqueue(value);
					lastDeliveredSequence++;
					consecutiveErrors = 0;
				}
			}
		} catch (error) {
			if (!cancelled) {
				throw error;
			}
		} finally {
			try {
				if (cancelled) await reader.cancel();
			} catch {
				// Upstream may already be closed.
			}
			try {
				reader.releaseLock();
			} catch {
				// Reader may already be released
			}
		}
	}

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			if (signal?.aborted) {
				abortConversion();
				controller.close();
				return;
			}
			// Listen for abort signal
			if (signal) {
				signal.addEventListener(
					'abort',
					() => {
						abortConversion();
						try {
							controller.close();
						} catch {
							// Already closed
						}
					},
					{ once: true }
				);
			}

			try {
				await runConversionLoop(controller);
			} catch (error) {
				if (!cancelled) {
					const msg = error instanceof Error ? error.message : String(error);
					logger.error(
						{
							err: error,
							...{
								lineupItemId,
								lastDeliveredSequence
							}
						},
						'[HlsToTsConverter] Fatal error in conversion loop'
					);
					try {
						controller.error(new Error(`HLS-to-TS conversion failed: ${msg}`));
					} catch {
						// Already errored/closed
					}
				}
			}
		},

		cancel() {
			abortConversion();
			logger.debug({ lineupItemId }, '[HlsToTsConverter] Stream cancelled by consumer');
		}
	});

	async function runConversionLoop(controller: ReadableStreamDefaultController<Uint8Array>) {
		const urlCache = getStreamUrlCache();
		const streamService = getLiveTvStreamService();

		logger.info({ lineupItemId }, '[HlsToTsConverter] Starting HLS-to-TS conversion');

		while (!cancelled) {
			try {
				let response: Response;
				let finalUrl: string;
				let providerHeaders: Record<string, string> | undefined;

				if (pendingInitialPlaylist) {
					const initial = pendingInitialPlaylist;
					pendingInitialPlaylist = undefined;
					response = new Response(initial.body, { status: 200 });
					finalUrl = initial.finalUrl;
					providerHeaders = initial.providerHeaders;
				} else {
					// 1. Resolve a fresh stream URL (new play_token via createLink)
					const resolved = await urlCache.getStream(lineupItemId, tsFallbackActive ? 'ts' : 'hls');

					// 2. Invalidate cache immediately — the token will be consumed by the fetch
					urlCache.invalidate(lineupItemId);

					// 3. Fetch the HLS playlist (or TS stream in fallback mode)
					const fetched = await streamService.fetchFromUrl(
						resolved.url,
						resolved.providerType,
						resolved.providerHeaders,
						conversionSignal
					);
					response = fetched.response;
					finalUrl = fetched.finalUrl;
					providerHeaders = resolved.providerHeaders;
				}

				if (!response.ok) {
					await response.body?.cancel();
					// If HLS mode is permanently rejected by the portal (4XX, not 404),
					// switch to direct TS fallback on the first attempt
					if (
						!tsFallbackActive &&
						lastDeliveredSequence === -1 &&
						response.status >= 400 &&
						response.status < 500 &&
						response.status !== 404 &&
						response.status !== 401 &&
						response.status !== 403
					) {
						logger.info(
							{
								lineupItemId,
								status: response.status
							},
							'[HlsToTsConverter] HLS rejected by portal, switching to TS fallback'
						);
						tsFallbackActive = true;
						consecutiveErrors = 0;
						continue;
					}
					throw new Error(`Playlist fetch failed: ${response.status}`);
				}

				// TS fallback mode — pipe response body directly
				if (tsFallbackActive) {
					if (!response.body) {
						throw new Error('TS stream has no body');
					}
					await pipeTsStream(response, controller);
					continue;
				}

				let playlistText = await readBoundedText(response, conversionSignal);

				if (!playlistText.includes('#EXTM3U')) {
					throw new Error('Invalid HLS playlist (no #EXTM3U header)');
				}

				// 4. Check if this is a master playlist and fetch the best variant
				let playlistUrl = finalUrl;
				if (isMasterPlaylist(playlistText)) {
					logger.info(
						{
							lineupItemId
						},
						'[HlsToTsConverter] Detected master playlist, selecting best variant'
					);

					const variants = parseMasterPlaylist(playlistText, finalUrl);
					const bestVariantUrl = selectBestVariant(variants);

					if (!bestVariantUrl) {
						throw new Error('Master playlist has no valid variants');
					}

					// Fetch the media playlist from the variant URL
					const variantResponse = await fetchHlsUrl(bestVariantUrl, {
						headers: {
							'User-Agent':
								'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 4 rev: 2116 Mobile Safari/533.3',
							Accept: '*/*',
							...providerHeaders
						},
						signal: conversionSignal
					});

					if (!variantResponse.ok) {
						await variantResponse.body?.cancel();
						throw new Error(`Variant playlist fetch failed: ${variantResponse.status}`);
					}

					playlistText = await readBoundedText(variantResponse, conversionSignal);
					playlistUrl = bestVariantUrl;
					logger.debug(
						{
							lineupItemId,
							variantUrl: bestVariantUrl.substring(0, 80)
						},
						'[HlsToTsConverter] Fetched variant playlist'
					);
				}

				// 5. Parse the media playlist
				const playlist = parseHlsPlaylist(playlistText, playlistUrl);

				if (playlist.segments.length === 0) {
					logger.warn({ lineupItemId }, '[HlsToTsConverter] Empty playlist');
					await sleep(1000, conversionSignal);
					continue;
				}

				logger.debug(
					{
						lineupItemId,
						segments: playlist.segments.length,
						mediaSequence: playlist.mediaSequence,
						targetDuration: playlist.targetDuration,
						lastDeliveredSequence
					},
					'[HlsToTsConverter] Playlist fetched'
				);

				// 6. Download and pipe new segments
				let newSegmentsDelivered = 0;

				for (const segment of playlist.segments) {
					if (cancelled) break;

					// Skip already-delivered segments
					if (segment.sequence <= lastDeliveredSequence) {
						continue;
					}

					try {
						const segmentData = await fetchSegment(
							segment.url,
							providerHeaders,
							segmentFetchTimeoutMs,
							conversionSignal
						);

						if (cancelled) break;

						// Write segment data to the stream
						controller.enqueue(segmentData);
						lastDeliveredSequence = segment.sequence;
						newSegmentsDelivered++;
						consecutiveErrors = 0;

						logger.debug(
							{
								lineupItemId,
								sequence: segment.sequence,
								size: segmentData.byteLength,
								duration: segment.duration
							},
							'[HlsToTsConverter] Segment delivered'
						);
					} catch (error) {
						if (cancelled) break;
						const msg = error instanceof Error ? error.message : String(error);
						logger.warn(
							{
								lineupItemId,
								sequence: segment.sequence,
								url: segment.url.substring(0, 80),
								error: msg
							},
							'[HlsToTsConverter] Segment fetch failed, skipping'
						);
						// Skip this segment and continue with the next
						lastDeliveredSequence = segment.sequence;
					}
				}

				if (cancelled) break;

				// 7. Calculate wait time before next playlist refresh
				// Use half the target duration, but at least MIN_PLAYLIST_REFRESH_MS
				const refreshInterval = Math.max(
					playlist.targetDuration * 1000 * PLAYLIST_REFRESH_RATIO,
					MIN_PLAYLIST_REFRESH_MS
				);

				if (newSegmentsDelivered === 0) {
					// No new segments — playlist hasn't advanced yet, wait a bit
					logger.debug(
						{
							lineupItemId,
							waitMs: refreshInterval
						},
						'[HlsToTsConverter] No new segments, waiting'
					);
				}

				await sleep(refreshInterval, conversionSignal);
				consecutiveErrors = 0;
			} catch (error) {
				if (cancelled) break;

				consecutiveErrors++;
				const msg = error instanceof Error ? error.message : String(error);
				logger.warn(
					{
						lineupItemId,
						consecutiveErrors,
						maxConsecutiveErrors,
						error: msg
					},
					'[HlsToTsConverter] Playlist cycle error'
				);

				if (consecutiveErrors >= maxConsecutiveErrors) {
					throw new Error(`Too many consecutive errors (${consecutiveErrors}): ${msg}`, {
						cause: error
					});
				}

				// Exponential backoff: 1s, 2s, 4s, 8s, 16s
				const backoff = Math.min(1000 * Math.pow(2, consecutiveErrors - 1), 16000);
				await sleep(backoff, conversionSignal);
			}
		}

		// Clean exit
		if (!cancelled) {
			try {
				controller.close();
			} catch {
				// Already closed
			}
		}

		logger.info(
			{
				lineupItemId,
				lastDeliveredSequence,
				cancelled
			},
			'[HlsToTsConverter] Conversion loop ended'
		);
	}
}

/**
 * Fetch a single HLS segment with timeout.
 *
 * Segment URLs on stalker backends use hash-based paths (e.g. /hls/{hash}/xxx.ts)
 * that are independently accessible without auth headers after the initial
 * playlist redirect. The STB User-Agent is still sent for compatibility.
 */
export async function fetchSegment(
	url: string,
	providerHeaders?: Record<string, string>,
	timeoutMs: number = DEFAULT_SEGMENT_FETCH_TIMEOUT_MS,
	externalSignal?: AbortSignal
): Promise<Uint8Array> {
	throwIfAborted(externalSignal);
	await validateHlsUrl(url);
	throwIfAborted(externalSignal);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const abort = () => controller.abort();
	externalSignal?.addEventListener('abort', abort, { once: true });

	try {
		const response = await fetchHlsUrl(
			url,
			{
				headers: {
					'User-Agent':
						'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 4 rev: 2116 Mobile Safari/533.3',
					Accept: '*/*',
					...providerHeaders
				}
			},
			controller.signal
		);

		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Segment HTTP ${response.status}`);
		}

		const declaredLength = Number(response.headers.get('content-length'));
		if (Number.isFinite(declaredLength) && declaredLength > MAX_HLS_SEGMENT_BYTES) {
			await response.body?.cancel();
			throw new Error('HLS segment exceeds the maximum allowed size');
		}
		if (!response.body) throw new Error('HLS segment has no body');

		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let bytesRead = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				bytesRead += value.byteLength;
				if (bytesRead > MAX_HLS_SEGMENT_BYTES) {
					await reader.cancel();
					throw new Error('HLS segment exceeds the maximum allowed size');
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const result = new Uint8Array(bytesRead);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return result;
	} finally {
		clearTimeout(timeout);
		externalSignal?.removeEventListener('abort', abort);
	}
}

async function validateHlsUrl(url: string): Promise<void> {
	const result = await resolveAndValidateUrl(url);
	if (!result.safe) {
		throw new Error(`HLS URL blocked: ${result.reason || 'unsafe URL'}`);
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

async function fetchHlsUrl(
	url: string,
	init: RequestInit,
	signal?: AbortSignal
): Promise<Response> {
	let currentUrl = url;
	const visitedUrls = new Set<string>();
	for (let redirectCount = 0; redirectCount <= MAX_HLS_REDIRECTS; redirectCount++) {
		if (visitedUrls.has(currentUrl)) throw new Error('HLS redirect loop detected');
		visitedUrls.add(currentUrl);
		await validateHlsUrl(currentUrl);
		const response = await fetch(currentUrl, { ...init, redirect: 'manual', signal });
		if (response.status < 300 || response.status >= 400) return response;
		const location = response.headers.get('location');
		if (!location) return response;
		await response.body?.cancel();
		const redirectUrl = new URL(location, currentUrl).toString();
		if (redirectCount === MAX_HLS_REDIRECTS) throw new Error('Too many HLS redirects');
		await validateHlsUrl(redirectUrl);
		currentUrl = redirectUrl;
	}
	throw new Error('Too many HLS redirects');
}

/** Promise-based sleep that respects cancellation */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timeout = setTimeout(() => {
			signal?.removeEventListener('abort', abort);
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', abort);
			resolve();
		};
		signal?.addEventListener('abort', abort, { once: true });
	});
}
