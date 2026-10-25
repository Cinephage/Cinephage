import type { PageServerLoad } from './$types';
import type { Resolution } from '#lib/server/scoring/types.js';
import { db } from '#lib/server/db/index.js';
import { scoringProfiles, customFormats } from '#lib/server/db/schema.js';
import {
	DEFAULT_PROFILES,
	DEFAULT_RESOLUTION_ORDER,
	ALL_FORMATS
} from '#lib/server/scoring/index.js';
import { toNullableNumber } from '#lib/utils/number.js';
import { delayProfileService } from '#lib/server/monitoring/specifications/DelaySpecification.js';

// Built-in profile IDs - derived from DEFAULT_PROFILES for single source of truth
const BUILT_IN_PROFILE_IDS = DEFAULT_PROFILES.map((p) => p.id);

export const load: PageServerLoad = async ({ url }) => {
	// Get active tab from URL params (default to profiles)
	const activeTab = url.searchParams.get('tab') || 'profiles';

	// ===================
	// Load Profiles
	// ===================

	const dbProfiles = await db.select().from(scoringProfiles);
	const customProfiles = dbProfiles.filter((p) => !BUILT_IN_PROFILE_IDS.includes(p.id));
	const builtInDbMap = new Map(
		dbProfiles.filter((p) => BUILT_IN_PROFILE_IDS.includes(p.id)).map((p) => [p.id, p])
	);

	const dbDefaultId = dbProfiles.find((p) => p.isDefault)?.id;

	// Map custom profiles from database
	const mappedCustomProfiles = customProfiles.map((p) => ({
		id: p.id,
		name: p.name,
		description: p.description ?? '',
		tags: p.tags ?? [],
		icon: 'Settings',
		color: 'text-base-content',
		category: 'custom' as const,
		upgradesAllowed: p.upgradesAllowed ?? true,
		preventDowngrades: p.preventDowngrades ?? false,
		minScore: p.minScore ?? 0,
		upgradeUntilScore: p.upgradeUntilScore ?? -1,
		minScoreIncrement: p.minScoreIncrement ?? 0,
		resolutionOrder: (p.resolutionOrder as Resolution[] | null) ?? DEFAULT_RESOLUTION_ORDER,
		formatScores: p.formatScores ?? {},
		requiredFormats: p.requiredFormats ?? [],
		movieMinSizeGb: toNullableNumber(p.movieMinSizeGb),
		movieMaxSizeGb: toNullableNumber(p.movieMaxSizeGb),
		episodeMinSizeMb: toNullableNumber(p.episodeMinSizeMb),
		episodeMaxSizeMb: toNullableNumber(p.episodeMaxSizeMb),
		isDefault: p.isDefault ?? false,
		isBuiltIn: false
	}));

	// Build built-in profiles from code + overrides from DB
	const builtInProfiles = DEFAULT_PROFILES.map((p) => {
		const dbProfile = builtInDbMap.get(p.id);

		return {
			...p,
			preventDowngrades: dbProfile?.preventDowngrades ?? p.preventDowngrades,
			formatScores: dbProfile?.formatScores ?? p.formatScores ?? {},
			requiredFormats: dbProfile?.requiredFormats ?? [],
			movieMinSizeGb: toNullableNumber(dbProfile?.movieMinSizeGb),
			movieMaxSizeGb: toNullableNumber(dbProfile?.movieMaxSizeGb),
			episodeMinSizeMb: toNullableNumber(dbProfile?.episodeMinSizeMb),
			episodeMaxSizeMb: toNullableNumber(dbProfile?.episodeMaxSizeMb),
			isBuiltIn: true,
			isDefault: dbDefaultId === p.id || (!dbDefaultId && p.id === 'balanced')
		};
	});

	// Combine: built-in first, then custom
	const allProfiles = [...builtInProfiles, ...mappedCustomProfiles];

	// Determine the actual default profile ID
	const defaultProfileId = dbDefaultId ?? 'balanced';

	// ===================
	// Load Formats
	// ===================

	// Get custom formats from database
	const dbFormats = await db.select().from(customFormats);

	// Map database formats
	const customFormatsList = dbFormats.map((f) => ({
		id: f.id,
		name: f.name,
		description: f.description ?? undefined,
		category: f.category,
		tags: f.tags ?? [],
		conditions: f.conditions ?? [],
		enabled: f.enabled ?? true,
		isBuiltIn: false,
		createdAt: f.createdAt,
		updatedAt: f.updatedAt
	}));

	// Map built-in formats with explicit typing
	const builtInFormats = ALL_FORMATS.map((f) => ({
		id: f.id,
		name: f.name,
		description: f.description as string | undefined,
		category: f.category,
		tags: f.tags,
		conditions: f.conditions,
		enabled: true as const,
		isBuiltIn: true as const
	}));

	// Combine formats
	const allFormats = [...builtInFormats, ...customFormatsList];

	const delayProfiles = await delayProfileService.getProfiles();

	return {
		activeTab,
		// Profiles data
		profiles: allProfiles,
		defaultProfileId,
		// Formats data
		formats: allFormats,
		formatCounts: {
			total: allFormats.length,
			builtIn: builtInFormats.length,
			custom: customFormatsList.length
		},
		// Delay profiles
		delayProfiles
	};
};
