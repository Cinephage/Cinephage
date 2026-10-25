/**
 * Language Profile Service (v2)
 *
 * Manages combined audio + subtitle language profiles. Each movie/series/
 * library can be assigned a profile; the default profile is the single
 * authority in language_settings.default_profile_id (there is no is_default
 * flag on profiles anymore).
 *
 * The status/cutoff matching is v2-native: it iterates the ordered
 * `subtitles` requirements through the shared requirement matcher and only
 * counts a requirement satisfied when a matching row's file exists on disk.
 * There is no legacy (v1) preference adapter anymore — consumers read the v2
 * `audio` / `subtitles` objects directly.
 */

import { db } from '#lib/server/db/index.js';
import {
	episodes,
	languageProfiles,
	languageSettings,
	libraries,
	movies,
	series,
	smartLists,
	subtitles,
	type LanguageProfileRow
} from '#lib/server/db/schema.js';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });

/** The cutoff descriptor carried by an effective-requirements resolution. */
function cutoffOf(effective: EffectiveSubtitleRequirements): {
	rank: number | null;
	applies: boolean;
} {
	return { rank: effective.profile?.cutoffRank ?? null, applies: effective.cutoffApplies };
}

/**
 * Number of requirements that count toward progress: ranks 0..cutoffRank when
 * a cutoff applies and the rank is valid, else every requirement.
 */
function requirementLimit(
	requirements: SubtitleRequirement[],
	cutoff: { rank: number | null; applies: boolean }
): number {
	const cutoffIndex =
		cutoff.applies && cutoff.rank !== null && cutoff.rank < requirements.length
			? cutoff.rank
			: null;
	return cutoffIndex === null ? requirements.length : cutoffIndex + 1;
}
import type { SubtitleStatus } from '../types';
import { normalizeLanguageCode } from '#lib/shared/languages.js';
import type {
	AudioPreference,
	EffectiveLanguageProfile,
	EffectiveSubtitleRequirements,
	EpisodeSubtitleCounts,
	SubtitleRequirement
} from '#lib/shared/language-profile.js';
import { DEFAULT_MINIMUM_SCORE, requirementKey } from '#lib/shared/language-profile.js';
import { matchesRequirement } from '../requirement-matcher.js';
import { resolveStoredSubtitlePaths } from '../subtitle-paths.js';
import { LanguageSettingsService } from './LanguageSettingsService.js';
import {
	languageProfileV2CreateSchema,
	languageProfileV2UpdateSchema
} from '#lib/validation/schemas.js';

/** Language profile with all fields (v2 shape, see #lib/shared/language-profile). */
export type LanguageProfile = LanguageProfileRow;

/** Create profile input */
export type CreateLanguageProfile = Omit<LanguageProfile, 'id' | 'createdAt' | 'updatedAt'>;

/** Update profile input */
export type UpdateLanguageProfile = Partial<
	Omit<LanguageProfile, 'id' | 'createdAt' | 'updatedAt'>
>;

const VARIANTS = new Set(['regular', 'forced', 'both']);
const ACCESSIBILITIES = new Set(['any', 'prefer-hi', 'require-hi', 'exclude-hi']);

/**
 * Defensively parse the stored audio preference (drizzle usually hands us the
 * parsed object; tolerate raw JSON strings and shape-mismatched data).
 */
export function parseAudioPreference(value: unknown, profileId: string): AudioPreference {
	const parsed = parseJsonColumn(value, 'audio', profileId);
	if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		if (parsed != null) {
			logger.warn({ profileId }, 'Malformed language profile audio JSON; using defaults');
		}
		return { preferOriginal: true, languages: [], mode: 'prefer' };
	}

	const raw = parsed as Partial<AudioPreference>;
	return {
		preferOriginal: typeof raw.preferOriginal === 'boolean' ? raw.preferOriginal : true,
		languages: Array.isArray(raw.languages)
			? raw.languages.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '')
			: [],
		mode: raw.mode === 'require' ? 'require' : 'prefer'
	};
}

/**
 * Defensively parse the stored subtitle requirements, coercing unknown
 * variant/accessibility values and dropping entries without a usable tag.
 */
