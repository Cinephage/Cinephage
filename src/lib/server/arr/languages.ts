/**
 * Radarr/Sonarr-compatible `language` response.
 *
 * Backed by the same real `language_profiles` table as languageProfiles.ts:
 * the union of every language code configured across all profiles, so the
 * catalog reflects what's actually configured in Settings > Language
 * Profiles rather than a fabricated placeholder. Falls back to a single
 * English entry when no profiles are configured yet, since real arr apps
 * always expect a non-empty catalog here (used to populate language
 * dropdowns) - an empty array would leave nothing selectable.
 */

import { db } from '#lib/server/db/index.js';
import { languageProfiles } from '#lib/server/db/schema.js';
import { getLanguageName } from '#lib/shared/languages.js';
import { getOrAssignArrIds } from './ArrIdMappingService.js';

export interface LanguageResource {
	id: number;
	name: string;
	nameLower: string;
}

export async function buildLanguages(): Promise<LanguageResource[]> {
	const rows = await db.select().from(languageProfiles);
	const codes = [
		...new Set(
			rows.flatMap((row) => [
				...row.subtitles.map((req) => req.tag),
				...(row.audio?.languages ?? [])
			])
		)
	];

	if (codes.length === 0) {
		return [{ id: 1, name: 'English', nameLower: 'english' }];
	}

	const codeArrIds = await getOrAssignArrIds('language', codes);
	return codes.map((code) => {
		const name = getLanguageName(code);
		return { id: codeArrIds.get(code) ?? 0, name, nameLower: name.toLowerCase() };
	});
}
