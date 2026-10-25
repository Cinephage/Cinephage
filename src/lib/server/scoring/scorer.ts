/**
 * Scorer Module
 *
 * The core scoring engine that calculates the total score for a release.
 * This is the foundation - profiles configure HOW scores are assigned,
 * but this module handles the actual calculation.
 */

import type {
	ScoringProfile,
	ScoringResult,
	MatchedFormat,
	ScoredFormat,
	ScoreBreakdown,
	ReleaseAttributes,
	SizeValidationContext
} from './types.js';
import { matchFormats, extractAttributes } from './matcher.js';
import { getActiveFormats } from './formats/registry.js';
import { ALL_HDR_FORMATS } from './formats/hdr.js';
import { BANNED_SCORE } from './types.js';
import { ReleaseParser } from '../indexers/parser/ReleaseParser.js';
import { RESOLUTION_ORDER } from '../indexers/parser/types.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });

// Singleton parser instance
const parser = new ReleaseParser();

/**
 * Parse a release name and extract attributes for scoring
 */
export function parseRelease(releaseName: string): ReleaseAttributes {
	const parsed = parser.parse(releaseName);
	return extractAttributes(parsed);
}

/**
 * Calculate the total score for a release against a profile
 * @param releaseName - The release name to score
 * @param profile - The scoring profile to use
 * @param attributes - Optional pre-parsed attributes
 * @param fileSizeBytes - Optional file size in bytes for size filtering
 * @param sizeContext - Optional context for media-specific size validation
 * @param protocol - Optional protocol type (torrent, usenet, streaming) for filtering
 */
