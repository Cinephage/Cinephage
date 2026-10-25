/**
 * Radarr/Sonarr-compatible `qualityprofile` response.
 *
 * Deliberately lossy: Cinephage's scoring profiles are a condition/format
 * scoring system, not Radarr's ordered quality ladder, and a single profile
 * applies to both movies and series (it carries both movieMinSizeGb/
 * movieMaxSizeGb and episodeMinSizeMb/episodeMaxSizeMb on one row) - so the
 * same list is returned to both the Radarr and Sonarr trees. This exists so
 * a caller has an id + name to attach to a movie/series/root folder, not to
 * reproduce Cinephage's real quality logic in Radarr's shape.
 *
 * Field set confirmed against QualityProfileResource in Radarr/Sonarr's
 * actual openapi.json - both need minFormatScore/cutoffFormatScore/
 * minUpgradeFormatScore/formatItems; `language` exists on Radarr's resource
 * but not Sonarr's, so it's only included for the Radarr persona.
 */

import { db } from '#lib/server/db/index.js';
import { scoringProfiles } from '#lib/server/db/schema.js';
import { getOrAssignArrIds } from './ArrIdMappingService.js';
import type { ArrAppName } from './systemStatus.js';

export async function buildQualityProfiles(appName: ArrAppName) {
	const profiles = await db
		.select({ id: scoringProfiles.id, name: scoringProfiles.name })
		.from(scoringProfiles);
	const arrIds = await getOrAssignArrIds(
		'qualityProfile',
		profiles.map((p) => p.id)
	);

	return profiles.map((profile) => ({
		id: arrIds.get(profile.id),
		name: profile.name,
		upgradeAllowed: true,
		cutoff: arrIds.get(profile.id),
		items: [],
		minFormatScore: 0,
		cutoffFormatScore: 0,
		minUpgradeFormatScore: 0,
		formatItems: [],
		...(appName === 'Radarr' ? { language: { id: 1, name: 'English' } } : {})
	}));
}
