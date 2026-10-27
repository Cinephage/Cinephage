/**
 * Streaming Protocol Handler
 *
 * Handles streaming-specific operations including:
 * - .strm file generation
 * - Stream URL validation
 * - Quality scoring from stream sources
 * - Multi-variant handling (different qualities)
 *
 * This handler treats streaming sources as first-class citizens,
 * scoring them alongside torrent releases for unified quality selection.
 */

import {
	BaseProtocolHandler,
	type IStreamingHandler,
	type StreamVariant,
	type StreamVerification,
	type ProtocolContext,
	type ProtocolDisplayInfo
} from './IProtocolHandler';
import type { ReleaseResult, EnhancedReleaseResult } from '../types/release';
import type { StreamingProtocolSettings } from '../types/protocol';
import { providerMatches } from './providerName.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Score bonuses for streaming-specific features
 */
const STREAMING_SCORE_BONUSES = {
	multipleVariants: 20, // Has quality options
	verifiedStream: 30, // Stream verified as available
	directPlay: 25, // Direct play supported (no transcoding)
	lowLatency: 15, // Fast response time
	premiumSource: 40, // From premium/trusted source
	subtitlesAvailable: 10
};

/**
 * Score penalties for streaming issues
 */
const STREAMING_SCORE_PENALTIES = {
	unavailable: -100,
	slowResponse: -15, // > 2 seconds response
	geoRestricted: -50,
	requiresAuth: -20,
	lowQuality: -30 // < 720p
};

/**
 * Quality scoring map for streams
 */
const STREAM_QUALITY_SCORES: Record<string, number> = {
	'2160p': 100,
	'4k': 100,
	uhd: 100,
	'1080p': 80,
	fullhd: 80,
	fhd: 80,
	'720p': 60,
	hd: 60,
	'480p': 40,
	sd: 30,
	'360p': 20,
	unknown: 50 // Default if quality cannot be determined
};

/**
 * Known premium/trusted streaming sources
 */
const PREMIUM_SOURCES = ['cinephage', 'yflix', 'vidcloud', 'megacloud', 'filemoon'];

// =============================================================================
// STREAMING PROTOCOL HANDLER
// =============================================================================

export class StreamingProtocolHandler extends BaseProtocolHandler implements IStreamingHandler {
	readonly protocol = 'streaming' as const;

	/**
	 * Validate streaming-specific fields
	 */
	override validateResult(result: ReleaseResult): boolean {
		if (!super.validateResult(result)) {
			return false;
		}

		// Streaming needs a valid URL
		if (!result.downloadUrl) {
			return false;
		}

		// Should not have torrent/usenet indicators
		if (
			result.downloadUrl.startsWith('magnet:') ||
			result.infoHash ||
			result.torrent?.infoHash ||
			result.downloadUrl.endsWith('.nzb')
		) {
			return false;
		}

		// Validate URL format - allow both stream:// internal URLs and http(s)://
		if (result.downloadUrl.startsWith('stream://')) {
			// Internal streaming URL format:
			// - stream://movie/{tmdbId}
			// - stream://tv/{tmdbId}/{season}/{episode}
			// - stream://tv/{tmdbId}/{season} (season pack)
			// - stream://tv/{tmdbId}/all (complete series)
			const streamUrl = result.downloadUrl.replace('stream://', '');
			const parts = streamUrl.split('/').filter(Boolean);

			if (parts.length < 2) {
				return false;
			}

			const contentType = parts[0];
			if (contentType !== 'movie' && contentType !== 'tv') {
				return false;
			}

			return true;
		}

		// Standard HTTP(S) URL validation
		try {
			new URL(result.downloadUrl);
		} catch {
			return false;
		}

		return true;
	}

	/**
	 * Extract streaming-specific metadata
	 */
	extractMetadata(result: ReleaseResult): Record<string, unknown> {
		const streaming = result.streaming;
		return {
			streamUrl: streaming?.streamUrl ?? result.downloadUrl,
			providerName: streaming?.providerName ?? this.extractProviderName(result.downloadUrl),
			quality: streaming?.quality ?? this.detectQuality(result.title),
			contentType: streaming?.contentType,
			supportsDirectPlay: streaming?.supportsDirectPlay ?? true,
			requiresAuth: streaming?.requiresAuth ?? false,
			hasSubtitles: streaming?.subtitles !== undefined && streaming.subtitles.length > 0,
			subtitles: streaming?.subtitles ?? [],
			variants: this.getStreamVariants(result)
		};
	}