export function scoreRelease(
	releaseName: string,
	profile: ScoringProfile,
	attributes?: ReleaseAttributes,
	fileSizeBytes?: number,
	sizeContext?: SizeValidationContext,
	protocol?: 'torrent' | 'usenet' | 'streaming'
): ScoringResult {
	// 1. Extract attributes if not provided
	const attrs = attributes ?? parseRelease(releaseName);

	// 2. Match all formats against the release. This is the full detection
	//    set: required-format checks, bans and the UI all read it, so it must
	//    not be collapsed.
	const detectedFormats = matchFormats(attrs, getActiveFormats());

	// 3. Collapse mutually exclusive formats (HDR) for scoring only. A
	//    DV+HDR10+ release is one HDR pick, not two — but collapsing the
	//    detected set would hide an HDR10+ requirement or ban.
	const scoredFormatSelection = applyMutualExclusivity(detectedFormats, profile);

	// 4. Calculate scores based on profile
	const scoredFormats = calculateFormatScores(scoredFormatSelection, profile);

	// Debug logging for scoring issues
	const formatScoresCount = Object.keys(profile.formatScores).length;
	if (formatScoresCount > 0 && formatScoresCount < 20) {
		// Only log for custom profiles (small number of format scores)
		logger.debug(
			{
				releaseName: releaseName.substring(0, 50),
				profileId: profile.id,
				profileName: profile.name,
				formatScoresCount,
				formatScoresKeys: Object.keys(profile.formatScores),
				matchedFormatIds: detectedFormats.map((f) => f.format.id),
				scoredFormatIds: scoredFormatSelection.map((f) => f.format.id),
				scoredFormats: scoredFormats.map((f) => ({
					id: f.format.id,
					name: f.format.name,
					score: f.score,
					profileHasScore: profile.formatScores[f.format.id] !== undefined
				}))
			},
			'[Scorer] Scoring release'
		);
	}

	// 5. Build score breakdown by category
	const breakdown = buildBreakdown(scoredFormats);

	// 6. Calculate total score
	const totalScore = scoredFormats.reduce((sum, f) => sum + f.score, 0);

	// 7. Check for bans. Bans are evaluated against every detected format, not
	//    the scoring selection: a banned lower-priority format (HDR10+ banned,
	//    release also has DV) must still ban the release rather than being
	//    swallowed by mutual exclusivity.
	const bannedFormats = detectedFormats.filter(
		(f) => (profile.formatScores[f.format.id] ?? 0) <= BANNED_SCORE
	);
	const isBanned = bannedFormats.length > 0;
	const bannedReasons = bannedFormats.map((f) => f.format.name);

	// 8. Check file size limits (media-specific)
	let sizeRejected = false;
	let sizeRejectionReason: string | undefined;

	if (sizeContext) {
		const sizeIsUnknown = fileSizeBytes === undefined || fileSizeBytes === 0;

		if (sizeContext.mediaType === 'movie') {
			const minSize = profile.movieMinSizeGb ?? null;
			const maxSize = profile.movieMaxSizeGb ?? null;
			const hasLimits = minSize !== null || maxSize !== null;

			if (hasLimits && sizeIsUnknown) {
				sizeRejected = true;
				sizeRejectionReason = 'Release size unknown; cannot verify against configured size limits';
			} else if (!sizeIsUnknown) {
				const fileSizeGb = fileSizeBytes! / (1024 * 1024 * 1024);
				if (minSize !== null && fileSizeGb < minSize) {
					sizeRejected = true;
					sizeRejectionReason = `Movie size ${fileSizeGb.toFixed(2)} GB is below minimum ${minSize} GB`;
				} else if (maxSize !== null && fileSizeGb > maxSize) {
					sizeRejected = true;
					sizeRejectionReason = `Movie size ${fileSizeGb.toFixed(2)} GB exceeds maximum ${maxSize} GB`;
				}
			}
		} else if (sizeContext.mediaType === 'tv') {
			const minSizeMb = profile.episodeMinSizeMb ?? null;
			const maxSizeMb = profile.episodeMaxSizeMb ?? null;
			const hasLimits = minSizeMb !== null || maxSizeMb !== null;

			if (hasLimits && sizeIsUnknown) {
				sizeRejected = true;
				sizeRejectionReason = 'Release size unknown; cannot verify against configured size limits';
			} else if (!sizeIsUnknown) {
				const fileSizeMb = fileSizeBytes! / (1024 * 1024);
				let effectiveSizeMb = fileSizeMb;

				if (sizeContext.isSeasonPack) {
					if (!sizeContext.episodeCount || sizeContext.episodeCount <= 0) {
						// Skip size validation for season packs with unknown episode count.
						// episodeCount should be fetched from TMDB in SearchOrchestrator.
						effectiveSizeMb = -1;
					} else {
						effectiveSizeMb = fileSizeMb / sizeContext.episodeCount;
					}
				}

				if (!sizeRejected && effectiveSizeMb > 0) {
					const perEp = sizeContext.isSeasonPack ? ' per episode (avg)' : '';
					if (minSizeMb !== null && effectiveSizeMb < minSizeMb) {
						sizeRejected = true;
						sizeRejectionReason = `Episode size ${effectiveSizeMb.toFixed(0)} MB${perEp} is below minimum ${minSizeMb} MB`;
					} else if (maxSizeMb !== null && effectiveSizeMb > maxSizeMb) {
						sizeRejected = true;
						sizeRejectionReason = `Episode size ${effectiveSizeMb.toFixed(0)} MB${perEp} exceeds maximum ${maxSizeMb} MB`;
					}
				}
			}
		}
	}

	// 8. Check protocol restrictions
	let protocolRejected = false;
	let protocolRejectionReason: string | undefined;

	if (protocol && profile.allowedProtocols && profile.allowedProtocols.length > 0) {
		if (!profile.allowedProtocols.includes(protocol)) {
			protocolRejected = true;
			protocolRejectionReason = `Protocol '${protocol}' not allowed. Profile accepts: ${profile.allowedProtocols.join(', ')}`;
		}
	}

	// 9. Determine if release meets minimum quality threshold
	const meetsMinimum =
		!isBanned && !sizeRejected && !protocolRejected && totalScore >= (profile.minScore ?? 0);

	// Full detection set with the profile's scores attached. Scoring used a
	// mutually-exclusive subset, so a format that was collapsed out for
	// scoring still appears here with its configured score.
	const formatScores = new Map(scoredFormats.map((f) => [f.format.id, f.score]));
	const matchedFormats: ScoredFormat[] = detectedFormats.map((mf) => ({
		format: mf.format,
		conditionResults: mf.conditionResults,
		score: formatScores.get(mf.format.id) ?? profile.formatScores[mf.format.id] ?? 0
	}));

	return {
		releaseName,
		profile: profile.name,
		resolution: attrs.resolution,
		totalScore: isBanned ? -Infinity : totalScore,
		matchedFormats,
		breakdown,
		meetsMinimum,
		isBanned,
		bannedReasons,
		sizeRejected,
		sizeRejectionReason,
		protocolRejected,
		protocolRejectionReason
	};
}

