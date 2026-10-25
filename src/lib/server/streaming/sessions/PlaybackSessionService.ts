import { logger } from '#lib/logging/index.js';
import { getLibraryStreamingModule } from '#lib/server/cinephage/modules/library-streaming/LibraryStreamingModule.js';
import { resolveAudioPreferenceBucket, sortSourcesByAudioPreference } from '../language-utils';
import type {
	PlaybackMediaType,
	PlaybackSession,
	PlaybackSessionSubtitle,
	StreamSource
} from '../types';
import {
	getAudioPreferenceFor,
	getPreferredSubtitleRequirementsFor
} from '../language-profile-helper';
import { getPlaybackSessionStore } from './session-store';

const streamLog = { logDomain: 'streams' as const };

interface PlaybackLaunchParams {
	tmdbId: number;
	type: PlaybackMediaType;
	season?: number;
	episode?: number;
	forceRefresh?: boolean;
	signal?: AbortSignal;
}

function buildSourceHeaders(source: StreamSource): Record<string, string> {
	const headers = {
		...(source.headers ?? {})
	};

	if (!headers.Referer && !headers.referer && source.referer) {
		headers.Referer = source.referer;
	}

	return headers;
}

function normalizeSubtitleList(source: StreamSource): PlaybackSessionSubtitle[] {
	return (source.subtitles ?? []).map((subtitle, index) => ({
		id: `sub-${index}`,
		url: subtitle.url,
		label: subtitle.label,
		language: subtitle.language,
		isDefault: subtitle.isDefault,
		isForced: subtitle.isForced,
		isHearingImpaired: subtitle.isHearingImpaired
	}));
}

function isAborted(signal?: AbortSignal): boolean {
	return signal?.aborted === true;
}

export class PlaybackSessionService {
	private readonly api = getLibraryStreamingModule();
	private readonly store = getPlaybackSessionStore();

	/**
	 * In-flight launches keyed by media identity. Two concurrent launches for
	 * the same item share one provider lookup/session instead of both missing
	 * reuse and creating duplicate sessions (the second overwrote mediaIndex,
	 * orphaning the first token until TTL).
	 */
	private readonly pendingLaunches = new Map<
		string,
		Promise<{
			session: PlaybackSession | null;
			extractionResult?: {
				success: boolean;
				sources: StreamSource[];
				error?: string;
				meta?: Record<string, unknown>;
			};
			error?: string;
		}>
	>();

	async createOrReuseSession(params: PlaybackLaunchParams): Promise<{
		session: PlaybackSession | null;
		extractionResult?: {
			success: boolean;
			sources: StreamSource[];
			error?: string;
			meta?: Record<string, unknown>;
		};
		error?: string;
	}> {
		const key = `${params.type}:${params.tmdbId}:${params.season ?? 'x'}:${params.episode ?? 'x'}`;

		if (!params.forceRefresh) {
			const inFlight = this.pendingLaunches.get(key);
			if (inFlight) return inFlight;
		}

		const run = this.createOrReuseSessionInternal(params).finally(() => {
			if (this.pendingLaunches.get(key) === run) {
				this.pendingLaunches.delete(key);
			}
		});

		if (!params.forceRefresh) {
			this.pendingLaunches.set(key, run);
		}

		return run;
	}

	private async createOrReuseSessionInternal(params: PlaybackLaunchParams): Promise<{
		session: PlaybackSession | null;
		extractionResult?: {
			success: boolean;
			sources: StreamSource[];
			error?: string;
			meta?: Record<string, unknown>;
		};
		error?: string;
	}> {
		if (isAborted(params.signal)) {
			return { session: null, error: 'Aborted' };
		}

		// Resolve the CURRENT audio + subtitle requirements before the reuse
		// check so a changed profile/override takes effect on the next launch
		// without forceRefresh.
		const audioPreference = await getAudioPreferenceFor(
			params.type,
			params.tmdbId,
			params.season,
			params.episode
		);
		const preferredSubtitleRequirements = await getPreferredSubtitleRequirementsFor(
			params.type,
			params.tmdbId,
			params.season,
			params.episode
		);

		if (!params.forceRefresh) {
			const existing = this.store.findReusableSession(
				params.type,
				params.tmdbId,
				params.season,
				params.episode,
				audioPreference,
				preferredSubtitleRequirements
			);
			if (existing) {
				return { session: existing };
			}
		}

		const lookup = await this.api.getStreams({
			tmdbId: params.tmdbId,
			type: params.type,
			season: params.season,
			episode: params.episode,
			refresh: params.forceRefresh,
			signal: params.signal
		});

		if (isAborted(params.signal)) {
			return { session: null, error: 'Aborted' };
		}

		if (!lookup.success || !lookup.sources.length) {
			return {
				session: null,
				error: lookup.error || 'No playable stream sources found'
			};
		}

		// The API returns pre-validated sources; rank them by the resolved audio
		// preference (original language first, then profile fallback languages,
		// then untagged/neutral, then everything else — stable within buckets)
		// and use the winner directly for instant playback startup.
		const rankedSources = sortSourcesByAudioPreference(lookup.sources, audioPreference);
		const source = rankedSources[0];

		const chosenBucket = resolveAudioPreferenceBucket(source, audioPreference);
		const chosenAudioLanguage =
			source.language ?? (chosenBucket === 0 ? (audioPreference.originalLanguage ?? null) : null);

		const session = this.store.createSession({
			mediaType: params.type,
			tmdbId: params.tmdbId,
			season: params.season,
			episode: params.episode,
			provider: source.provider,
			entryUrl: source.url,
			sourceType: source.type,
			sourceFormat: source.sourceFormat,
			sourceContentType: source.sourceContentType,
			requestHeaders: buildSourceHeaders(source),
			subtitles: normalizeSubtitleList(source),
			attempts: [],
			sourceExpiresAt: source.expiresAt,
			audioPreference,
			chosenAudioLanguage,
			preferredSubtitleRequirements
		});

		logger.info(
			{
				sessionToken: session.token,
				provider: source.provider,
				sourceType: source.type,
				entryUrl: source.url,
				quality: source.quality,
				language: source.language,
				chosenAudioLanguage: session.chosenAudioLanguage,
				audioPreference: session.audioPreference,
				tmdbId: params.tmdbId,
				mediaType: params.type,
				season: params.season,
				episode: params.episode,
				...streamLog
			},
			'Playback session created'
		);

		return {
			session,
			extractionResult: {
				success: lookup.success,
				sources: lookup.sources,
				error: lookup.error,
				meta: lookup.meta
			}
		};
	}
}

let playbackSessionServiceInstance: PlaybackSessionService | null = null;

export function getPlaybackSessionService(): PlaybackSessionService {
	if (!playbackSessionServiceInstance) {
		playbackSessionServiceInstance = new PlaybackSessionService();
	}

	return playbackSessionServiceInstance;
}
