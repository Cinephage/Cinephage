/**
 * Quality Filter
 *
 * Filters and scores releases based on scoring profiles.
 * All filtering and scoring is handled by the ScoringProfile.
 */

import type { ParsedRelease, Resolution, Source } from '../indexers/parser/types.js';
import { RESOLUTION_ORDER } from '../indexers/parser/types.js';
import { db } from '../db/index.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'QualityFilter' });
import { scoringProfiles } from '../db/schema.js';
import { eq } from 'drizzle-orm';

// Import scoring engine
import {
	scoreRelease,
	rankReleases,
	isUpgrade,
	getProfile,
	DEFAULT_PROFILES,
	DEFAULT_RESOLUTION_ORDER,
	type ScoringProfile,
	type ScoringResult,
	type ReleaseAttributes,
	type SizeValidationContext
} from '../scoring/index.js';

/**
 * Enhanced quality result with scoring engine result
 */
export interface EnhancedQualityResult {
	/** Whether the release is accepted */
	accepted: boolean;
	/** Reason for rejection if not accepted */
	rejectionReason?: string;
	/** Quality score from scoring engine */
	score: number;
	/** Full scoring result from the scoring engine */
	scoringResult: ScoringResult;
	/** Matched format names for display */
	matchedFormats: string[];
}

/**
 * QualityFilter - Filter and score releases based on quality preferences
 */
export class QualityFilter {
	private profilesCache: Map<string, ScoringProfile> = new Map();
	private defaultProfile: ScoringProfile | null = null;

	private coerceNullableNumber(value: unknown): number | null {
		if (value === null || value === undefined) return null;
		if (typeof value === 'number') return Number.isFinite(value) ? value : null;
		if (typeof value === 'string') {
			const trimmed = value.trim();
			if (!trimmed) return null;
			const parsed = Number(trimmed);
			return Number.isFinite(parsed) ? parsed : null;
		}
		return null;
	}

	/**
	 * Clear all caches - call this when profiles are updated
	 */
	clearCache(): void {
		this.profilesCache.clear();
		this.defaultProfile = null;
	}

	/**
	 * Clear profile cache specifically
	 */
	clearProfileCache(profileId?: string): void {
		if (profileId) {
			const hadCached = this.profilesCache.has(profileId);
			this.profilesCache.delete(profileId);
			logger.debug(
				{
					profileId,
					wasCached: hadCached
				},
				'[QualityFilter] Cache cleared for profile'
			);
		} else {
			const count = this.profilesCache.size;
			this.profilesCache.clear();
			logger.debug({ count }, '[QualityFilter] All profile cache cleared');
		}
		this.defaultProfile = null;
	}

	/**
	 * Get a scoring profile by ID from cache or database.
	 */
	async getProfile(id: string): Promise<ScoringProfile | null> {
		if (this.profilesCache.has(id)) {
			const cached = this.profilesCache.get(id)!;
			logger.debug(
				{ id, cachedName: cached.name, formatScoresCount: Object.keys(cached.formatScores).length },
				'[QualityFilter.getProfile] Cache hit'
			);
			return cached;
		}

		logger.debug({ id }, '[QualityFilter.getProfile] Loading profile from DB');

		const result = await db.select().from(scoringProfiles).where(eq(scoringProfiles.id, id)).get();
		if (result) {
			const profile = this.mapDbToProfile(result);
			this.profilesCache.set(id, profile);
			return profile;
		}

		return null;
	}

	/**
	 * Get the default scoring profile.
	 * Priority: isDefault row > 'balanced' > any profile > error.
	 */
	async getDefaultScoringProfile(): Promise<ScoringProfile> {
		if (this.defaultProfile) {
			return this.defaultProfile;
		}

		const defaultRow = await db
			.select()
			.from(scoringProfiles)
			.where(eq(scoringProfiles.isDefault, true))
			.get();

		if (defaultRow) {
			this.defaultProfile = this.mapDbToProfile(defaultRow);
			return this.defaultProfile;
		}

		const balancedRow = await db
			.select()
			.from(scoringProfiles)
			.where(eq(scoringProfiles.id, 'balanced'))
			.get();

		if (balancedRow) {
			this.defaultProfile = this.mapDbToProfile(balancedRow);
			return this.defaultProfile;
		}

		const anyRow = await db.select().from(scoringProfiles).get();
		if (anyRow) {
			this.defaultProfile = this.mapDbToProfile(anyRow);
			return this.defaultProfile;
		}

		throw new Error('No scoring profiles found in database');
	}