/**
 * HDR format ids in scoring priority order.
 *
 * ALL_HDR_FORMATS is already declared best-first, so this stays in sync with
 * the format definitions rather than duplicating their ids here.
 */
const HDR_PRIORITY: string[] = ALL_HDR_FORMATS.map((format) => format.id);

/**
 * Apply mutual exclusivity rules to prevent double-counting
 * For HDR: only count the highest priority HDR format
 */
function applyMutualExclusivity(
	matchedFormats: MatchedFormat[],
	_profile: ScoringProfile
): MatchedFormat[] {
	// Separate HDR formats from others
	const hdrFormats = matchedFormats.filter((mf) => mf.format.category === 'hdr');
	const otherFormats = matchedFormats.filter((mf) => mf.format.category !== 'hdr');

	// If multiple HDR formats matched, keep only the highest priority one
	if (hdrFormats.length > 1) {
		// Find the highest priority HDR format
		let bestHdr: MatchedFormat | null = null;
		let bestPriority = Infinity;

		for (const hdr of hdrFormats) {
			const priority = HDR_PRIORITY.indexOf(hdr.format.id);
			// If not in priority list, give it low priority
			const effectivePriority = priority === -1 ? 100 : priority;
			if (effectivePriority < bestPriority) {
				bestPriority = effectivePriority;
				bestHdr = hdr;
			}
		}

		return bestHdr ? [...otherFormats, bestHdr] : otherFormats;
	}

	return matchedFormats;
}

/**
 * Calculate scores for matched formats based on profile configuration
 *
 * Scores are defined per-profile. If a profile doesn't specify a score
 * for a format, that format contributes 0 to the total score.
 */
function calculateFormatScores(
	matchedFormats: MatchedFormat[],
	profile: ScoringProfile
): ScoredFormat[] {
	return matchedFormats.map((mf) => {
		// Get score from profile, default to 0 if not specified
		const score = profile.formatScores[mf.format.id] ?? 0;

		return {
			format: mf.format,
			conditionResults: mf.conditionResults,
			score
		};
	});
}

/**
 * Map format category names to breakdown keys
 * Format categories use snake_case, breakdown uses camelCase
 */
function categoryToBreakdownKey(category: string): keyof ScoreBreakdown | null {
	const mapping: Record<string, keyof ScoreBreakdown> = {
		resolution: 'resolution',
		source: 'source',
		codec: 'codec',
		audio: 'audio',
		hdr: 'hdr',
		streaming: 'streaming',
		enhancement: 'enhancement',
		banned: 'banned',
		// Map snake_case categories to camelCase breakdown keys
		release_group_tier: 'releaseGroupTier',
		// Micro and low_quality are types of release groups
		micro: 'releaseGroupTier',
		low_quality: 'releaseGroupTier'
	};
	return mapping[category] ?? null;
}

/**
 * Build score breakdown by category
 */
