/**
 * Radarr/Sonarr-compatible `languageprofile` response (Sonarr-only - Radarr's
 * v3 API has no language profile concept).
 *
 * Field set confirmed against LanguageProfileResource in Sonarr's actual
 * openapi.json. Backed by Cinephage's real `language_profiles` table (the
 * same one behind Settings > Library Languages) in its v2 shape: each row's
 * ordered `subtitles` requirement list (`{ tag, variant, accessibility }`)
 * plus `cutoffRank` maps onto `LanguageProfileItemResource[]` + `cutoff`,
 * and the profile's audio fallback languages are appended (deduplicated) so
 * arr clients can reference every language the profile actually configures.
 *
 * Semantic note: Cinephage's language profiles configure *subtitle*
 * language requirements and audio preferences, not an audio/dub language
 * like Sonarr's own feature - conceptually different, but the response
 * shape (a named, ordered list of languages with a cutoff and an upgrade
 * toggle) maps cleanly enough onto LanguageProfileResource that reporting
 * the real profiles here is far more honest than an empty skeleton or a
 * fabricated single "Default" entry.
 */

import { db } from '#lib/server/db/index.js';
import { languageProfiles } from '#lib/server/db/schema.js';
import { getLanguageName } from '#lib/shared/languages.js';
import type { LanguageProfileV2 } from '#lib/shared/language-profile.js';
import { getOrAssignArrId, getOrAssignArrIds } from './ArrIdMappingService.js';

interface LanguageResource {
	id: number;
	name: string;
}

export interface LanguageProfileResource {
	id: number;
	name: string;
	upgradeAllowed: boolean;
	cutoff: LanguageResource;
	languages: Array<{ id: number; language: LanguageResource; allowed: boolean }>;
}

/** Ordered, deduplicated language tags a v2 profile configures (subtitle requirements first, then audio fallbacks). */
function profileLanguageCodes(row: Pick<LanguageProfileV2, 'audio' | 'subtitles'>): string[] {
	const codes: string[] = [];
	for (const tag of [...row.subtitles.map((req) => req.tag), ...(row.audio?.languages ?? [])]) {
		if (tag && !codes.includes(tag)) codes.push(tag);
	}
	return codes;
}

export async function buildLanguageProfiles(): Promise<LanguageProfileResource[]> {
	const rows = await db.select().from(languageProfiles);

	// Every profile's language codes, deduplicated, so surrogate IDs are
	// assigned in one batched round trip rather than per-row.
	const allCodes = [...new Set(rows.flatMap(profileLanguageCodes))];
	const codeArrIds = await getOrAssignArrIds('language', allCodes);

	const toLanguageResource = (code: string): LanguageResource => ({
		id: codeArrIds.get(code) ?? 0,
		name: getLanguageName(code)
	});

	return Promise.all(
		rows.map(async (row) => {
			const codes = profileLanguageCodes(row);
			// v2 cutoffRank is a 0-based rank into the subtitle requirements.
			const cutoffTag =
				row.cutoffRank !== null && row.subtitles[row.cutoffRank]
					? row.subtitles[row.cutoffRank].tag
					: (codes[0] ?? null);
			return {
				id: await getOrAssignArrId('languageProfile', row.id),
				name: row.name,
				// Real field is non-nullable; Cinephage's column defaults true.
				upgradeAllowed: row.upgradesAllowed ?? true,
				cutoff: cutoffTag ? toLanguageResource(cutoffTag) : { id: 0, name: 'Unknown' },
				languages: codes.map((code) => ({
					id: codeArrIds.get(code) ?? 0,
					language: toLanguageResource(code),
					allowed: true
				}))
			};
		})
	);
}
