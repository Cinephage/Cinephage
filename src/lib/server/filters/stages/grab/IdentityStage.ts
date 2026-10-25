import type { DecisionStage, StageResult } from '../../types.js';
import type { GrabDecisionContext } from './types.js';
import { parseRelease } from '#lib/server/indexers/parser/index.js';
import { matchReleaseToTarget } from '#lib/server/releases/release-identity.js';

/**
 * HARD stage: verifies the release actually refers to the target media.
 *
 * Runs for EVERY grab — manual, forced, and arr-interactive included. `force`
 * may skip policy (scoring, size, language, delay), never identity. This is
 * the grab-time counterpart of the search-time target filter; it closes the
 * gap where server-side callers (auto-search, cascading strategies, arr
 * pushes) bypassed the old route-level title check, and extends it to movies
 * and interactive grabs.
 *
 * Rejects:
 *  - title/year mismatches per the shared release-identity matcher
 *  - automatic movie grabs without year evidence (the "Halloween" incident
 *    class: a year-less release name cannot prove which same-titled movie
 *    it is)
 *  - TV releases whose parsed season/episode contradicts the target scope
 */
export class IdentityStage implements DecisionStage<GrabDecisionContext> {
	name = 'identity';

	// Fail-open only when the caller built a context without resolved target
	// information (legacy unit tests). Production always resolves it.
	isEnabled(ctx: GrabDecisionContext): boolean {
		return !!ctx.targetInfo && ctx.targetInfo.titles.length > 0;
	}

	async evaluate(ctx: GrabDecisionContext): Promise<StageResult> {
		const info = ctx.targetInfo!;
		const parsed = parseRelease(ctx.release.title, {
			mode: info.mediaType === 'movie' ? 'movie' : undefined
		});

		const match = matchReleaseToTarget({
			releaseTitle: parsed.cleanTitle,
			releaseYear: parsed.year,
			targetTitles: info.titles,
			targetYear: info.year,
			// TV releases legitimately carry air years far past the series'
			// first-air year (long-running shows); movies must agree ±1.
			yearMode: info.mediaType === 'tv' ? 'forward-drift' : 'strict'
		});

		// ID-asserted releases (the indexer/search resolved an external id) are
		// accepted even when the title match is inconclusive — localized or
		// alternate naming can defeat title matching while the ID is exact.
		// The ID also counts as year evidence for automatic movie grabs.
		const idMethod = this.matchExternalId(ctx.release, info);
		if (idMethod) {
			return { accepted: true, details: { identityMethod: `external_id:${idMethod}` } };
		}

		if (!match.matched) {
			const targetLabel = `${info.titles[0]}${info.year != null ? ` (${info.year})` : ''}`;
			return {
				accepted: false,
				reason:
					match.reason === 'year_mismatch'
						? `Release year ${parsed.year} does not match target ${targetLabel}`
						: `Release title "${parsed.cleanTitle || ctx.release.title}" does not match target ${targetLabel}`,
				details: {
					rejectionType: 'identity_mismatch',
					matchReason: match.reason,
					parsedTitle: parsed.cleanTitle,
					parsedYear: parsed.year,
					bestCandidate: match.bestCandidate,
					bestSimilarity: match.bestSimilarity
				}
			};
		}

		// Automatic movie grabs need year evidence when the target carries a
		// year: a year-less title like "Halloween" cannot distinguish 1978
		// from 2018. Interactive grabs are allowed — the user judged it.
		if (
			info.mediaType === 'movie' &&
			ctx.options.isAutomatic &&
			!ctx.options.force &&
			info.year != null &&
			!parsed.year
		) {
			return {
				accepted: false,
				reason: `Automatic movie grab rejected: release title carries no year to confirm it is "${match.bestCandidate}" (${info.year})`,
				details: {
					rejectionType: 'identity_mismatch',
					matchReason: 'no_year_evidence',
					parsedTitle: parsed.cleanTitle
				}
			};
		}

		const scopeRejection = this.checkEpisodeScope(ctx, parsed);
		if (scopeRejection) return scopeRejection;

		return { accepted: true, details: { identityMethod: match.method } };
	}

	private matchExternalId(
		release: GrabDecisionContext['release'],
		info: GrabDecisionContext['targetInfo'] & object
	): string | null {
		if (release.tmdbId != null && info.tmdbId != null && release.tmdbId === info.tmdbId) {
			return 'tmdb';
		}
		if (
			release.imdbId &&
			info.imdbId &&
			release.imdbId.toLowerCase() === info.imdbId.toLowerCase()
		) {
			return 'imdb';
		}
		if (release.tvdbId != null && info.tvdbId != null && release.tvdbId === info.tvdbId) {
			return 'tvdb';
		}
		return null;
	}

	private checkEpisodeScope(
		ctx: GrabDecisionContext,
		parsed: ReturnType<typeof parseRelease>
	): StageResult | undefined {
		const info = ctx.targetInfo!;
		if (info.mediaType !== 'tv' || !parsed.episode) return undefined;

		const episode = parsed.episode;
		if (episode.isDaily || episode.isCompleteSeries) return undefined;

		const parsedSeasons = new Set<number>();
		if (episode.season != null) parsedSeasons.add(episode.season);
		for (const s of episode.seasons ?? []) parsedSeasons.add(s);

		if (parsedSeasons.size > 0) {
			if (info.seasonNumber != null && !parsedSeasons.has(info.seasonNumber)) {
				return {
					accepted: false,
					reason: `Release season ${[...parsedSeasons].join(', ')} does not match target season ${info.seasonNumber}`,
					details: {
						rejectionType: 'identity_mismatch',
						matchReason: 'season_scope_mismatch',
						parsedSeasons: [...parsedSeasons],
						targetSeason: info.seasonNumber
					}
				};
			}

			// Episode-scoped targets: a single-episode release must be that
			// episode; season packs covering the target season are fine.
			const scope = info.episodeScope ?? [];

			// Defense in depth for callers that built a context without an
			// explicit target season: reject a single-episode release whose
			// season appears nowhere in the episode scope (e.g. S02E05 for a
			// target scope of {S01E05}).
			if (
				info.seasonNumber == null &&
				scope.length > 0 &&
				!episode.isSeasonPack &&
				episode.season != null
			) {
				const anySeasonMatch = scope.some((e) => e.seasonNumber === episode.season);
				if (!anySeasonMatch) {
					return {
						accepted: false,
						reason: `Release S${episode.season} is outside the target episode scope`,
						details: {
							rejectionType: 'identity_mismatch',
							matchReason: 'season_scope_mismatch',
							parsedSeason: episode.season,
							targetSeasons: [...new Set(scope.map((e) => e.seasonNumber))]
						}
					};
				}
			}

			if (
				scope.length > 0 &&
				!episode.isSeasonPack &&
				episode.season != null &&
				episode.episodes &&
				episode.episodes.length > 0
			) {
				const scopeForSeason = scope.filter((e) => e.seasonNumber === episode.season);
				const coversTarget = scopeForSeason.some((e) =>
					episode.episodes!.includes(e.episodeNumber)
				);
				if (scopeForSeason.length > 0 && !coversTarget) {
					return {
						accepted: false,
						reason: `Release S${episode.season}E${episode.episodes.join('E')} is outside the target episode scope`,
						details: {
							rejectionType: 'identity_mismatch',
							matchReason: 'episode_scope_mismatch',
							parsedSeason: episode.season,
							parsedEpisodes: episode.episodes
						}
					};
				}
			}
		}

		return undefined;
	}
}