	/**
	 * Calculate score adjustment based on streaming-specific factors
	 */
	calculateScoreAdjustment(result: EnhancedReleaseResult, context: ProtocolContext): number {
		let adjustment = 0;
		const settings = context.settings as StreamingProtocolSettings;
		const streaming = result.streaming;

		// Source quality score
		const sourceScore = this.getSourceQualityScore(result);
		adjustment += Math.floor(sourceScore / 5); // Max +20 from source quality

		// Premium source bonus
		const providerName = streaming?.providerName ?? this.extractProviderName(result.downloadUrl);
		if (this.isPremiumSource(providerName)) {
			adjustment += STREAMING_SCORE_BONUSES.premiumSource;
		}

		// Direct play support
		if (streaming?.supportsDirectPlay) {
			adjustment += STREAMING_SCORE_BONUSES.directPlay;
		}

		// Multiple variants available
		const variants = this.getStreamVariants(result);
		if (variants.length > 1) {
			adjustment += STREAMING_SCORE_BONUSES.multipleVariants;
		}

		// Subtitles available
		if (streaming?.subtitles && streaming.subtitles.length > 0) {
			adjustment += STREAMING_SCORE_BONUSES.subtitlesAvailable;
		}

		// Auth requirement penalty
		if (streaming?.requiresAuth && !settings.authToken) {
			adjustment += STREAMING_SCORE_PENALTIES.requiresAuth;
		}

		// Quality-based adjustments
		const quality = streaming?.quality ?? this.detectQuality(result.title);
		if (quality && STREAM_QUALITY_SCORES[quality.toLowerCase()] < 60) {
			adjustment += STREAMING_SCORE_PENALTIES.lowQuality;
		}

		return adjustment;
	}

	/**
	 * Generate download URL (for streaming, this is the stream URL)
	 */
	override async generateDownloadUrl(
		result: ReleaseResult,
		context: ProtocolContext
	): Promise<string> {
		const settings = context.settings as StreamingProtocolSettings;
		const streamUrl = result.streaming?.streamUrl ?? result.downloadUrl;

		// Add auth token if needed
		if (settings.authToken && result.streaming?.requiresAuth) {
			const url = new URL(streamUrl);
			url.searchParams.set('token', settings.authToken);
			return url.toString();
		}

		return streamUrl;
	}

	/**
	 * Check if stream should be rejected
	 */
	shouldReject(result: EnhancedReleaseResult, context: ProtocolContext): string | undefined {
		const settings = context.settings as StreamingProtocolSettings;
		const streaming = result.streaming;

		// Reject if authentication required but no token
		if (streaming?.requiresAuth && !settings.authToken) {
			return 'Stream requires authentication';
		}

		// Reject based on minimum quality
		if (settings.minimumQuality) {
			const quality = streaming?.quality ?? this.detectQuality(result.title);
			if (quality && this.isQualityBelowMinimum(quality, settings.minimumQuality)) {
				return `Quality below minimum (${quality} < ${settings.minimumQuality})`;
			}
		}

		// Reject based on provider blacklist
		if (settings.blockedProviders && settings.blockedProviders.length > 0) {
			const provider = streaming?.providerName ?? this.extractProviderName(result.downloadUrl);
			if (
				provider &&
				settings.blockedProviders.some((blocked) => providerMatches(provider, blocked))
			) {
				return `Provider blocked: ${provider}`;
			}
		}

		return undefined;
	}

	/**
	 * Get display information for UI
	 */
	getDisplayInfo(result: ReleaseResult): ProtocolDisplayInfo {
		const streaming = result.streaming;
		const quality = streaming?.quality ?? this.detectQuality(result.title);
		const provider = streaming?.providerName ?? this.extractProviderName(result.downloadUrl);
		const variants = this.getStreamVariants(result);

		const details: ProtocolDisplayInfo['details'] = [];

		if (quality) {
			details.push({
				label: 'Quality',
				value: quality.toUpperCase(),
				tooltip: `Stream quality: ${quality}`
			});
		}

		if (provider) {
			details.push({
				label: 'Source',
				value: provider,
				tooltip: this.isPremiumSource(provider) ? 'Premium streaming source' : 'Streaming source'
			});
		}

		if (variants.length > 1) {
			details.push({
				label: 'Variants',
				value: variants.length.toString(),
				tooltip: `${variants.length} quality options available`
			});
		}

		if (streaming?.supportsDirectPlay) {
			details.push({
				label: 'Direct Play',
				value: 'Yes',
				tooltip: 'Supports direct playback without transcoding'
			});
		}

		if (streaming?.subtitles && streaming.subtitles.length > 0) {
			details.push({
				label: 'Subtitles',
				value: streaming.subtitles.length.toString(),
				tooltip: `${streaming.subtitles.length} subtitle tracks available`
			});
		}

		return {
			badge: 'STREAM',
			badgeClass: this.getQualityBadgeClass(quality),
			icon: 'play-circle',
			availability: quality?.toUpperCase() ?? 'Stream',
			details
		};
	}

	// =========================================================================
	// STREAMING-SPECIFIC METHODS
	// =========================================================================

	/**
	 * Generate .strm file content
	 */
	generateStrmContent(result: ReleaseResult): string {
		const streamUrl = result.streaming?.streamUrl ?? result.downloadUrl;
		return streamUrl;
	}

	/**
	 * Get available stream variants
	 */
	getStreamVariants(result: ReleaseResult): StreamVariant[] {
		// If streaming data has explicit variants
		if (result.streaming?.variants) {
			return result.streaming.variants;
		}

		// Default: single variant from the main URL
		const quality = result.streaming?.quality ?? this.detectQuality(result.title) ?? 'unknown';
		const streamUrl = result.streaming?.streamUrl ?? result.downloadUrl;

		return [
			{
				quality,
				url: streamUrl,
				isDefault: true
			}
		];
	}