	/**
	 * Get all scoring profiles (built-in + custom) from database.
	 * Built-in rows get UI metadata (icon, color, category) from code profiles.
	 */
	async getAllProfiles(): Promise<ScoringProfile[]> {
		const dbRows = await db.select().from(scoringProfiles).all();

		const profiles = dbRows.map((row) => {
			const profile = this.mapDbToProfile(row);
			if (row.isBuiltIn) {
				const codeProfile = getProfile(row.id);
				if (codeProfile) {
					profile.icon = codeProfile.icon;
					profile.color = codeProfile.color;
					profile.category = codeProfile.category;
				}
			}
			return profile;
		});

		const builtIns = profiles.filter((p) => dbRows.find((r) => r.id === p.id)?.isBuiltIn);
		const customs = profiles.filter((p) => !dbRows.find((r) => r.id === p.id)?.isBuiltIn);

		return [...builtIns, ...customs];
	}

	/**
	 * Seed and sync default scoring profiles to database.
	 * Built-in profiles are seeded with code defaults; user-customized fields are preserved.
	 * Custom profiles that happen to share an ID are skipped.
	 */
	async seedDefaultScoringProfiles(): Promise<void> {
		const existingRows = await db.select().from(scoringProfiles).all();
		const existingMap = new Map(existingRows.map((r) => [r.id, r]));

		let seeded = 0;
		let updated = 0;

		for (const profile of DEFAULT_PROFILES) {
			const existing = existingMap.get(profile.id);

			if (existing && existing.isBuiltIn) {
				const codeFormatScores = profile.formatScores ?? {};
				const dbFormatScores = existing.formatScores ?? {};
				const mergedFormatScores = { ...codeFormatScores, ...dbFormatScores };

				await db
					.update(scoringProfiles)
					.set({
						name: profile.name,
						description: profile.description ?? null,
						tags: profile.tags ?? [],
						upgradesAllowed: profile.upgradesAllowed ?? true,
						preventDowngrades: profile.preventDowngrades ?? false,
						minScore: profile.minScore ?? 0,
						upgradeUntilScore: profile.upgradeUntilScore ?? -1,
						minScoreIncrement: profile.minScoreIncrement ?? 0,
						resolutionOrder: profile.resolutionOrder ?? null,
						formatScores: mergedFormatScores,
						allowedProtocols: profile.allowedProtocols ?? null,
						minResolution: (profile.minResolution as string | null) ?? null,
						maxResolution: (profile.maxResolution as string | null) ?? null,
						allowedSources: profile.allowedSources ?? null,
						excludedSources: profile.excludedSources ?? null,
						updatedAt: new Date().toISOString()
					})
					.where(eq(scoringProfiles.id, profile.id));
				updated++;
			} else if (!existing) {
				await db.insert(scoringProfiles).values({
					id: profile.id,
					name: profile.name,
					description: profile.description ?? null,
					tags: profile.tags ?? [],
					upgradesAllowed: profile.upgradesAllowed ?? true,
					preventDowngrades: profile.preventDowngrades ?? false,
					minScore: profile.minScore ?? 0,
					upgradeUntilScore: profile.upgradeUntilScore ?? -1,
					minScoreIncrement: profile.minScoreIncrement ?? 0,
					resolutionOrder: profile.resolutionOrder ?? null,
					formatScores: profile.formatScores ?? null,
					allowedProtocols: profile.allowedProtocols ?? null,
					minResolution: (profile.minResolution as string | null) ?? null,
					maxResolution: (profile.maxResolution as string | null) ?? null,
					allowedSources: profile.allowedSources ?? null,
					excludedSources: profile.excludedSources ?? null,
					isBuiltIn: true,
					isDefault: profile.id === 'balanced'
				});
				seeded++;
			}
		}

		if (seeded > 0) {
			logger.info(`Seeded ${seeded} default scoring profile(s) to database`);
		}
		if (updated > 0) {
			logger.info(`Synced ${updated} default scoring profile(s) with latest definitions`);
		}
	}