export function parseSubtitleRequirements(
	value: unknown,
	profileId: string
): SubtitleRequirement[] {
	const parsed = parseJsonColumn(value, 'subtitles', profileId);
	if (parsed == null) return [];
	if (!Array.isArray(parsed)) {
		logger.warn({ profileId }, 'Malformed language profile subtitles JSON; using defaults');
		return [];
	}

	const requirements: SubtitleRequirement[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== 'object') continue;
		const raw = entry as Record<string, unknown>;
		if (typeof raw.tag !== 'string' || raw.tag.trim() === '') continue;

		requirements.push({
			tag: raw.tag.trim(),
			variant:
				typeof raw.variant === 'string' && VARIANTS.has(raw.variant)
					? (raw.variant as SubtitleRequirement['variant'])
					: 'regular',
			accessibility:
				typeof raw.accessibility === 'string' && ACCESSIBILITIES.has(raw.accessibility)
					? (raw.accessibility as SubtitleRequirement['accessibility'])
					: 'any'
		});
	}
	return requirements;
}

/** Parse a JSON column that may arrive as an unparsed string; undefined on failure. */
function parseJsonColumn(value: unknown, field: string, profileId: string): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		logger.warn({ profileId, field }, 'Malformed language profile JSON; using defaults');
		return undefined;
	}
}

/**
 * Service for managing language profiles
 */
export class LanguageProfileService {
	private static instance: LanguageProfileService | null = null;

	private constructor() {}

	static getInstance(): LanguageProfileService {
		if (!LanguageProfileService.instance) {
			LanguageProfileService.instance = new LanguageProfileService();
		}
		return LanguageProfileService.instance;
	}

	// =========================================================================
	// Profile CRUD
	// =========================================================================

	/**
	 * Get all language profiles
	 */
	async getProfiles(): Promise<LanguageProfile[]> {
		const rows = await db.select().from(languageProfiles);
		return rows.map((row) => this.rowToProfile(row));
	}

	/**
	 * Get a specific profile by ID
	 */
	async getProfile(id: string): Promise<LanguageProfile | undefined> {
		const rows = await db.select().from(languageProfiles).where(eq(languageProfiles.id, id));
		return rows[0] ? this.rowToProfile(rows[0]) : undefined;
	}

	/**
	 * Get the default profile. The language_settings singleton is the single
	 * default authority (there is no is_default flag on profiles).
	 */
	async getDefaultProfile(): Promise<LanguageProfile | undefined> {
		const defaultProfileId = await LanguageSettingsService.getInstance().getDefaultProfileId();
		if (!defaultProfileId) return undefined;
		return this.getProfile(defaultProfileId);
	}

	/**
	 * Create a new profile
	 */
	async createProfile(profile: CreateLanguageProfile): Promise<LanguageProfile> {
		const parsed = languageProfileV2CreateSchema.parse(profile);

		const id = randomUUID();

		await db.insert(languageProfiles).values({
			id,
			name: parsed.name,
			audio: parsed.audio,
			subtitles: parsed.subtitles,
			cutoffRank: parsed.cutoffRank,
			minimumScore: parsed.minimumScore,
			upgradesAllowed: parsed.upgradesAllowed
		});

		const created = await this.getProfile(id);
		if (!created) {
			throw new Error('Failed to create profile');
		}

		logger.info({ id, name: parsed.name }, 'Created language profile');
		return created;
	}

