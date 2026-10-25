/**
 * Language Settings Service
 *
 * Manages the global language configuration singleton stored in the
 * language_settings table (id = 'singleton'). This is the single authority for:
 * - defaultProfileId: the default language profile (profiles have no is_default flag)
 * - metadataLocale / region: TMDB request localization
 * - discoverOriginalFilter: canonical base-tag filter for Discover queries
 * - unknownSubtitlePolicy / assumedLanguage: handling of undetermined subtitle tags
 * - autoSyncSubtitles: whether subtitle search runs automatically
 *
 * Reads go straight to the database on every call (no cache) so all consumers
 * observe updates immediately. Updates are validated through
 * languageSettingsUpdateSchema (#lib/server/validation/schemas) and canonicalized
 * before storage.
 */

import { db } from '#lib/server/db/index.js';
import { languageProfiles, languageSettings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import {
	languageSettingsUpdateSchema,
	type LanguageSettingsUpdateInput
} from '#lib/server/validation/schemas.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });

/** Row id of the singleton language settings row. */
export const LANGUAGE_SETTINGS_SINGLETON_ID = 'singleton';

/** Global language configuration (camelCase view of the language_settings row). */
export interface LanguageSettingsData {
	/** Default language profile applied when no library/media override exists */
	defaultProfileId: string | null;
	/** TMDB metadata request locale (e.g. 'en-US') */
	metadataLocale: string;
	/** ISO 3166-1 region for TMDB discover/release filtering (e.g. 'US') */
	region: string;
	/** Canonical base tag filter for Discover original_language; null = no filter */
	discoverOriginalFilter: string | null;
	/** How undetermined subtitle tags are treated: 'und' | 'assume-language' */
	unknownSubtitlePolicy: 'und' | 'assume-language';
	/** Language assumed for unknown subtitle tags when policy is 'assume-language' */
	assumedLanguage: string | null;
	/** Whether subtitle search runs automatically for new/updated files */
	autoSyncSubtitles: boolean;
	/**
	 * Instance default for display: show originalTitle instead of the
	 * localized title when a movie/series has no explicit per-item preference
	 */
	preferOriginalTitle: boolean;
}

/** Defaults mirroring the language_settings column defaults. */
export const DEFAULT_LANGUAGE_SETTINGS: LanguageSettingsData = {
	defaultProfileId: null,
	metadataLocale: 'en-US',
	region: 'US',
	discoverOriginalFilter: null,
	unknownSubtitlePolicy: 'und',
	assumedLanguage: null,
	autoSyncSubtitles: true,
	preferOriginalTitle: false
};

const REGION_PATTERN = /^[A-Za-z]{2}$/;

/**
 * Service for managing the global language settings singleton
 */
export class LanguageSettingsService {
	private static instance: LanguageSettingsService | null = null;

	private constructor() {}

	static getInstance(): LanguageSettingsService {
		if (!LanguageSettingsService.instance) {
			LanguageSettingsService.instance = new LanguageSettingsService();
		}
		return LanguageSettingsService.instance;
	}

	/**
	 * Get the current settings, materializing the singleton row (with column
	 * defaults) on first access.
	 */
	async get(): Promise<LanguageSettingsData> {
		const rows = await db
			.select()
			.from(languageSettings)
			.where(eq(languageSettings.id, LANGUAGE_SETTINGS_SINGLETON_ID))
			.limit(1);

		if (rows[0]) {
			return this.rowToSettings(rows[0]);
		}

		await db
			.insert(languageSettings)
			.values({ id: LANGUAGE_SETTINGS_SINGLETON_ID })
			.onConflictDoNothing();
		return { ...DEFAULT_LANGUAGE_SETTINGS };
	}

	/**
	 * Validate and apply a partial settings patch. Values are canonicalized
	 * (locale/region casing, discover filter reduced to its base tag) before
	 * storage; invalid input throws. Returns the full settings after the write.
	 */
	async update(patch: LanguageSettingsUpdateInput): Promise<LanguageSettingsData> {
		const parsed = languageSettingsUpdateSchema.parse(patch ?? {});

		// A non-null default must reference a real profile; sqlite connections do
		// not enforce FKs, so a random UUID would otherwise persist silently and
		// resolution would fall through to "no default" with no warning.
		if (parsed.defaultProfileId) {
			const profileExists = await db
				.select({ id: languageProfiles.id })
				.from(languageProfiles)
				.where(eq(languageProfiles.id, parsed.defaultProfileId))
				.limit(1);
			if (profileExists.length === 0) {
				throw new Error(`Language profile not found: ${parsed.defaultProfileId}`);
			}
		}

		// Make sure the singleton row exists before updating it.
		await this.get();

		const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
		for (const [key, value] of Object.entries(parsed)) {
			if (value !== undefined) {
				updates[key] = value;
			}
		}

		if (Object.keys(updates).length > 1) {
			await db
				.update(languageSettings)
				.set(updates)
				.where(eq(languageSettings.id, LANGUAGE_SETTINGS_SINGLETON_ID));
		}

		logger.debug({ keys: Object.keys(parsed) }, 'Language settings updated');
		return this.get();
	}

	/**
	 * Get the default language profile id (null when no default is configured).
	 */
	async getDefaultProfileId(): Promise<string | null> {
		return (await this.get()).defaultProfileId;
	}

	/**
	 * Map a database row to the settings object, defensively coercing values
	 * that may predate validation.
	 */
	private rowToSettings(row: typeof languageSettings.$inferSelect): LanguageSettingsData {
		let metadataLocale = DEFAULT_LANGUAGE_SETTINGS.metadataLocale;
		if (row.metadataLocale) {
			try {
				metadataLocale = Intl.getCanonicalLocales(row.metadataLocale)[0] ?? metadataLocale;
			} catch {
				logger.warn({ metadataLocale: row.metadataLocale }, 'Invalid stored metadata locale');
			}
		}

		const region =
			row.region && REGION_PATTERN.test(row.region)
				? row.region.toUpperCase()
				: DEFAULT_LANGUAGE_SETTINGS.region;

		return {
			defaultProfileId: row.defaultProfileId ?? null,
			metadataLocale,
			region,
			discoverOriginalFilter: row.discoverOriginalFilter ?? null,
			unknownSubtitlePolicy:
				row.unknownSubtitlePolicy === 'assume-language' ? 'assume-language' : 'und',
			assumedLanguage: row.assumedLanguage ?? null,
			autoSyncSubtitles: row.autoSyncSubtitles ?? true,
			preferOriginalTitle: row.preferOriginalTitle === true
		};
	}
}

/**
 * Get the singleton LanguageSettingsService
 */
export function getLanguageSettingsService(): LanguageSettingsService {
	return LanguageSettingsService.getInstance();
}