function buildBreakdown(scoredFormats: ScoredFormat[]): ScoreBreakdown {
	const breakdown: ScoreBreakdown = {
		resolution: { score: 0, formats: [] },
		source: { score: 0, formats: [] },
		codec: { score: 0, formats: [] },
		audio: { score: 0, formats: [] },
		hdr: { score: 0, formats: [] },
		streaming: { score: 0, formats: [] },
		releaseGroupTier: { score: 0, formats: [] },
		banned: { score: 0, formats: [] },
		enhancement: { score: 0, formats: [] }
	};

	for (const mf of scoredFormats) {
		const breakdownKey = categoryToBreakdownKey(mf.format.category);
		if (breakdownKey) {
			breakdown[breakdownKey].score += mf.score;
			breakdown[breakdownKey].formats.push(mf.format.name);
		}
	}

	return breakdown;
}

/**
 * Compare two releases and determine which is better according to a profile
 */
export function compareReleases(
	release1: string,
	release2: string,
	profile: ScoringProfile,
	attrs1?: ReleaseAttributes,
	attrs2?: ReleaseAttributes,
	size1Bytes?: number,
	size2Bytes?: number
): {
	winner: 'release1' | 'release2' | 'tie';
	release1Score: ScoringResult;
	release2Score: ScoringResult;
	scoreDifference: number;
} {
	const score1 = scoreRelease(release1, profile, attrs1, size1Bytes);
	const score2 = scoreRelease(release2, profile, attrs2, size2Bytes);

	const diff = score1.totalScore - score2.totalScore;

	let winner: 'release1' | 'release2' | 'tie';
	if (diff > 0) {
		winner = 'release1';
	} else if (diff < 0) {
		winner = 'release2';
	} else {
		winner = 'tie';
	}

	return {
		winner,
		release1Score: score1,
		release2Score: score2,
		scoreDifference: Math.abs(diff)
	};
}

/**
 * Score multiple releases and sort by quality
 */
export function rankReleases(
	releases: Array<{ name: string; attributes?: ReleaseAttributes; sizeBytes?: number }>,
	profile: ScoringProfile
): Array<ScoringResult & { rank: number }> {
	const scored = releases.map((r) => scoreRelease(r.name, profile, r.attributes, r.sizeBytes));

	// Sort by score descending, banned/size-rejected/protocol-rejected releases go to the end
	scored.sort((a, b) => {
		const aRejected = a.isBanned || a.sizeRejected || a.protocolRejected;
		const bRejected = b.isBanned || b.sizeRejected || b.protocolRejected;
		if (aRejected && !bRejected) return 1;
		if (!aRejected && bRejected) return -1;
		return b.totalScore - a.totalScore;
	});

	return scored.map((s, i) => ({
		...s,
		rank: i + 1
	}));
}

/**
 * Filter releases that meet minimum quality threshold
 */
export function filterQualityReleases(
	releases: Array<{ name: string; attributes?: ReleaseAttributes; sizeBytes?: number }>,
	profile: ScoringProfile
): ScoringResult[] {
	return releases
		.map((r) => scoreRelease(r.name, profile, r.attributes, r.sizeBytes))
		.filter((r) => r.meetsMinimum && !r.isBanned && !r.sizeRejected && !r.protocolRejected);
}

/**
 * Check if a release is an upgrade over an existing one
 */
