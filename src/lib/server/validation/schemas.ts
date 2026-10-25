/**
 * Server-only API validation schemas.
 *
 * These schemas validate request bodies against server-side registries: the
 * subtitle provider implementation list (`#lib/server/subtitles/types.js`) and
 * the ISO 639 language normalizer (`#lib/server/languages/normalize.js`). They
 * must never be imported as values from client-safe modules — that would ship
 * the generated ISO table to the browser. Client code consumes their inferred
 * types via `import type`, which is erased at compile time.
 */

import { z } from 'zod';
import { PROVIDER_IMPLEMENTATIONS } from '#lib/server/subtitles/types.js';
import { normalizeTmdbLanguage } from '#lib/server/languages/normalize.js';

// ============================================================
// Subtitle Provider Schemas
// ============================================================

/**
 * Valid subtitle provider implementations.
 * Uses the single source of truth from types.ts
 */
export const subtitleProviderImplementationSchema = z.enum(PROVIDER_IMPLEMENTATIONS);

/**
 * Schema for creating a subtitle provider.
 */
export const subtitleProviderCreateSchema = z.object({
	name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
	implementation: subtitleProviderImplementationSchema,
	enabled: z.boolean().default(true),
	priority: z.number().int().min(1).max(100).default(25),
	apiKey: z.string().optional().nullable(),
	username: z.string().optional().nullable(),
	password: z.string().optional().nullable(),
	settings: z.record(z.string(), z.unknown()).optional().nullable(),
	requestsPerMinute: z.number().int().min(1).max(1000).default(60)
});

/**
 * Schema for updating a subtitle provider.
 */
export const subtitleProviderUpdateSchema = subtitleProviderCreateSchema.required().partial();

/**
 * Schema for testing a subtitle provider.
 */
export const subtitleProviderTestSchema = z.object({
	implementation: subtitleProviderImplementationSchema,
	apiKey: z.string().optional().nullable(),
	username: z.string().optional().nullable(),
	password: z.string().optional().nullable(),
	settings: z.record(z.string(), z.unknown()).optional().nullable()
});

// Subtitle Provider Type Exports
export type SubtitleProviderImplementation = z.infer<typeof subtitleProviderImplementationSchema>;
export type SubtitleProviderCreate = z.infer<typeof subtitleProviderCreateSchema>;
export type SubtitleProviderUpdate = z.infer<typeof subtitleProviderUpdateSchema>;
export type SubtitleProviderTest = z.infer<typeof subtitleProviderTestSchema>;

// ============================================================
// Language Settings Schemas
// ============================================================

/** Canonical BCP-47 metadata locale (canonicalized via Intl). */
const languageMetadataLocaleSchema = z
	.string()
	.refine(
		(value) => {
			try {
				Intl.getCanonicalLocales(value);
				return true;
			} catch {
				return false;
			}
		},
		{ message: 'Invalid metadata locale' }
	)
	.transform((value) => Intl.getCanonicalLocales(value)[0] ?? value);

/** Two-letter country code, upper-cased. */
const languageRegionSchema = z
	.string()
	.regex(/^[A-Za-z]{2}$/, 'Region must be a two-letter country code')
	.transform((value) => value.toUpperCase());

/** Canonical base language tag or null (canonicalized via the TMDB normalizer). */
const languageDiscoverOriginalFilterSchema = z
	.string()
	.nullable()
	.refine((value) => value === null || normalizeTmdbLanguage(value) !== null, {
		message: 'Must be a resolvable language tag or null'
	})
	.transform((value) => (value === null ? null : normalizeTmdbLanguage(value)));

/**
 * Language settings singleton (camelCase view of the language_settings row).
 * defaultProfileId is the single default-profile authority; metadataLocale
 * must be a valid BCP-47 locale (canonicalized via Intl); region is a
 * two-letter country code (upper-cased); discoverOriginalFilter is null or a
 * canonical base language tag (canonicalized via the server normalizer).
 */