	/**
	 * Update a profile
	 */
	async updateProfile(id: string, updates: UpdateLanguageProfile): Promise<LanguageProfile> {
		const existing = await this.getProfile(id);
		if (!existing) {
			throw new Error(`Profile not found: ${id}`);
		}

		const parsed = languageProfileV2UpdateSchema.parse(updates ?? {});

		// The update schema is partial, so re-check the invariants against the
		// merged requirement list.
		const mergedSubtitles = parsed.subtitles ?? existing.subtitles;

		const requirementKeys = mergedSubtitles.map(
			(requirement) => `${requirement.tag}|${requirement.variant}|${requirement.accessibility}`
		);
		if (new Set(requirementKeys).size !== requirementKeys.length) {
			throw new Error('Duplicate subtitle requirements are not allowed');
		}

		const mergedCutoffRank =
			parsed.cutoffRank !== undefined ? parsed.cutoffRank : existing.cutoffRank;
		if (mergedCutoffRank !== null && mergedCutoffRank >= mergedSubtitles.length) {
			throw new Error('Cutoff rank must reference a subtitle requirement');
		}

		const updateData: Record<string, unknown> = {
			updatedAt: new Date().toISOString()
		};

		if (parsed.name !== undefined) updateData.name = parsed.name;
		if (parsed.audio !== undefined) updateData.audio = parsed.audio;
		if (parsed.subtitles !== undefined) updateData.subtitles = parsed.subtitles;
		if (parsed.cutoffRank !== undefined) updateData.cutoffRank = parsed.cutoffRank;
		if (parsed.minimumScore !== undefined) updateData.minimumScore = parsed.minimumScore;
		if (parsed.upgradesAllowed !== undefined) updateData.upgradesAllowed = parsed.upgradesAllowed;

		await db.update(languageProfiles).set(updateData).where(eq(languageProfiles.id, id));

		const updated = await this.getProfile(id);
		if (!updated) {
			throw new Error('Failed to update profile');
		}

		logger.info({ id, name: updated.name }, 'Updated language profile');
		return updated;
	}

	/**
	 * Delete a profile and null every reference to it. References are cleared
	 * explicitly because sqlite connections in the app do not enable foreign
	 * keys, so ON DELETE SET NULL cannot be relied upon.
	 */
	/**
	 * Count how many items' effective resolution references this profile:
	 * direct overrides, items inheriting through library defaults, smart
	 * lists, and whether it is the instance default. Powers the delete
	 * impact preview.
	 */
	async countProfileUsage(profileId: string): Promise<{
		directMovies: number;
		directSeries: number;
		viaLibraries: number;
		smartLists: number;
		isInstanceDefault: boolean;
	}> {
		const [directMovies] = await db
			.select({ count: sql<number>`count(*)` })
			.from(movies)
			.where(eq(movies.languageProfileId, profileId));
		const [directSeries] = await db
			.select({ count: sql<number>`count(*)` })
			.from(series)
			.where(eq(series.languageProfileId, profileId));

		// Items with no override whose owning library defaults to this profile.
		const [moviesViaLibraries] = await db
			.select({ count: sql<number>`count(*)` })
			.from(movies)
			.innerJoin(libraries, eq(movies.libraryId, libraries.id))
			.where(and(eq(libraries.languageProfileId, profileId), isNull(movies.languageProfileId)));
		const [seriesViaLibraries] = await db
			.select({ count: sql<number>`count(*)` })
			.from(series)
			.innerJoin(libraries, eq(series.libraryId, libraries.id))
			.where(and(eq(libraries.languageProfileId, profileId), isNull(series.languageProfileId)));

		const [smartListCount] = await db
			.select({ count: sql<number>`count(*)` })
			.from(smartLists)
			.where(eq(smartLists.languageProfileId, profileId));

		const defaultProfileId = await LanguageSettingsService.getInstance().getDefaultProfileId();

		return {
			directMovies: directMovies?.count ?? 0,
			directSeries: directSeries?.count ?? 0,
			viaLibraries: (moviesViaLibraries?.count ?? 0) + (seriesViaLibraries?.count ?? 0),
			smartLists: smartListCount?.count ?? 0,
			isInstanceDefault: defaultProfileId === profileId
		};
	}

	async deleteProfile(id: string): Promise<void> {
		const existing = await this.getProfile(id);
		if (!existing) {
			throw new Error(`Profile not found: ${id}`);
		}

		// Remove profile from any media/lists/libraries using it
		await db
			.update(movies)
			.set({ languageProfileId: null })
			.where(eq(movies.languageProfileId, id));
		await db
			.update(series)
			.set({ languageProfileId: null })
			.where(eq(series.languageProfileId, id));
		await db
			.update(smartLists)
			.set({ languageProfileId: null })
			.where(eq(smartLists.languageProfileId, id));
		await db
			.update(libraries)
			.set({ languageProfileId: null })
			.where(eq(libraries.languageProfileId, id));
		await db
			.update(languageSettings)
			.set({ defaultProfileId: null, updatedAt: new Date().toISOString() })
			.where(eq(languageSettings.defaultProfileId, id));

		// Delete the profile
		await db.delete(languageProfiles).where(eq(languageProfiles.id, id));

		logger.info({ id }, 'Deleted language profile');
	}

