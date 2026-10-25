/**
 * Effective-audio-preference resolver keyed by library item IDs.
 *
 * Playback resolves by TMDB ID (`streaming/language-profile-helper.ts`);
 * the acquisition paths (monitoring search, cascading search, add-flow
 * search) hold the movie/series DB row and resolve by primary key here.
 * Both share `materializeAudioPreference` so the resolved shape stays
 * canonical and comparable.
 */

import { db } from '#lib/server/db/index.js';
import { movies, series } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { getLanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import { logger } from '#lib/logging/index.js';
import { normalizeLanguageCode } from '#lib/shared/languages.js';
import type { AudioPreference } from '#lib/shared/language-profile.js';
import {
	DEFAULT_EFFECTIVE_AUDIO_PREFERENCE,
	type EffectiveAudioPreference,
	audioPreferencesEqual
} from './audio-preference';

/**
 * Canonicalize a profile's audio object + the item's original language into
 * an `EffectiveAudioPreference` snapshot (tags normalized, deduped,
 * order-preserving). Nulls default.
 */
export function materializeAudioPreference(
	audio: Pick<AudioPreference, 'preferOriginal' | 'languages' | 'mode'> | null,
	originalLanguage: string | null | undefined
): EffectiveAudioPreference {
	const base = audio ?? {
		preferOriginal: DEFAULT_EFFECTIVE_AUDIO_PREFERENCE.preferOriginal,
		languages: DEFAULT_EFFECTIVE_AUDIO_PREFERENCE.languages,
		mode: DEFAULT_EFFECTIVE_AUDIO_PREFERENCE.mode
	};

	const seen = new Set<string>();
	const languages = base.languages
		.map((tag) => normalizeLanguageCode(tag))
		.filter((tag) => {
			if (tag === '' || seen.has(tag)) return false;
			seen.add(tag);
			return true;
		});

	const rawOriginal = originalLanguage?.trim();
	return {
		preferOriginal: base.preferOriginal,
		languages,
		originalLanguage: rawOriginal ? normalizeLanguageCode(rawOriginal) : null,
		mode: base.mode ?? 'prefer'
	};
}

/**
 * Resolve the effective audio preference for a movie or series by DB id:
 * profile chain (item → library → instance default) via
 * `LanguageProfileService`, plus the persisted `original_language` column.
 * Never throws — failures log and fall back to the neutral default.
 */
export async function resolveAudioPreferenceForItem(
	mediaType: 'movie' | 'series',
	itemId: string
): Promise<EffectiveAudioPreference> {
	try {
		const mediaRow =
			mediaType === 'movie'
				? (
						await db
							.select({ originalLanguage: movies.originalLanguage })
							.from(movies)
							.where(eq(movies.id, itemId))
							.limit(1)
					)[0]
				: (
						await db
							.select({ originalLanguage: series.originalLanguage })
							.from(series)
							.where(eq(series.id, itemId))
							.limit(1)
					)[0];

		if (!mediaRow) {
			return { ...DEFAULT_EFFECTIVE_AUDIO_PREFERENCE };
		}

		const profileService = getLanguageProfileService();
		const profile =
			mediaType === 'movie'
				? await profileService.getProfileForMovie(itemId)
				: await profileService.getProfileForSeries(itemId);

		const preference = materializeAudioPreference(
			profile?.audio ?? null,
			mediaRow.originalLanguage
		);

		if (!audioPreferencesEqual(preference, DEFAULT_EFFECTIVE_AUDIO_PREFERENCE)) {
			logger.debug(
				{ mediaType, itemId, profileName: profile?.name, ...preference },
				'Resolved audio preference for acquisition'
			);
		}
		return preference;
	} catch (error) {
		logger.warn(
			{
				mediaType,
				itemId,
				error: error instanceof Error ? error.message : String(error)
			},
			'Failed to resolve audio preference for acquisition; using defaults'
		);
		return { ...DEFAULT_EFFECTIVE_AUDIO_PREFERENCE };
	}
}
