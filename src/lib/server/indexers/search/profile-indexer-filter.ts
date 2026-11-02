/**
 * Resolve the indexer scope a scoring profile imposes on a search.
 *
 * A profile carries two independent restrictions:
 *   - `allowedProtocols` — torrent / usenet / streaming
 *   - `allowedIndexerIds` — an explicit indexer allowlist (null = all)
 *
 * Search entry points need both, plus the profile ID they resolved to, so that
 * enrichment and the orchestrator agree on the same profile. Resolving it in one
 * place keeps the ~15 search call sites from each inventing their own fallback.
 */

import { qualityFilter } from '#lib/server/quality/index.js';

export interface ProfileSearchScope {
	/** Profile ID used for enrichment and scoring. */
	scoringProfileId: string;
	/** Indexer allowlist, or null when the profile is unrestricted. */
	allowedIndexerIds: string[] | null;
	/** Protocol allowlist, or undefined when unrestricted. */
	protocolFilter: string[] | undefined;
	/** Profile display name, for diagnostics and availability messages. */
	profileName: string;
}

/**
 * Resolve the profile scope for a search.
 *
 * Falls back to the default scoring profile when `profileId` is absent or no
 * longer exists, matching how the enricher behaves.
 */
export async function resolveProfileSearchScope(
	profileId?: string | null
): Promise<ProfileSearchScope> {
	const profile = profileId ? await qualityFilter.getProfile(profileId) : null;
	const resolved = profile ?? (await qualityFilter.getDefaultScoringProfile());

	const allowedIndexerIds =
		resolved.allowedIndexerIds && resolved.allowedIndexerIds.length > 0
			? resolved.allowedIndexerIds
			: null;
	const protocolFilter =
		resolved.allowedProtocols && resolved.allowedProtocols.length > 0
			? resolved.allowedProtocols
			: undefined;

	return {
		scoringProfileId: resolved.id,
		allowedIndexerIds,
		protocolFilter,
		profileName: resolved.name
	};
}

/**
 * Resolve the indexer allowlist a search should honour for a profile.
 *
 * Falls back to the default profile when no ID is given, mirroring how
 * ReleaseEnricher picks the profile it scores with. Without this fallback an
 * item with no explicit profile would be scored against the default profile
 * while searching every indexer — the search scope and the scoring profile
 * would disagree.
 *
 * Resolution is best-effort: a missing profile table or an unseeded database
 * must not turn into a failed search, so any lookup error degrades to
 * "unrestricted" (the historical behavior).
 */
export async function resolveAllowedIndexerIds(
	profileId?: string | null
): Promise<string[] | null> {
	try {
		const profile = profileId
			? await qualityFilter.getProfile(profileId)
			: await qualityFilter.getDefaultScoringProfile();

		if (!profile?.allowedIndexerIds || profile.allowedIndexerIds.length === 0) return null;

		return profile.allowedIndexerIds;
	} catch {
		return null;
	}
}