	// =========================================================================
	// Profile Assignment
	// =========================================================================

	/**
	 * Get profile for a movie (item override → library default → instance
	 * default). Delegates to getEffectiveProfileForMovie and discards the
	 * source.
	 */
	async getProfileForMovie(movieId: string): Promise<LanguageProfile | undefined> {
		return (await this.getEffectiveProfileForMovie(movieId))?.profile;
	}

	/**
	 * Get profile for a series (item override → library default → instance
	 * default). Delegates to getEffectiveProfileForSeries and discards the
	 * source.
	 */
	async getProfileForSeries(seriesId: string): Promise<LanguageProfile | undefined> {
		return (await this.getEffectiveProfileForSeries(seriesId))?.profile;
	}

	/**
	 * Resolve the effective profile for a movie WITH its source. Resolution
	 * order: the movie's own override → the owning library's
	 * language_profile_id → language_settings.default_profile_id. Returns null
	 * when the movie does not exist or no profile is configured at any level.
	 *
	 * A dangling override/library id (e.g. a profile deleted out-of-band)
	 * falls through to the next level instead of resolving to nothing.
	 */
	async getEffectiveProfileForMovie(movieId: string): Promise<EffectiveLanguageProfile | null> {
		const [movie] = await db
			.select({
				languageProfileId: movies.languageProfileId,
				libraryId: movies.libraryId
			})
			.from(movies)
			.where(eq(movies.id, movieId))
			.limit(1);
		if (!movie) return null;

		return this.resolveEffectiveProfile(
			movie.languageProfileId ?? null,
			'movie',
			movie.libraryId ?? null
		);
	}

	/**
	 * Resolve the effective profile for a series WITH its source. Same
	 * resolution order as getEffectiveProfileForMovie.
	 */
	async getEffectiveProfileForSeries(seriesId: string): Promise<EffectiveLanguageProfile | null> {
		const [show] = await db
			.select({
				languageProfileId: series.languageProfileId,
				libraryId: series.libraryId
			})
			.from(series)
			.where(eq(series.id, seriesId))
			.limit(1);
		if (!show) return null;

		return this.resolveEffectiveProfile(
			show.languageProfileId ?? null,
			'series',
			show.libraryId ?? null
		);
	}

	/**
	 * Shared resolution: first defined profile among item override → library
	 * default → instance default wins.
	 */
	private async resolveEffectiveProfile(
		overrideProfileId: string | null,
		itemSource: 'movie' | 'series',
		libraryId: string | null
	): Promise<EffectiveLanguageProfile | null> {
		if (overrideProfileId) {
			const profile = await this.getProfile(overrideProfileId);
			if (profile) return { profile, source: itemSource };
			logger.warn(
				{ profileId: overrideProfileId, itemSource, libraryId },
				'Dangling language profile override; falling through to lower precedence'
			);
		}

		if (libraryId) {
			const [library] = await db
				.select({ languageProfileId: libraries.languageProfileId })
				.from(libraries)
				.where(eq(libraries.id, libraryId))
				.limit(1);
			if (library?.languageProfileId) {
				const profile = await this.getProfile(library.languageProfileId);
				if (profile) return { profile, source: 'library' };
			}
		}

		const defaultProfile = await this.getDefaultProfile();
		if (defaultProfile) return { profile: defaultProfile, source: 'default' };

		return null;
	}

