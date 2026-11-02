import { resolveMovieMultiQuality } from '#lib/server/quality/movie-buckets.js';
import type { Resolution } from '#lib/server/indexers/parser/types.js';

/**
 * Compute the reservation quality-slot for a movie grab.
 *
 * 'single' unless the movie is in multi-quality mode AND the candidate's
 * resolution is one of the effective desired buckets — in which case the
 * slot is that bucket (e.g. '2160p'), allowing one active acquisition per
 * configured tier.
 */
export async function computeMovieQualitySlot(
	desiredQualities: readonly string[] | null | undefined,
	profileId: string | null | undefined,
	candidateResolution: Resolution | undefined
): Promise<string> {
	if (!candidateResolution) return 'single';
	const { effective, multiQuality } = await resolveMovieMultiQuality(
		desiredQualities as Resolution[] | null,
		profileId
	);
	if (multiQuality && effective.includes(candidateResolution)) {
		return candidateResolution;
	}
	return 'single';
}