	/**
	 * Check if a parsed release meets the minimum requirements from the profile
	 */
	private meetsMinimum(
		parsed: ParsedRelease,
		profile: ScoringProfile
	): { ok: boolean; reason?: string } {
		// Check minimum resolution
		if (profile.minResolution) {
			const minOrder = RESOLUTION_ORDER[profile.minResolution];
			const releaseOrder = RESOLUTION_ORDER[parsed.resolution];
			if (releaseOrder < minOrder) {
				return {
					ok: false,
					reason: `Resolution ${parsed.resolution} below minimum ${profile.minResolution}`
				};
			}
		}

		// Check maximum resolution
		if (profile.maxResolution) {
			const maxOrder = RESOLUTION_ORDER[profile.maxResolution];
			const releaseOrder = RESOLUTION_ORDER[parsed.resolution];
			if (releaseOrder > maxOrder) {
				return {
					ok: false,
					reason: `Resolution ${parsed.resolution} above maximum ${profile.maxResolution}`
				};
			}
		}

		// Check allowed sources
		if (profile.allowedSources && profile.allowedSources.length > 0) {
			if (!profile.allowedSources.includes(parsed.source)) {
				return {
					ok: false,
					reason: `Source ${parsed.source} not in allowed list`
				};
			}
		}

		// Check excluded sources
		if (profile.excludedSources && profile.excludedSources.length > 0) {
			if (profile.excludedSources.includes(parsed.source)) {
				return {
					ok: false,
					reason: `Source ${parsed.source} is excluded`
				};
			}
		}

		return { ok: true };
	}

	/**
	 * Calculate an enhanced quality score using the scoring engine
	 * Combines profile filtering with full format-based scoring
	 * @param fileSizeBytes - Optional file size in bytes for size filtering
	 * @param sizeContext - Optional context for media-specific size validation
	 */
	calculateEnhancedScore(
		parsed: ParsedRelease,
		profile: ScoringProfile,
		fileSizeBytes?: number,
		sizeContext?: SizeValidationContext,
		indexerName?: string,
		protocol?: 'torrent' | 'usenet' | 'streaming'
	): EnhancedQualityResult {
		// First, check profile requirements (pass/fail filter)
		const minCheck = this.meetsMinimum(parsed, profile);

		// Build release attributes for scoring engine
		const attributes: ReleaseAttributes = {
			title: parsed.originalTitle,
			cleanTitle: parsed.cleanTitle,
			year: parsed.year,
			resolution: parsed.resolution,
			source: parsed.source,
			codec: parsed.codec,
			hdr: parsed.hdr,
			audioCodec: parsed.audioCodec,
			audioChannels: parsed.audioChannels,
			hasAtmos: parsed.hasAtmos,
			releaseGroup: parsed.releaseGroup,
			streamingService: parsed.streamingService,
			edition: parsed.edition,
			languages: parsed.languages,
			indexerName, // Pass indexer name for indexer-based matching
			isRemux: parsed.isRemux,
			isRepack: parsed.isRepack,
			isProper: parsed.isProper,
			is3d: parsed.is3d,
			isSeasonPack: parsed.episode?.isSeasonPack,
			isCompleteSeries: parsed.episode?.isCompleteSeries
		};

		// Run the scoring engine with file size and media context for size filtering
		const scoringResult = scoreRelease(
			parsed.originalTitle,
			profile,
			attributes,
			fileSizeBytes,
			sizeContext,
			protocol
		);

		// Check for scoring engine bans, size rejections, and minimum score
		const accepted =
			minCheck.ok &&
			!scoringResult.isBanned &&
			!scoringResult.sizeRejected &&
			scoringResult.meetsMinimum;
		let rejectionReason = minCheck.reason;

		if (!rejectionReason && scoringResult.isBanned) {
			rejectionReason = `Banned: ${scoringResult.bannedReasons.join(', ')}`;
		}

		if (!rejectionReason && scoringResult.sizeRejected) {
			rejectionReason = scoringResult.sizeRejectionReason;
		}

		if (!rejectionReason && !scoringResult.meetsMinimum) {
			rejectionReason = `Score ${scoringResult.totalScore} below minimum ${profile.minScore ?? 0}`;
		}

		// Use raw score directly - no normalization needed with new additive scoring
		const qualityScore = scoringResult.totalScore;

		return {
			accepted,
			rejectionReason,
			score: qualityScore,
			scoringResult,
			matchedFormats: scoringResult.matchedFormats.map((f) => f.format.name)
		};
	}

