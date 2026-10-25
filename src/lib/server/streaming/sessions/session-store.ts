import { randomUUID } from 'node:crypto';
import {
	DEFAULT_EFFECTIVE_AUDIO_PREFERENCE,
	audioPreferencesEqual,
	type EffectiveAudioPreference
} from '../language-utils';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';
import type {
	PlaybackMediaType,
	PlaybackSession,
	PlaybackSessionAttempt,
	PlaybackSessionResource,
	PlaybackSessionStats,
	PlaybackSessionSubtitle,
	SessionResourceKind,
	StreamType
} from '../types';

const SESSION_TTL_MS = 30 * 60 * 1000;
/** Absolute cap from creation so a continuously-playing session cannot live forever. */
const SESSION_HARD_TTL_MS = 6 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

interface CreatePlaybackSessionInput {
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
	subtitles?: PlaybackSessionSubtitle[];
	attempts: PlaybackSessionAttempt[];
	sourceExpiresAt?: number;
	/** Resolved audio-preference snapshot stored on the session for reuse compatibility. */
	audioPreference?: EffectiveAudioPreference;
	/** Language of the chosen source (or the original language when it drove an untagged pick). */
	chosenAudioLanguage?: string | null;
	/** Ordered subtitle language preferences (see PlaybackSession.preferredSubtitleLanguages). */
	preferredSubtitleLanguages?: string[];
	/** Full effective requirement snapshot (see PlaybackSession.preferredSubtitleRequirements). */
	preferredSubtitleRequirements?: SubtitleRequirement[];
}

export class PlaybackSessionStore {
	private readonly sessions = new Map<string, PlaybackSession>();
	private readonly mediaIndex = new Map<string, string>();
	private readonly cleanupInterval: NodeJS.Timeout;
	private expiredSessions = 0;
	private createdSessions = 0;
	private reusedSessions = 0;

	constructor() {
		this.cleanupInterval = setInterval(() => {
			this.pruneExpired();
		}, CLEANUP_INTERVAL_MS);
	}

	createSession(input: CreatePlaybackSessionInput): PlaybackSession {
		const token = randomUUID();
		const now = Date.now();
		const session: PlaybackSession = {
			token,
			mediaType: input.mediaType,
			tmdbId: input.tmdbId,
			season: input.season,
			episode: input.episode,
			provider: input.provider,
			entryUrl: input.entryUrl,
			sourceType: input.sourceType,
			sourceFormat: input.sourceFormat,
			sourceContentType: input.sourceContentType,
			requestHeaders: { ...input.requestHeaders },
			subtitles: input.subtitles ? [...input.subtitles] : [],
			createdAt: now,
			expiresAt: now + SESSION_TTL_MS,
			sourceExpiresAt: input.sourceExpiresAt,
			// Snapshot copies so later mutation of the caller's object cannot
			// silently change the stored reuse-compatibility fingerprint.
			audioPreference: input.audioPreference
				? {
						...input.audioPreference,
						languages: [...input.audioPreference.languages]
					}
				: undefined,
			chosenAudioLanguage: input.chosenAudioLanguage ?? null,
			preferredSubtitleLanguages: input.preferredSubtitleLanguages
				? [...input.preferredSubtitleLanguages]
				: [],
			preferredSubtitleRequirements: input.preferredSubtitleRequirements
				? input.preferredSubtitleRequirements.map((requirement) => ({ ...requirement }))
				: [],
			lastAccessedAt: now,
			attempts: [...input.attempts],
			resourceIdsByKey: {},
			resources: {}
		};

		this.sessions.set(token, session);
		this.mediaIndex.set(
			this.mediaKey(input.mediaType, input.tmdbId, input.season, input.episode),
			token
		);
		this.createdSessions += 1;
		return session;
	}

	/**
	 * Find a live session for the media identity that is compatible with the
	 * currently requested audio preference.
	 *
	 * Compatibility semantics:
	 * - Sessions WITH a stored `audioPreference` snapshot are reusable only when
	 *   it deep-equals the requested preference, so a profile change takes
	 *   effect on the next playback without `forceRefresh`.
	 * - Sessions WITHOUT a snapshot (created before audio preference existed)
	 *   are reusable only when the requested preference equals the no-profile
	 *   default (`DEFAULT_EFFECTIVE_AUDIO_PREFERENCE`), because they were
	 *   resolved under exactly that behavior. The default is always resolved
	 *   through the shared constant so this comparison is consistent.
	 *
	 * The expired-source re-resolve behavior is unchanged. An incompatible (but
	 * not expired) session is intentionally left in place: it may still be
	 * serving an in-flight playback via its token and will age out with the
	 * normal TTL.
	 */
	findReusableSession(
		mediaType: PlaybackMediaType,
		tmdbId: number,
		season?: number,
		episode?: number,
		audioPreference?: EffectiveAudioPreference,
		preferredSubtitleRequirements?: SubtitleRequirement[]
	): PlaybackSession | null {
		const token = this.mediaIndex.get(this.mediaKey(mediaType, tmdbId, season, episode));
		if (!token) {
			return null;
		}

		const session = this.getSession(token);
		if (!session) {
			return null;
		}

		// The underlying source URL/signature expired (e.g. CDN token), so a
		// reused session would serve a dead stream — force a re-resolve.
		if (session.sourceExpiresAt !== undefined && Date.now() / 1000 > session.sourceExpiresAt) {
			this.deleteSession(token);
			return null;
		}

		if (!this.isAudioPreferenceCompatible(session, audioPreference)) {
			return null;
		}

		// A changed per-item/professional subtitle requirement must take effect
		// on the next launch rather than serving the old DEFAULT track.
		if (
			!subtitleRequirementsEqual(
				session.preferredSubtitleRequirements,
				preferredSubtitleRequirements
			)
		) {
			return null;
		}

		this.reusedSessions += 1;
		return session;
	}

