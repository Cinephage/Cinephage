/**
 * Combined audio + subtitle language profile model.
 *
 * One profile per media item expresses ordered audio preferences and ordered
 * subtitle requirements. Forced/HI intent is part of each requirement tuple,
 * which prevents contradictory boolean combinations.
 */

import type { LanguageTag } from './languages.js';

export type SubtitleVariant = 'regular' | 'forced' | 'both';

export type SubtitleAccessibility = 'any' | 'prefer-hi' | 'require-hi' | 'exclude-hi';

/**
 * How strictly the audio preference is enforced during acquisition.
 * 'prefer' ranks matching releases higher but never blocks a grab (soft);
 * 'require' additionally rejects releases whose evidence affirmatively
 * contradicts the preference - absence of evidence never rejects.
 */
export type AudioAcquisitionMode = 'prefer' | 'require';

export interface AudioPreference {
	/** Prefer the media's original audio track when choosing releases/sources */
	preferOriginal: boolean;
	/** Ordered fallback audio languages; empty means no preference */
	languages: LanguageTag[];
	/** Enforcement mode for acquisition (default 'prefer') */
	mode: AudioAcquisitionMode;
}

export interface SubtitleRequirement {
	tag: LanguageTag;
	variant: SubtitleVariant;
	accessibility: SubtitleAccessibility;
}

export interface LanguageProfileV2 {
	id: string;
	name: string;
	audio: AudioPreference;
	subtitles: SubtitleRequirement[];
	/** Stop acquiring after the requirement at this rank is satisfied */
	cutoffRank: number | null;
	/** Normalized 0-100 threshold shared by movies and episodes */
	minimumScore: number;
	upgradesAllowed: boolean;
}

/**
 * Where an effective profile was resolved from, in resolution order:
 * per-item override ('movie'/'series') > owning library default > instance
 * default (language_settings.default_profile_id).
 */
export type EffectiveLanguageProfileSource = 'movie' | 'series' | 'library' | 'default';

/** The profile that governs an item plus the level it was resolved from. */
export interface EffectiveLanguageProfile {
	profile: LanguageProfileV2;
	source: EffectiveLanguageProfileSource;
}

/**
 * The subtitle requirements actually in force for an item, plus where they
 * came from and the policy profile that still governs audio/score/upgrades.
 *
 * Resolution: item override ('movie'/'series'/'episode') replaces ONLY the
 * requirement list - cutoff never applies to an override - otherwise the
 * profile chain's subtitles with cutoff semantics.
 */
export interface EffectiveSubtitleRequirements {
	requirements: SubtitleRequirement[];
	source: EffectiveLanguageProfileSource | 'episode';
	/** Policy in force (audio preference, minimumScore, upgradesAllowed). */
	profile: LanguageProfileV2 | null;
	/** False when the requirements came from a per-item override. */
	cutoffApplies: boolean;
}

/** Per-episode cutoff-aware requirement progress for a series page. */
export interface EpisodeSubtitleCounts {
	satisfiedCount: number;
	totalRequirements: number;
	/** True when the cutoff-rank requirement itself is satisfied. */
	satisfiedViaCutoff: boolean;
}

export const DEFAULT_MINIMUM_SCORE = 70;

/** Stable identity for a subtitle requirement, used for dedupe and state keys. */
export function requirementKey(requirement: SubtitleRequirement): string {
	return `${requirement.tag}|${requirement.variant}|${requirement.accessibility}`;
}