export function isUpgrade(
	existingRelease: string,
	candidateRelease: string,
	profile: ScoringProfile,
	options: {
		minimumImprovement?: number;
		allowSidegrade?: boolean;
		existingAttrs?: ReleaseAttributes;
		candidateAttrs?: ReleaseAttributes;
		existingSizeBytes?: number;
		candidateSizeBytes?: number;
		existingProtocol?: 'torrent' | 'usenet' | 'streaming';
		candidateProtocol?: 'torrent' | 'usenet' | 'streaming';
	} = {}
): {
	isUpgrade: boolean;
	improvement: number;
	existing: ScoringResult;
	candidate: ScoringResult;
} {
	const { minimumImprovement = 0, allowSidegrade = false } = options;

	const existing = scoreRelease(
		existingRelease,
		profile,
		options.existingAttrs,
		options.existingSizeBytes,
		undefined,
		options.existingProtocol
	);
	const candidate = scoreRelease(
		candidateRelease,
		profile,
		options.candidateAttrs,
		options.candidateSizeBytes,
		undefined,
		options.candidateProtocol
	);

	// Never upgrade to a banned, size-rejected, protocol-rejected, or below-minimum release
	if (
		candidate.isBanned ||
		candidate.sizeRejected ||
		candidate.protocolRejected ||
		!candidate.meetsMinimum
	) {
		return { isUpgrade: false, improvement: 0, existing, candidate };
	}

	// Check resolution downgrade prevention
	if (profile.preventDowngrades) {
		const candidateRes = candidate.resolution;
		const existingRes = existing.resolution;
		if (RESOLUTION_ORDER[candidateRes] < RESOLUTION_ORDER[existingRes]) {
			return {
				isUpgrade: false,
				improvement: candidate.totalScore - existing.totalScore,
				existing,
				candidate
			};
		}
	}

	const improvement = candidate.totalScore - existing.totalScore;

	let isUpgradeResult: boolean;
	if (allowSidegrade) {
		isUpgradeResult = improvement >= minimumImprovement;
	} else {
		isUpgradeResult = improvement > minimumImprovement;
	}

	return {
		isUpgrade: isUpgradeResult,
		improvement,
		existing,
		candidate
	};
}

/**
 * Explain why a release scored the way it did
 */
export function explainScore(result: ScoringResult): string {
	const lines: string[] = [];

	lines.push(`Release: ${result.releaseName}`);
	lines.push(`Profile: ${result.profile}`);
	lines.push(`Total Score: ${result.totalScore}`);
	lines.push('');

	if (result.isBanned) {
		lines.push('BANNED');
		lines.push(`Reasons: ${result.bannedReasons.join(', ')}`);
		lines.push('');
	}

	if (result.sizeRejected) {
		lines.push('SIZE REJECTED');
		lines.push(`Reason: ${result.sizeRejectionReason}`);
		lines.push('');
	}

	if (result.protocolRejected) {
		lines.push('PROTOCOL REJECTED');
		lines.push(`Reason: ${result.protocolRejectionReason}`);
		lines.push('');
	}

	lines.push('Score Breakdown:');

	const categories = Object.entries(result.breakdown).filter(([, data]) => data.formats.length > 0);

	for (const [category, data] of categories) {
		const sign = data.score >= 0 ? '+' : '';
		lines.push(`  ${category}: ${sign}${data.score} (${data.formats.join(', ')})`);
	}

	lines.push('');
	lines.push(`Meets Minimum: ${result.meetsMinimum ? 'Yes' : 'No'}`);

	return lines.join('\n');
}

/**
 * Get all matched format IDs for a release
 */
export function getMatchedFormatIds(releaseName: string, attributes?: ReleaseAttributes): string[] {
	const attrs = attributes ?? parseRelease(releaseName);
	const matched = matchFormats(attrs, getActiveFormats());
	return matched.map((m) => m.format.id);
}

/**
 * Debug helper: show what formats matched and why
 */
export function debugRelease(
	releaseName: string,
	attributes?: ReleaseAttributes
): {
	releaseName: string;
	matchedFormats: Array<{
		id: string;
		name: string;
		category: string;
		conditions: Array<{
			type: string;
			matched: boolean;
			required: boolean;
			negate: boolean;
		}>;
	}>;
} {
	const attrs = attributes ?? parseRelease(releaseName);
	const matched = matchFormats(attrs, getActiveFormats());

	return {
		releaseName,
		matchedFormats: matched.map((m) => ({
			id: m.format.id,
			name: m.format.name,
			category: m.format.category,
			conditions: m.conditionResults.map((c) => ({
				type: c.condition.type,
				matched: c.matches,
				required: c.condition.required,
				negate: c.condition.negate
			}))
		}))
	};
}
