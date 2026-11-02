/**
 * Audio-language shortfall verification (audio-language acquisition design
 * 2026-09-15, phase D).
 *
 * Compares the ffprobe ground truth stored on media files
 * (`mediaInfo.audioLanguages`, the only definitive audio evidence) against
 * the item's effective audio preference and maintains the
 * `language_shortfall` flag on movies/series.
 *
 * Truth table (`evaluateShortfall`):
 *  - no probed audio languages (unknown)     → 'unknown'  (never punished)
 *  - no expectation (neutral preference)     → 'satisfied'
 *  - audio matches original (preferOriginal) or any preferred language
 *                                            → 'satisfied'
 *  - probed audio known, matches neither     → 'shortfall'
 *
 * Never throws; a failed recalculation leaves the flag untouched.
 */

import { db } from '#lib/server/db/index.js';
import { episodeFiles, episodes, movieFiles, movies, series } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { languageMatches, type EffectiveAudioPreference } from './audio-preference';
import { resolveAudioPreferenceForItem } from './audio-preference-resolver';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'scans' as const });

export type ShortfallEvaluation = 'satisfied' | 'shortfall' | 'unknown';

function usable(tag: unknown): tag is string {
	return typeof tag === 'string' && tag.trim() !== '' && tag.trim().toLowerCase() !== 'und';
}

export function evaluateShortfall(
	preference: EffectiveAudioPreference,
	audioLanguages: Array<string | undefined | null>
): ShortfallEvaluation {
	const probed = audioLanguages.filter(usable);
	if (probed.length === 0) return 'unknown';

	const hasOriginalSignal =
		preference.preferOriginal &&
		typeof preference.originalLanguage === 'string' &&
		preference.originalLanguage !== '';
	if (preference.languages.length === 0 && !hasOriginalSignal) return 'satisfied';

	if (
		(hasOriginalSignal &&
			probed.some((tag) => languageMatches(tag, preference.originalLanguage!))) ||
		(preference.languages.length > 0 &&
			probed.some((tag) => preference.languages.some((pref) => languageMatches(tag, pref))))
	) {
		return 'satisfied';
	}
	return 'shortfall';
}

function neutralPreference(preference: EffectiveAudioPreference): boolean {
	return (
		preference.languages.length === 0 && !(preference.preferOriginal && preference.originalLanguage)
	);
}

/** Recalculate and persist the movie's shortfall flag. Returns the flag. */
export async function recalculateMovieShortfall(movieId: string): Promise<boolean> {
	try {
		const files = await db
			.select({ audioLanguages: movieFiles.mediaInfo })
			.from(movieFiles)
			.where(eq(movieFiles.movieId, movieId));
		const preference = await resolveAudioPreferenceForItem('movie', movieId);
		const short =
			files.length > 0 &&
			!neutralPreference(preference) &&
			files.some(
				(file) =>
					evaluateShortfall(preference, file.audioLanguages?.audioLanguages ?? []) === 'shortfall'
			);
		await db.update(movies).set({ languageShortfall: short }).where(eq(movies.id, movieId));
		return short;
	} catch (error) {
		logger.warn(
			{ movieId, error: error instanceof Error ? error.message : String(error) },
			'Movie language shortfall recalculation failed; flag left unchanged'
		);
		return false;
	}
}

/** Recalculate and persist the series' shortfall flag across episode files. */
export async function recalculateSeriesShortfall(seriesId: string): Promise<boolean> {
	try {
		const files = await db
			.select({ audioLanguages: episodeFiles.mediaInfo })
			.from(episodeFiles)
			.where(eq(episodeFiles.seriesId, seriesId));
		const preference = await resolveAudioPreferenceForItem('series', seriesId);
		// Series-level flag: any episode file with a probed contradiction.
		const short =
			files.length > 0 &&
			!neutralPreference(preference) &&
			files.some(
				(file) =>
					evaluateShortfall(preference, file.audioLanguages?.audioLanguages ?? []) === 'shortfall'
			);
		await db.update(series).set({ languageShortfall: short }).where(eq(series.id, seriesId));
		return short;
	} catch (error) {
		logger.warn(
			{ seriesId, error: error instanceof Error ? error.message : String(error) },
			'Series language shortfall recalculation failed; flag left unchanged'
		);
		return false;
	}
}

/** Recalculate by episode's owning series (episode files carry the evidence). */
export async function recalculateShortfallForEpisode(episodeId: string): Promise<boolean> {
	try {
		const [row] = await db
			.select({ seriesId: episodes.seriesId })
			.from(episodes)
			.where(eq(episodes.id, episodeId))
			.limit(1);
		if (!row?.seriesId) return false;
		return recalculateSeriesShortfall(row.seriesId);
	} catch {
		return false;
	}
}
