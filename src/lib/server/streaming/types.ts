/**
 * Shared streaming types used by the active Cinephage API path.
 */

import type { EffectiveAudioPreference } from './language-utils';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';

export type StreamType = 'hls' | 'm3u8' | 'mp4' | 'dash' | 'file';

export type StreamStatus = 'working' | 'down' | 'unknown' | 'validating';

export interface StreamSubtitle {
	url: string;
	label: string;
	language: string;
	isDefault?: boolean;
	/** Provider-reported forced flag. */
	isForced?: boolean;
	/** Provider-reported hearing-impaired flag. */
	isHearingImpaired?: boolean;
}

export interface StreamSource {
	quality: string;
	title: string;
	url: string;
	type: StreamType;
	/** Raw protocol/container value reported by the upstream API, when available. */
	sourceFormat?: string;
	/** Authoritative media type derived from the upstream protocol/container metadata. */
	sourceContentType?: string;
	referer: string;
	requiresSegmentProxy: boolean;
	status?: StreamStatus;
	server?: string;
	language?: string;
	headers?: Record<string, string>;
	provider?: string;
	subtitles?: StreamSubtitle[];
	/** True when the source must be fetched through our proxy (signed/cookie-protected CDNs). */
	requiresProxy?: boolean;
	/** Epoch seconds when the source URL (and its signed headers) stop being valid. */
	expiresAt?: number;
}

export interface StreamResult {
	url: string;
	quality: string;
	title: string;
	streamType: StreamType;
	referer: string;
	server?: string;
	language?: string;
	headers?: Record<string, string>;
	provider?: string;
	subtitles?: StreamSubtitle[];
}

export interface StreamValidation {
	valid: boolean;
	playable: boolean;
	quality?: string;
	variantCount?: number;
	error?: string;
	statusCode?: number;
	responseTime: number;
	validatedAt: Date;
}

export interface PlaylistValidationResult {
	valid: boolean;
	type: 'master' | 'media' | 'unknown';
	variantCount?: number;
	segmentCount?: number;
	isVod?: boolean;
	error?: string;
	errors?: string[];
	warnings?: string[];
	preview?: string;
}

export interface SegmentValidation {
	accessible: boolean;
	statusCode?: number;
	contentType?: string;
	contentLength?: number;
	responseTime: number;
	error?: string;
}

export interface ValidationOptions {
	validateSegments?: boolean;
	segmentSampleSize?: number;
	timeout?: number;
	followRedirects?: boolean;
	referer?: string;
}

export interface ValidatedStreamSource extends StreamSource {
	validation: StreamValidation;
}

export interface ValidatedStreamResult extends StreamResult {
	validation: StreamValidation;
}

export interface CinephageApiStream {
	url: string;
	provider: string;
	quality: string;
	protocol: string;
	headers: Record<string, string>;
	subtitles?: StreamSubtitle[];
}

export interface CinephageApiErrorBody {
	message: string;
	details?: {
		limit?: number;
		resetAt?: string;
	};
}

export interface ExtractionResult {
	success: boolean;
	sources: StreamSource[];
	error?: string;
	provider?: string;
	durationMs?: number;
	providersAttempted?: number;
}

export interface ValidatedExtractionResult extends ExtractionResult {
	sources: ValidatedStreamSource[];
	validated: boolean;
	validatedAt?: Date;
	validationDurationMs?: number;
}

export type PlaybackMediaType = 'movie' | 'tv';

export type SessionResourceKind = 'playlist' | 'segment' | 'asset';

export interface PlaybackSessionSubtitle {
	id: string;
	url: string;
	label: string;
	language: string;
	isDefault?: boolean;
	isForced?: boolean;
	isHearingImpaired?: boolean;
}

export interface PlaybackSessionResource {
	id: string;
	url: string;
	kind: SessionResourceKind;
	extension: string;
	segmentFallbackExtension?: string;
	createdAt: number;
}

export interface PlaybackSessionAttempt {
	provider?: string;
	url: string;
	success: boolean;
	error?: string;
	statusCode?: number;
}

export interface PlaybackSession {
	token: string;
	mediaType: PlaybackMediaType;
	tmdbId: number;
	season?: number;
	episode?: number;
	provider?: string;
	entryUrl: string;
	sourceType: StreamType;
	sourceFormat?: string;
	sourceContentType?: string;
	requestHeaders: Record<string, string>;
	subtitles: PlaybackSessionSubtitle[];
	createdAt: number;
	expiresAt: number;
	/** Epoch seconds when the underlying source URL/signature stops being valid, if known. */
	sourceExpiresAt?: number;
	/**
	 * Resolved audio-preference snapshot captured when the session was created.
	 * Session reuse requires the current preference to deep-equal this value;
	 * absent on sessions created before audio preference existed, which are
	 * only reusable while the current request resolves to the no-profile
	 * default (see DEFAULT_EFFECTIVE_AUDIO_PREFERENCE).
	 */
	audioPreference?: EffectiveAudioPreference;
	/**
	 * Language tag of the chosen source, or the original language when that
	 * preference drove the pick of an untagged source; null when neither
	 * applies (e.g. an untagged source picked as a neutral fallback).
	 */
	chosenAudioLanguage?: string | null;
	/**
	 * Ordered subtitle language preferences from the item's effective
	 * subtitle requirements (first = most wanted), captured at session
	 * creation. The playlist rewriter marks the first track satisfying the
	 * highest-priority language as DEFAULT=YES; empty/absent falls back to
	 * the provider default or the first track.
	 */
	preferredSubtitleLanguages?: string[];
	/**
	 * Full effective subtitle requirements snapshot (tag + variant +
	 * accessibility) captured at session creation. The playlist rewriter marks
	 * DEFAULT=YES using the shared requirement matcher when present; absent on
	 * sessions created before requirement-aware selection existed.
	 */
	preferredSubtitleRequirements?: SubtitleRequirement[];
	lastAccessedAt: number;
	attempts: PlaybackSessionAttempt[];
	resourceIdsByKey: Record<string, string>;
	resources: Record<string, PlaybackSessionResource>;
}

export interface PlaybackSessionStats {
	activeSessions: number;
	resources: number;
	expiredSessions: number;
	createdSessions: number;
	reusedSessions: number;
}