	/**
	 * Resolve the subtitle requirements actually in force for an item.
	 *
	 * A per-item override (movies/series/episodes.subtitle_requirements_override)
	 * replaces ONLY the requirement list — the audio/score/upgrade policy still
	 * comes from the profile chain, and the cutoff never applies to an override
	 * (an explicit list means "acquire exactly these"). Without an override the
	 * requirements are the profile chain's subtitles with full cutoff semantics.
	 *
	 * Episode chain: episode override → series resolution (series override →
	 * library default → instance default).
	 *
	 * Returns null when neither an override nor any profile in the chain
	 * resolves (then the item has no subtitle requirements).
	 */
	async getEffectiveSubtitleRequirements(input: {
		movieId?: string;
		seriesId?: string;
		episodeId?: string;
	}): Promise<EffectiveSubtitleRequirements | null> {
		if (input.movieId) {
			const [row] = await db
				.select({
					languageProfileId: movies.languageProfileId,
					subtitleRequirementsOverride: movies.subtitleRequirementsOverride,
					libraryId: movies.libraryId
				})
				.from(movies)
				.where(eq(movies.id, input.movieId))
				.limit(1);
			if (!row) return null;

			const profile = await this.resolveEffectiveProfile(
				row.languageProfileId ?? null,
				'movie',
				row.libraryId ?? null
			);
			return this.withOverride(row.subtitleRequirementsOverride ?? null, profile, 'movie');
		}

		if (input.seriesId) {
			const [row] = await db
				.select({
					languageProfileId: series.languageProfileId,
					subtitleRequirementsOverride: series.subtitleRequirementsOverride,
					libraryId: series.libraryId
				})
				.from(series)
				.where(eq(series.id, input.seriesId))
				.limit(1);
			if (!row) return null;

			const profile = await this.resolveEffectiveProfile(
				row.languageProfileId ?? null,
				'series',
				row.libraryId ?? null
			);
			return this.withOverride(row.subtitleRequirementsOverride ?? null, profile, 'series');
		}

		if (input.episodeId) {
			const [episode] = await db
				.select({
					seriesId: episodes.seriesId,
					subtitleRequirementsOverride: episodes.subtitleRequirementsOverride
				})
				.from(episodes)
				.where(eq(episodes.id, input.episodeId))
				.limit(1);
			if (!episode) return null;

			const [show] = await db
				.select({
					languageProfileId: series.languageProfileId,
					libraryId: series.libraryId
				})
				.from(series)
				.where(eq(series.id, episode.seriesId))
				.limit(1);

			const profile = show
				? await this.resolveEffectiveProfile(
						show.languageProfileId ?? null,
						'series',
						show.libraryId ?? null
					)
				: null;
			return this.withOverride(episode.subtitleRequirementsOverride ?? null, profile, 'episode');
		}

		return null;
	}

	/** Override wins (cutoff never applies); otherwise the profile chain's list. */
	private withOverride(
		override: SubtitleRequirement[] | null,
		profile: EffectiveLanguageProfile | null,
		overrideSource: EffectiveSubtitleRequirements['source']
	): EffectiveSubtitleRequirements | null {
		if (override && override.length > 0) {
			return {
				requirements: override,
				source: overrideSource,
				profile: profile?.profile ?? null,
				cutoffApplies: false
			};
		}
		if (!profile) return null;
		return {
			requirements: profile.profile.subtitles,
			source: profile.source,
			profile: profile.profile,
			cutoffApplies: true
		};
	}

	/**
	 * Assign a profile to a movie
	 */
	async assignToMovie(movieId: string, profileId: string | null): Promise<void> {
		await db.update(movies).set({ languageProfileId: profileId }).where(eq(movies.id, movieId));
	}

	/**
	 * Assign a profile to a series
	 */
	async assignToSeries(seriesId: string, profileId: string | null): Promise<void> {
		await db.update(series).set({ languageProfileId: profileId }).where(eq(series.id, seriesId));
	}

	/**
	 * Assign a profile to a library (inherited by media added to it)
	 */
	async assignToLibrary(libraryId: string, profileId: string | null): Promise<void> {
		await db
			.update(libraries)
			.set({ languageProfileId: profileId })
			.where(eq(libraries.id, libraryId));
	}

	// =========================================================================
	// Subtitle Status
	// =========================================================================

	/**
	 * Get subtitle status for a movie
	 */
	async getMovieSubtitleStatus(movieId: string): Promise<SubtitleStatus> {
		const effective = await this.getEffectiveSubtitleRequirements({ movieId });
		if (!effective) {
			return { satisfied: true, missing: [], existing: [] };
		}

		// Get external subtitles
		const existingSubtitles = await db
			.select()
			.from(subtitles)
			.where(eq(subtitles.movieId, movieId));

		return this.calculateStatus(effective.requirements, existingSubtitles, cutoffOf(effective));
	}

