/**
 * Settings for sidecar files (NFO + poster/fanart artwork)
 * written alongside imported media. Global setting defaults to off/skip-existing.
 */

import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';

const KEYS = {
	enabled: 'sidecar_enabled',
	overwriteExisting: 'sidecar_overwrite_existing',
	includeArtwork: 'sidecar_include_artwork',
	tvSeriesLevel: 'sidecar_tv_series_level',
	tvSeasonLevel: 'sidecar_tv_season_level',
	tvEpisodeLevel: 'sidecar_tv_episode_level'
} as const;

function getBool(key: string, defaultValue: boolean): boolean {
	const row = db.select().from(settings).where(eq(settings.key, key)).get();
	if (!row) return defaultValue;
	return row.value === 'true';
}

function setBool(key: string, value: boolean): void {
	const stored = value ? 'true' : 'false';
	db.insert(settings)
		.values({ key, value: stored })
		.onConflictDoUpdate({ target: settings.key, set: { value: stored } })
		.run();
}

export interface SidecarSettings {
	enabled: boolean;
	overwriteExisting: boolean;
	includeArtwork: boolean;
	tvSeriesLevel: boolean;
	tvSeasonLevel: boolean;
	tvEpisodeLevel: boolean;
}

export function getSidecarSettings(): SidecarSettings {
	return {
		enabled: getBool(KEYS.enabled, false),
		overwriteExisting: getBool(KEYS.overwriteExisting, false),
		includeArtwork: getBool(KEYS.includeArtwork, true),
		tvSeriesLevel: getBool(KEYS.tvSeriesLevel, true),
		tvSeasonLevel: getBool(KEYS.tvSeasonLevel, true),
		tvEpisodeLevel: getBool(KEYS.tvEpisodeLevel, true)
	};
}

export function setSidecarSettings(update: Partial<SidecarSettings>): void {
	if (update.enabled !== undefined) setBool(KEYS.enabled, update.enabled);
	if (update.overwriteExisting !== undefined)
		setBool(KEYS.overwriteExisting, update.overwriteExisting);
	if (update.includeArtwork !== undefined) setBool(KEYS.includeArtwork, update.includeArtwork);
	if (update.tvSeriesLevel !== undefined) setBool(KEYS.tvSeriesLevel, update.tvSeriesLevel);
	if (update.tvSeasonLevel !== undefined) setBool(KEYS.tvSeasonLevel, update.tvSeasonLevel);
	if (update.tvEpisodeLevel !== undefined) setBool(KEYS.tvEpisodeLevel, update.tvEpisodeLevel);
}

export function isSidecarEnabled(): boolean {
	return getBool(KEYS.enabled, false);
}
