/**
 * DB-coupled multi-quality resolver for movies.
 *
 * Loads the scoring profile's resolution bounds lazily and delegates the pure
 * bucket math to {@link ./buckets.js}. The fast path avoids any DB query when a
 * movie clearly cannot be in multi-quality mode (null/<2 desired qualities).
 */
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { scoringProfiles } from '#lib/server/db/schema.js';
import type { Resolution } from '#lib/server/indexers/parser/types.js';
import { effectiveBuckets, isMultiQualityMode } from './buckets.js';

export interface MovieMultiQualityContext {
	effective: Resolution[];
	multiQuality: boolean;
}

const EMPTY: MovieMultiQualityContext = { effective: [], multiQuality: false };

export async function resolveMovieMultiQuality(
	desiredQualities: Resolution[] | null | undefined,
	scoringProfileId: string | null | undefined
): Promise<MovieMultiQualityContext> {
	if (!desiredQualities || desiredQualities.length < 2) return EMPTY;

	let minResolution: string | null;
	let maxResolution: string | null;
	if (scoringProfileId) {
		const [profile] = await db
			.select({
				minResolution: scoringProfiles.minResolution,
				maxResolution: scoringProfiles.maxResolution
			})
			.from(scoringProfiles)
			.where(eq(scoringProfiles.id, scoringProfileId))
			.limit(1);
		minResolution = profile?.minResolution ?? null;
		maxResolution = profile?.maxResolution ?? null;
	} else {
		// No explicit profile means "use the default scoring profile" — apply
		// its resolution bounds so null-profile movies get the same bucket
		// clamping as movies with an explicitly assigned profile. A missing
		// default row degrades gracefully to unconstrained buckets.
		const [defaultProfile] = await db
			.select({
				minResolution: scoringProfiles.minResolution,
				maxResolution: scoringProfiles.maxResolution
			})
			.from(scoringProfiles)
			.where(eq(scoringProfiles.isDefault, true))
			.limit(1);
		minResolution = defaultProfile?.minResolution ?? null;
		maxResolution = defaultProfile?.maxResolution ?? null;
	}

	const effective = effectiveBuckets(desiredQualities, minResolution, maxResolution);
	return { effective, multiQuality: isMultiQualityMode(effective) };
}