	/**
	 * Get subtitle status for an episode
	 */
	async getEpisodeSubtitleStatus(episodeId: string): Promise<SubtitleStatus> {
		const effective = await this.getEffectiveSubtitleRequirements({ episodeId });
		if (!effective) {
			return { satisfied: true, missing: [], existing: [] };
		}

		// Get external subtitles
		const existingSubtitles = await db
			.select()
			.from(subtitles)
			.where(eq(subtitles.episodeId, episodeId));

		return this.calculateStatus(effective.requirements, existingSubtitles, cutoffOf(effective));
	}

	/**
	 * Get list of episode IDs missing subtitles for a series.
	 *
	 * Override-aware and batched: series-level requirements resolve once,
	 * per-episode overrides and all subtitle rows are fetched in two extra
	 * queries (no per-episode query loop).
	 */
	async getSeriesEpisodesMissingSubtitles(seriesId: string): Promise<string[]> {
		const base = await this.getEffectiveSubtitleRequirements({ seriesId });

		// File-row-driven (arr parity): an episode without a media file is
		// "missing content", not "missing subtitles" — subtitles attach to
		// files, so file-less episodes never count as missing subtitles.
		const seriesEpisodes = await db
			.select({
				id: episodes.id,
				subtitleRequirementsOverride: episodes.subtitleRequirementsOverride
			})
			.from(episodes)
			.where(and(eq(episodes.seriesId, seriesId), eq(episodes.hasFile, true)));
		if (seriesEpisodes.length === 0) return [];

		// No series-level resolution at all: only episodes with an explicit
		// override can be missing anything (their requirements are still real).
		if (!base) {
			const overrideOnly = seriesEpisodes.filter(
				(episode) =>
					episode.subtitleRequirementsOverride && episode.subtitleRequirementsOverride.length > 0
			);
			if (overrideOnly.length === 0) return [];
		}

		const allRows = await db
			.select()
			.from(subtitles)
			.where(
				inArray(
					subtitles.episodeId,
					seriesEpisodes.map((episode) => episode.id)
				)
			);
		const rowsByEpisode = new Map<string, Array<typeof subtitles.$inferSelect>>();
		for (const row of allRows) {
			const list = rowsByEpisode.get(row.episodeId ?? '') ?? [];
			list.push(row);
			rowsByEpisode.set(row.episodeId ?? '', list);
		}

		const missing: string[] = [];

		for (const episode of seriesEpisodes) {
			const override = episode.subtitleRequirementsOverride;
			const requirements = override && override.length > 0 ? override : (base?.requirements ?? []);
			if (requirements.length === 0) continue;

			const cutoff =
				override && override.length > 0
					? { rank: null, applies: false }
					: base
						? cutoffOf(base)
						: { rank: null, applies: false };

			const status = await this.calculateStatus(
				requirements,
				rowsByEpisode.get(episode.id) ?? [],
				cutoff
			);
			if (!status.satisfied && status.missing.length > 0) {
				missing.push(episode.id);
			}
		}

		return missing;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Calculate subtitle status against a requirement list.
	 *
	 * A v2 requirement counts as satisfied only when an external subtitle row
	 * matches its full tuple (language, variant, accessibility via the shared
	 * matcher) AND that row's resolved file exists on disk. `exists` is
	 * injectable so tests can simulate the filesystem; each distinct resolved
	 * path is stat'ed at most once per call.
	 *
	 * Cutoff: when `cutoff.applies` and `cutoff.rank` is set, status is
	 * satisfied once the requirement at that rank is satisfied and `missing` is
	 * truncated after it. Overrides pass `applies: false` (acquire exactly the
	 * listed requirements).
	 *
	 * @param requirements - The effective requirement list to check against
	 * @param existingSubtitles - External subtitle files from the subtitles table
	 * @param cutoff - Whether profile cutoff semantics apply, and at which rank
	 * @param exists - File-existence predicate (defaults to fs.existsSync)
	 */
	private async calculateStatus(
		requirements: SubtitleRequirement[],
		existingSubtitles: Array<typeof subtitles.$inferSelect>,
		cutoff: { rank: number | null; applies: boolean },
		exists: (path: string) => boolean = existsSync
	): Promise<SubtitleStatus> {
		const external = existingSubtitles.filter((sub) => this.isExternalSubtitleRecord(sub));
		const resolvedPaths = await resolveStoredSubtitlePaths(external);
		const existsByPath = this.buildExistsByPath(external, resolvedPaths, exists);

		const satisfiedFlags = this.computeSatisfiedFlags(
			requirements,
			external,
			resolvedPaths,
			existsByPath
		);

		const limit = requirementLimit(requirements, cutoff);
		const missing = requirements.slice(0, limit).filter((_, index) => !satisfiedFlags[index]);
		const satisfied =
			cutoff.applies && cutoff.rank !== null && cutoff.rank < requirements.length
				? satisfiedFlags[cutoff.rank]
				: missing.length === 0;

		const existing: SubtitleStatus['existing'] = external.map((sub) => {
			const matched = requirements.find((requirement) =>
				matchesRequirement(
					{
						language: sub.language,
						isForced: sub.isForced,
						isHearingImpaired: sub.isHearingImpaired
					},
					requirement
				)
			);

			return {
				language: normalizeLanguageCode(sub.language),
				subtitleId: sub.id,
				isForced: sub.isForced ?? false,
				isHearingImpaired: sub.isHearingImpaired ?? false,
				matchScore: sub.matchScore ?? undefined,
				requirementKey: matched ? requirementKey(matched) : null
			};
		});

		return { satisfied, missing, existing };
	}

	/**
	 * Batch per-episode requirement progress for a whole series, cutoff-aware
	 * and per-episode-override-aware.
	 *
	 * Designed for library page loads: callers pass the series' subtitle rows
	 * (already fetched) grouped by episode id. Series-level requirements
	 * resolve once and per-episode overrides are fetched in one extra query;
	 * all path resolution happens in a single batched pass
	 * (resolveStoredSubtitlePaths is N+1-free) and each distinct resolved path
	 * is stat'ed at most once, so the cost is O(1) queries regardless of
	 * episode count — safe for 12k-episode libraries, unlike per-episode
	 * getEpisodeSubtitleStatus calls.
	 *
	 * Returns an empty map when the series has no effective requirements
	 * (callers then fall back to language-agnostic badge behavior). Episodes
	 * seeded in the input map always get an entry; requirements beyond the
	 * cutoff rank are excluded from both counts. `satisfiedViaCutoff` is true
	 * only when the cutoff-rank requirement itself is satisfied (never for
	 * override-driven episodes — they have no cutoff).
	 *
	 * @param seriesId - The series whose effective requirements govern episodes
	 * @param subtitlesByEpisode - Subtitle rows grouped by episode id (seed
	 *   every episode — even with an empty array — to get a counts entry)
	 * @param exists - File-existence predicate (defaults to fs.existsSync)
	 */
	async getSeriesEpisodeSubtitleCounts(
		seriesId: string,
		subtitlesByEpisode: Map<string, Array<typeof subtitles.$inferSelect>>,
		exists: (path: string) => boolean = existsSync
	): Promise<Map<string, EpisodeSubtitleCounts>> {
		const result = new Map<string, EpisodeSubtitleCounts>();
		const base = await this.getEffectiveSubtitleRequirements({ seriesId });

		// Per-episode overrides, fetched in one query for all seeded episodes.
		// File-less episodes are excluded alongside (arr parity: subtitle
		// status describes media you have).
		const episodeIds = [...subtitlesByEpisode.keys()];
		const overrideRows =
			episodeIds.length > 0
				? await db
						.select({
							id: episodes.id,
							override: episodes.subtitleRequirementsOverride,
							hasFile: episodes.hasFile
						})
						.from(episodes)
						.where(inArray(episodes.id, episodeIds))
				: [];
		const overrideById = new Map(
			overrideRows.map(
				(row) => [row.id, { override: row.override ?? null, hasFile: row.hasFile }] as const
			)
		);

		const allExternal = [...subtitlesByEpisode.values()]
			.flat()
			.filter((sub) => this.isExternalSubtitleRecord(sub));
		const resolvedPaths = await resolveStoredSubtitlePaths(allExternal);
		const existsByPath = this.buildExistsByPath(allExternal, resolvedPaths, exists);

		for (const [episodeId, rows] of subtitlesByEpisode) {
			const episodeInfo = overrideById.get(episodeId);
			if (episodeInfo?.hasFile === false) continue;
			const override = episodeInfo?.override ?? null;
			const hasOverride = override !== null && override.length > 0;
			// Contract: no entry when neither the series profile nor the
			// episode's own override provides requirements.
			if (!base && !hasOverride) continue;

			const requirements = hasOverride ? override! : (base?.requirements ?? []);
			const cutoff = hasOverride
				? { rank: null, applies: false }
				: base
					? cutoffOf(base)
					: { rank: null, applies: false };

			const external = rows.filter((sub) => this.isExternalSubtitleRecord(sub));
			const satisfiedFlags = this.computeSatisfiedFlags(
				requirements,
				external,
				resolvedPaths,
				existsByPath
			);
			const limit = requirementLimit(requirements, cutoff);
			const satisfiedViaCutoff =
				cutoff.applies && cutoff.rank !== null && cutoff.rank < requirements.length
					? (satisfiedFlags[cutoff.rank] ?? false)
					: false;

			result.set(episodeId, {
				satisfiedCount: satisfiedFlags.slice(0, limit).filter(Boolean).length,
				totalRequirements: limit,
				satisfiedViaCutoff
			});
		}

		return result;
	}

	/**
	 * Stat each distinct resolved path at most once (shared by single-item and
	 * batch status computation).
	 */
	private buildExistsByPath(
		external: Array<typeof subtitles.$inferSelect>,
		resolvedPaths: Map<string, string | null>,
		exists: (path: string) => boolean
	): Map<string, boolean> {
		const existsByPath = new Map<string, boolean>();
		for (const sub of external) {
			const path = resolvedPaths.get(sub.id) ?? null;
			if (path && !existsByPath.has(path)) {
				existsByPath.set(path, exists(path));
			}
		}
		return existsByPath;
	}

	/** Match every requirement against the episode/item's external rows. */
	private computeSatisfiedFlags(
		requirements: SubtitleRequirement[],
		external: Array<typeof subtitles.$inferSelect>,
		resolvedPaths: Map<string, string | null>,
		existsByPath: Map<string, boolean>
	): boolean[] {
		return requirements.map((requirement) =>
			external.some((sub) => {
				const path = resolvedPaths.get(sub.id) ?? null;
				if (!path || existsByPath.get(path) !== true) return false;
				return matchesRequirement(
					{
						language: sub.language,
						isForced: sub.isForced,
						isHearingImpaired: sub.isHearingImpaired
					},
					requirement
				);
			})
		);
	}

	/**
	 * Convert database row to profile object, defensively parsing the JSON
	 * audio/subtitles columns (fall back to defaults on malformed data).
	 */
	private rowToProfile(row: typeof languageProfiles.$inferSelect): LanguageProfile {
		const audio = parseAudioPreference(row.audio, row.id);
		const requirements = parseSubtitleRequirements(row.subtitles, row.id);

		const cutoffRank =
			typeof row.cutoffRank === 'number' &&
			Number.isInteger(row.cutoffRank) &&
			row.cutoffRank >= 0 &&
			row.cutoffRank < requirements.length
				? row.cutoffRank
				: null;

		return {
			id: row.id,
			name: row.name,
			audio,
			subtitles: requirements,
			cutoffRank,
			minimumScore:
				typeof row.minimumScore === 'number' && row.minimumScore >= 0
					? Math.min(row.minimumScore, 100)
					: DEFAULT_MINIMUM_SCORE,
			upgradesAllowed: row.upgradesAllowed ?? true,
			createdAt: row.createdAt ?? undefined,
			updatedAt: row.updatedAt ?? undefined
		};
	}

	private isExternalSubtitleRecord(subtitle: typeof subtitles.$inferSelect): boolean {
		const format = (subtitle.format ?? '').trim().toLowerCase();
		if (format === 'embedded') {
			return false;
		}

		// Guard against legacy placeholder records that may have been stored with non-file paths.
		// `.idx` is deliberately excluded: it is a VobSub index companion with no
		// subtitle text, so it can never satisfy a requirement on its own (the
		// paired `.sub` carries the text and satisfies it instead).
		const extension = extname(subtitle.relativePath ?? '').toLowerCase();
		const knownExternalExtensions = new Set(['.srt', '.ass', '.ssa', '.sub', '.vtt']);
		return knownExternalExtensions.has(extension);
	}
}

/**
 * Get the singleton LanguageProfileService
 */
export function getLanguageProfileService(): LanguageProfileService {
	return LanguageProfileService.getInstance();
}
