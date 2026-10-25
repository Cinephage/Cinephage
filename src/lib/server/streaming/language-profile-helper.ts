/**
 * Language Profile Helper for Streaming
 *
 * Resolves the effective audio language preference for media items to pass to
 * stream extraction. Looks up movies/series by TMDB ID and reads their
 * effective language profile's v2 `audio` object.
 */

import { db } from '#lib/server/db/index.js';
import { movies, series } from '#lib/server/db/schema.js';
import { and, eq } from 'drizzle-orm';
import { getLanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import { logger } from '#lib/logging/index.js';
import { materializeAudioPreference } from '#lib/server/languages/audio-preference-resolver.js';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';
import {
	DEFAULT_EFFECTIVE_AUDIO_PREFERENCE,
	type EffectiveAudioPreference
} from './language-utils';
import type { PlaybackMediaType } from './types';

const streamLog = { logDomain: 'streams' as const };

/**
 * Resolve the effective audio preference for a movie or series.
 *
 * - `preferOriginal` / `languages` come straight from the profile's v2
 *   `audio` object. When no profile exists, `preferOriginal` defaults to true
 *   with no fallback languages.
 * - `originalLanguage` is read from the persisted `movies.original_language` /
 *   `series.original_language` column (null when the media is not in the
 *   library or the column is unset).
 * - Tags are canonicalized via `normalizeLanguageCode` and deduped so the
 *   returned object is a stable, comparable snapshot.
 * - Never throws: any lookup failure logs and returns
 *   `DEFAULT_EFFECTIVE_AUDIO_PREFERENCE`.
 *
 * `season`/`episode` are accepted for signature stability; profiles attach to
 * the series, so all episodes of a series share one resolved preference.
 */
export async function getAudioPreferenceFor(
	mediaType: PlaybackMediaType,
	tmdbId: number,
	season?: number,
	episode?: number
): Promise<EffectiveAudioPreference> {
	try {
		const mediaRow =
			mediaType === 'movie'
				? (
						await db
							.select({ id: movies.id, originalLanguage: movies.originalLanguage })
							.from(movies)
							.where(eq(movies.tmdbId, tmdbId))
							.limit(1)
					)[0]
				: (
						await db
							.select({ id: series.id, originalLanguage: series.originalLanguage })
							.from(series)
							.where(eq(series.tmdbId, tmdbId))
							.limit(1)
					)[0];

		if (!mediaRow) {
			// Media not in the library — no language preference known.
			return { ...DEFAULT_EFFECTIVE_AUDIO_PREFERENCE };
		}

		const profileService = getLanguageProfileService();
		const profile =
			mediaType === 'movie'
				? await profileService.getProfileForMovie(mediaRow.id)
				: await profileService.getProfileForSeries(mediaRow.id);

		// v2 audio object directly off the parsed profile (rowToProfile already
		// coerces malformed JSON to the default audio shape). Materialization
		// (canonicalize, dedupe, mode default) is shared with the acquisition
		// resolver so both paths produce comparable snapshots.
		const preference = materializeAudioPreference(
			profile?.audio ?? null,
			mediaRow.originalLanguage
		);

		logger.debug(
			{
				tmdbId,
				mediaType,
				season,
				episode,
				profileName: profile?.name,
				...preference,
				...streamLog
			},
			'Resolved audio preference'
		);

		return preference;
	} catch (error) {
		logger.warn(
			{
				tmdbId,
				mediaType,
				season,
				episode,
				error: error instanceof Error ? error.message : String(error),
				...streamLog
			},
			'Failed to resolve audio preference; using defaults'
		);
		return { ...DEFAULT_EFFECTIVE_AUDIO_PREFERENCE };
	}
}

/**
 * Resolve the ordered subtitle requirements for a movie or episode, from the
 * item's effective requirements (episode override → series override → library
 * → instance default; requirement order preserved), gated by the
 * wants-subtitles switches (movie flag, series flag with episode tri-state
 * override).
 *
 * Used by playback to mark the DEFAULT subtitle track: the first provider
 * track satisfying the highest-priority requirement (language + variant +
 * accessibility via the shared matcher) wins. Returns an empty array when
 * nothing is resolvable or subtitles are opted out, so callers fall back to
 * positional defaulting. Never throws.
 */
export async function getPreferredSubtitleRequirementsFor(
	mediaType: PlaybackMediaType,
	tmdbId: number,
	season?: number,
	episode?: number
): Promise<SubtitleRequirement[]> {
	try {
		const profileService = getLanguageProfileService();

		if (mediaType === 'movie') {
			const movie = (
				await db
					.select({ id: movies.id, wantsSubtitles: movies.wantsSubtitles })
					.from(movies)
					.where(eq(movies.tmdbId, tmdbId))
					.limit(1)
			)[0];
			if (!movie || movie.wantsSubtitles === false) return [];
			const effective = await profileService.getEffectiveSubtitleRequirements({
				movieId: movie.id
			});
			return effective?.requirements ?? [];
		}

		const show = (
			await db
				.select({ id: series.id, wantsSubtitles: series.wantsSubtitles })
				.from(series)
				.where(eq(series.tmdbId, tmdbId))
				.limit(1)
		)[0];
		if (!show || season === undefined || episode === undefined) return [];

		const { episodes } = await import('#lib/server/db/schema.js');
		const episodeRow = (
			await db
				.select({ id: episodes.id, wantsSubtitlesOverride: episodes.wantsSubtitlesOverride })
				.from(episodes)
				.where(
					and(
						eq(episodes.seriesId, show.id),
						eq(episodes.seasonNumber, season),
						eq(episodes.episodeNumber, episode)
					)
				)
				.limit(1)
		)[0];
		if (!episodeRow) return [];

		// Tri-state gate: episode override wins over the series flag.
		const wantsSubtitles = episodeRow.wantsSubtitlesOverride ?? show.wantsSubtitles;
		if (wantsSubtitles === false) return [];

		const effective = await profileService.getEffectiveSubtitleRequirements({
			episodeId: episodeRow.id
		});
		return effective?.requirements ?? [];
	} catch (error) {
		logger.warn(
			{
				tmdbId,
				mediaType,
				season,
				episode,
				...streamLog,
				error: error instanceof Error ? error.message : String(error)
			},
			'Failed to resolve preferred subtitles; using positional defaulting'
		);
		return [];
	}
}