	/**
	 * Verify stream is still available
	 */
	async verifyStream(url: string): Promise<StreamVerification> {
		const startTime = Date.now();

		try {
			const response = await fetch(url, {
				method: 'HEAD',
				signal: AbortSignal.timeout(10000) // 10 second timeout
			});

			const responseTime = Date.now() - startTime;

			return {
				available: response.ok,
				statusCode: response.status,
				contentType: response.headers.get('content-type') ?? undefined,
				responseTime
			};
		} catch (error) {
			return {
				available: false,
				error: error instanceof Error ? error.message : 'Unknown error',
				responseTime: Date.now() - startTime
			};
		}
	}

	/**
	 * Get source quality score (0-100)
	 */
	getSourceQualityScore(result: ReleaseResult): number {
		const streaming = result.streaming;

		// Check explicit quality
		const quality = streaming?.quality ?? this.detectQuality(result.title);
		if (quality) {
			const normalizedQuality = quality.toLowerCase().replace(/\s+/g, '');
			if (STREAM_QUALITY_SCORES[normalizedQuality]) {
				return STREAM_QUALITY_SCORES[normalizedQuality];
			}
		}

		// Check provider quality reputation
		const provider = streaming?.providerName ?? this.extractProviderName(result.downloadUrl);
		if (provider && this.isPremiumSource(provider)) {
			return 75; // Premium sources default to high quality
		}

		return STREAM_QUALITY_SCORES['unknown'];
	}

	// =========================================================================
	// PRIVATE METHODS
	// =========================================================================

	/**
	 * Extract provider name from URL
	 */
	private extractProviderName(url: string): string | undefined {
		// Handle internal stream:// URLs - these are from Cinephage
		if (url.startsWith('stream://')) {
			return 'cinephage';
		}

		try {
			const urlObj = new URL(url);
			const hostname = urlObj.hostname;

			// Remove common prefixes/suffixes
			let provider = hostname
				.replace(/^(www\.|api\.|stream\.|play\.|watch\.)/i, '')
				.replace(/\.(com|net|org|io|tv|cc|to)$/i, '');

			// Handle subdomains
			const parts = provider.split('.');
			if (parts.length > 1) {
				provider = parts[parts.length - 1];
			}

			return provider;
		} catch {
			return undefined;
		}
	}

	/**
	 * Detect quality from title or URL
	 */
	private detectQuality(title: string): string | undefined {
		const normalized = title.toLowerCase();

		// Check for explicit quality markers
		const qualityPatterns: Array<{ pattern: RegExp; quality: string }> = [
			{ pattern: /\b(2160p|4k|uhd)\b/i, quality: '2160p' },
			{ pattern: /\b1080p\b/i, quality: '1080p' },
			{ pattern: /\b(fullhd|fhd)\b/i, quality: '1080p' },
			{ pattern: /\b720p\b/i, quality: '720p' },
			{ pattern: /\bhd\b/i, quality: '720p' },
			{ pattern: /\b480p\b/i, quality: '480p' },
			{ pattern: /\b(sd|360p)\b/i, quality: 'sd' }
		];

		for (const { pattern, quality } of qualityPatterns) {
			if (pattern.test(normalized)) {
				return quality;
			}
		}

		return undefined;
	}

	/**
	 * Check if provider is premium/trusted
	 */
	private isPremiumSource(provider: string | undefined): boolean {
		if (!provider) return false;
		return PREMIUM_SOURCES.some((premium) => providerMatches(provider, premium));
	}

	/**
	 * Check if quality is below minimum
	 */
	private isQualityBelowMinimum(quality: string, minimum: string): boolean {
		const qualityOrder = [
			'360p',
			'sd',
			'480p',
			'720p',
			'hd',
			'1080p',
			'fullhd',
			'fhd',
			'2160p',
			'4k',
			'uhd'
		];

		const currentIndex = qualityOrder.indexOf(quality.toLowerCase());
		const minimumIndex = qualityOrder.indexOf(minimum.toLowerCase());

		if (currentIndex === -1 || minimumIndex === -1) {
			return false; // Can't compare, don't reject
		}

		return currentIndex < minimumIndex;
	}

	/**
	 * Get badge class based on quality
	 */
	private getQualityBadgeClass(quality: string | undefined): string {
		if (!quality) return 'badge-ghost';

		const normalized = quality.toLowerCase();
		if (['2160p', '4k', 'uhd'].includes(normalized)) {
			return 'badge-primary';
		}
		if (['1080p', 'fullhd', 'fhd'].includes(normalized)) {
			return 'badge-success';
		}
		if (['720p', 'hd'].includes(normalized)) {
			return 'badge-info';
		}
		return 'badge-warning';
	}
}

/**
 * Singleton instance
 */
let instance: StreamingProtocolHandler | null = null;

export function getStreamingHandler(): StreamingProtocolHandler {
	if (!instance) {
		instance = new StreamingProtocolHandler();
	}
	return instance;
}