	getSession(token: string): PlaybackSession | null {
		const session = this.sessions.get(token);
		if (!session) {
			return null;
		}

		const now = Date.now();
		if (now > session.expiresAt) {
			this.deleteSession(token);
			this.expiredSessions += 1;
			return null;
		}

		// Sliding idle timeout: active playback keeps refreshing its own window,
		// capped from creation so a session cannot live forever.
		session.lastAccessedAt = now;
		session.expiresAt = Math.min(now + SESSION_TTL_MS, session.createdAt + SESSION_HARD_TTL_MS);
		return session;
	}

	registerResource(
		token: string,
		url: string,
		kind: SessionResourceKind,
		extension: string,
		segmentFallbackExtension?: string
	): PlaybackSessionResource | null {
		const session = this.getSession(token);
		if (!session) {
			return null;
		}

		const normalizedExtension = extension.replace(/^\./, '') || 'bin';
		const key = `${kind}:${segmentFallbackExtension ?? ''}:${url}`;
		const existingId = session.resourceIdsByKey[key];
		if (existingId) {
			return session.resources[existingId] ?? null;
		}

		const resource: PlaybackSessionResource = {
			id: randomUUID(),
			url,
			kind,
			extension: normalizedExtension,
			segmentFallbackExtension,
			createdAt: Date.now()
		};

		session.resourceIdsByKey[key] = resource.id;
		session.resources[resource.id] = resource;
		return resource;
	}

	getResource(token: string, resourceId: string): PlaybackSessionResource | null {
		const session = this.getSession(token);
		if (!session) {
			return null;
		}

		return session.resources[resourceId] ?? null;
	}

	clear(): void {
		this.sessions.clear();
		this.mediaIndex.clear();
	}

	getStats(): PlaybackSessionStats {
		let resources = 0;
		for (const session of this.sessions.values()) {
			resources += Object.keys(session.resources).length;
		}

		return {
			activeSessions: this.sessions.size,
			resources,
			expiredSessions: this.expiredSessions,
			createdSessions: this.createdSessions,
			reusedSessions: this.reusedSessions
		};
	}

	destroy(): void {
		clearInterval(this.cleanupInterval);
		this.clear();
	}

	private pruneExpired(): void {
		for (const [token, session] of this.sessions.entries()) {
			if (Date.now() > session.expiresAt) {
				this.deleteSession(token);
				this.expiredSessions += 1;
			}
		}
	}

	private deleteSession(token: string): void {
		const session = this.sessions.get(token);
		if (!session) {
			return;
		}

		this.sessions.delete(token);
		const key = this.mediaKey(session.mediaType, session.tmdbId, session.season, session.episode);
		if (this.mediaIndex.get(key) === token) {
			this.mediaIndex.delete(key);
		}
	}

	private mediaKey(
		mediaType: PlaybackMediaType,
		tmdbId: number,
		season?: number,
		episode?: number
	): string {
		if (mediaType === 'movie') {
			return `movie:${tmdbId}`;
		}

		return `tv:${tmdbId}:${season ?? 'x'}:${episode ?? 'x'}`;
	}

	/**
	 * A missing requested preference resolves to the no-profile default so the
	 * check matches how PlaybackSessionService always resolves preferences.
	 */
	private isAudioPreferenceCompatible(
		session: PlaybackSession,
		requested?: EffectiveAudioPreference
	): boolean {
		const effective = requested ?? DEFAULT_EFFECTIVE_AUDIO_PREFERENCE;
		const stored = session.audioPreference;
		if (stored) {
			return audioPreferencesEqual(stored, effective);
		}

		// Pre-deploy session without a snapshot: reusable only under the exact
		// behavior it was created with (the no-profile default).
		return audioPreferencesEqual(effective, DEFAULT_EFFECTIVE_AUDIO_PREFERENCE);
	}
}

/** Order-sensitive equality for requirement snapshots (reuse compatibility). */
function subtitleRequirementsEqual(
	stored?: SubtitleRequirement[],
	requested?: SubtitleRequirement[]
): boolean {
	const left = stored ?? [];
	const right = requested ?? [];
	if (left.length !== right.length) return false;
	return left.every((requirement, index) => {
		const other = right[index];
		return (
			requirement.tag === other.tag &&
			requirement.variant === other.variant &&
			requirement.accessibility === other.accessibility
		);
	});
}

let playbackSessionStoreInstance: PlaybackSessionStore | null = null;

export function getPlaybackSessionStore(): PlaybackSessionStore {
	if (!playbackSessionStoreInstance) {
		playbackSessionStoreInstance = new PlaybackSessionStore();
	}

	return playbackSessionStoreInstance;
}