export const languageSettingsSchema = z.object({
	defaultProfileId: z.string().uuid().nullable().default(null),
	metadataLocale: languageMetadataLocaleSchema,
	region: languageRegionSchema,
	discoverOriginalFilter: languageDiscoverOriginalFilterSchema,
	unknownSubtitlePolicy: z.enum(['und', 'assume-language']).default('und'),
	assumedLanguage: z.string().min(1).nullable().optional(),
	autoSyncSubtitles: z.boolean().default(true),
	/** Instance default: display originalTitle when a per-item flag is unset */
	preferOriginalTitle: z.boolean().default(false)
});

/**
 * Partial update payload for the language settings singleton.
 *
 * NOTE: this is NOT `languageSettingsSchema.partial()`. In zod v4 `.partial()`
 * still applies field defaults for absent keys, which would silently reset
 * every omitted field (e.g. defaultProfileId) to its default on each partial
 * write. Every field here is genuinely optional so the service only persists
 * the keys the caller actually sent.
 */
export const languageSettingsUpdateSchema = z.object({
	defaultProfileId: z.string().uuid().nullable().optional(),
	metadataLocale: languageMetadataLocaleSchema.optional(),
	region: languageRegionSchema.optional(),
	discoverOriginalFilter: languageDiscoverOriginalFilterSchema.optional(),
	unknownSubtitlePolicy: z.enum(['und', 'assume-language']).optional(),
	assumedLanguage: z.string().min(1).nullable().optional(),
	autoSyncSubtitles: z.boolean().optional(),
	preferOriginalTitle: z.boolean().optional()
});

export type LanguageSettingsValues = z.infer<typeof languageSettingsSchema>;
export type LanguageSettingsUpdateInput = z.input<typeof languageSettingsUpdateSchema>;

// ============================================================================
// LiveTV Account Schema (multi-provider)
// ============================================================================

/**
 * Stalker portal UI language (`stb_lang` cookie / `Accept-Language` header).
 *
 * Accepts any recognizable language tag ('en', 'pt-BR', 'ger', …), reduces it
 * to the 2-letter base code Stalker portals expect, and falls back to English.
 */
export const stalkerLanguageSchema = z
	.string()
	.refine((value) => normalizeTmdbLanguage(value) !== null, {
		message: 'Must be a valid language code'
	})
	.transform((value) => normalizeTmdbLanguage(value) ?? 'en');

export const liveTvAccountCreateSchema = z.object({
	name: z.string().min(1).max(100),
	providerType: z.enum(['stalker', 'xstream', 'm3u', 'cinephage-iptv']),
	enabled: z.boolean().optional(),
	stalkerConfig: z
		.object({
			portalUrl: z.string().url(),
			macAddress: z.string().min(1),
			serialNumber: z.string().optional(),
			deviceId: z.string().optional(),
			deviceId2: z.string().optional(),
			model: z.string().optional(),
			timezone: z.string().optional(),
			language: stalkerLanguageSchema.default('en'),
			username: z.string().optional(),
			password: z.string().optional()
		})
		.optional(),
	xstreamConfig: z
		.object({
			baseUrl: z.string().url(),
			username: z.string().min(1),
			password: z.string().min(1),
			epgUrl: z.string().url().optional()
		})
		.optional(),
	m3uConfig: z
		.object({
			url: z.string().url().optional(),
			fileContent: z.string().optional(),
			epgUrl: z.string().url().optional(),
			refreshIntervalHours: z.number().min(1).max(168).optional(),
			autoRefresh: z.boolean().optional()
		})
		.optional(),
	cinephageIptvConfig: z
		.object({
			countries: z.array(z.string()).optional(),
			categories: z.array(z.string()).optional(),
			languages: z.array(z.string()).optional()
		})
		.optional(),
	testFirst: z.boolean().optional().default(true)
});

// LiveTV Account Type Export
export type LiveTvAccountCreate = z.infer<typeof liveTvAccountCreateSchema>;