	/**
	 * Rank multiple releases using the scoring engine
	 */
	rankReleases(
		releases: Array<{ parsed: ParsedRelease; name: string }>,
		profile: ScoringProfile
	): Array<{
		name: string;
		parsed: ParsedRelease;
		result: ScoringResult;
		rank: number;
	}> {
		const withAttrs = releases.map((r) => ({
			name: r.name,
			parsed: r.parsed,
			attributes: this.parsedToAttributes(r.parsed)
		}));

		const ranked = rankReleases(
			withAttrs.map((r) => ({ name: r.name, attributes: r.attributes })),
			profile
		);

		return ranked.map((r, i) => ({
			name: r.releaseName,
			parsed: withAttrs[i].parsed,
			result: r,
			rank: r.rank
		}));
	}

	/**
	 * Check if a candidate release is an upgrade over an existing one
	 */
	checkUpgrade(
		existing: ParsedRelease,
		candidate: ParsedRelease,
		profile: ScoringProfile,
		options: { minimumImprovement?: number } = {}
	): {
		isUpgrade: boolean;
		improvement: number;
		existing: ScoringResult;
		candidate: ScoringResult;
	} {
		const existingAttrs = this.parsedToAttributes(existing);
		const candidateAttrs = this.parsedToAttributes(candidate);

		return isUpgrade(existing.originalTitle, candidate.originalTitle, profile, {
			minimumImprovement: options.minimumImprovement ?? profile.minScoreIncrement,
			existingAttrs,
			candidateAttrs
		});
	}

	/**
	 * Convert ParsedRelease to ReleaseAttributes
	 */
	private parsedToAttributes(parsed: ParsedRelease): ReleaseAttributes {
		return {
			title: parsed.originalTitle,
			cleanTitle: parsed.cleanTitle,
			year: parsed.year,
			resolution: parsed.resolution,
			source: parsed.source,
			codec: parsed.codec,
			hdr: parsed.hdr,
			audioCodec: parsed.audioCodec,
			audioChannels: parsed.audioChannels,
			hasAtmos: parsed.hasAtmos,
			releaseGroup: parsed.releaseGroup,
			streamingService: parsed.streamingService,
			edition: parsed.edition,
			languages: parsed.languages,
			isRemux: parsed.isRemux,
			isRepack: parsed.isRepack,
			isProper: parsed.isProper,
			is3d: parsed.is3d,
			isSeasonPack: parsed.episode?.isSeasonPack,
			isCompleteSeries: parsed.episode?.isCompleteSeries
		};
	}

	/**
	 * Map database row to ScoringProfile.
	 * All fields come from the DB row; no runtime inheritance.
	 */
	private mapDbToProfile(row: typeof scoringProfiles.$inferSelect): ScoringProfile {
		return {
			id: row.id,
			name: row.name,
			description: row.description ?? '',
			tags: row.tags ?? [],
			upgradesAllowed: row.upgradesAllowed ?? true,
			preventDowngrades: row.preventDowngrades ?? false,
			minScore: row.minScore ?? 0,
			upgradeUntilScore: row.upgradeUntilScore ?? -1,
			minScoreIncrement: row.minScoreIncrement ?? 0,
			movieMinSizeGb: this.coerceNullableNumber(row.movieMinSizeGb),
			movieMaxSizeGb: this.coerceNullableNumber(row.movieMaxSizeGb),
			episodeMinSizeMb: this.coerceNullableNumber(row.episodeMinSizeMb),
			episodeMaxSizeMb: this.coerceNullableNumber(row.episodeMaxSizeMb),
			resolutionOrder: (row.resolutionOrder as Resolution[]) ?? DEFAULT_RESOLUTION_ORDER,
			minResolution: (row.minResolution as Resolution | null) ?? null,
			maxResolution: (row.maxResolution as Resolution | null) ?? null,
			allowedSources: (row.allowedSources as Source[] | null) ?? null,
			excludedSources: (row.excludedSources as Source[] | null) ?? null,
			allowedProtocols: row.allowedProtocols ?? ['torrent', 'usenet'],
			formatScores: row.formatScores ?? {},
			requiredFormats: row.requiredFormats ?? []
		};
	}
}

/**
 * Singleton instance
 */
export const qualityFilter = new QualityFilter();
