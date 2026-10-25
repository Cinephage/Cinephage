import { tmdb } from '#lib/server/tmdb.js';
import { createChildLogger } from '#lib/logging/index.js';
import { getLanguageSettingsService } from '#lib/server/subtitles/services/LanguageSettingsService.js';
import { LanguageProfileService } from '#lib/server/subtitles/services/LanguageProfileService.js';
import type { PageServerLoad } from './$types';

const logger = createChildLogger({ module: 'LanguagesSettingsPage', logDomain: 'system' });

/**
 * Library > Languages tab. Loads the language-settings singleton, the
 * language profiles, and the TMDB country catalogue for the region select.
 * Language dropdowns use the client-safe shared registry
 * (#lib/shared/languages) directly, so no TMDB language fetch is needed.
 */
export const load: PageServerLoad = async () => {
	const [settings, profiles] = await Promise.all([
		getLanguageSettingsService().get(),
		LanguageProfileService.getInstance().getProfiles()
	]);

	let countries: { code: string; name: string }[] = [];

	if (await tmdb.isConfigured()) {
		try {
			const countriesData = await tmdb.getCountries();
			if (countriesData) {
				countries = countriesData
					.map((c) => ({ code: c.iso_3166_1, name: c.english_name }))
					.sort((a, b) => a.name.localeCompare(b.name));
			}
		} catch (e) {
			logger.error({ err: e }, 'Failed to fetch TMDB countries');
		}
	}

	return { settings, profiles, countries };
};
