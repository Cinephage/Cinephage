import type { LayoutServerLoad } from './$types';
import { getManagedApiKeysForRequest } from '#lib/server/auth/index.js';
import { error } from '@sveltejs/kit';
import { createChildLogger } from '#lib/logging/index.js';

import { getSystemSettingsService } from '#lib/server/settings/SystemSettingsService.js';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { getMetadataProviderConfig } from '#lib/server/metadata/provider-settings.js';
import { isArrCompatEnabled } from '#lib/server/arr/arrCompatSettings.js';

const logger = createChildLogger({ module: 'SystemSettingsLayout', logDomain: 'system' });

export const load: LayoutServerLoad = async ({ request, locals }) => {
	// Require authentication
	if (!locals.user) {
		throw error(401, 'Unauthorized');
	}

	try {
		const { mainApiKey, streamingApiKey } = await getManagedApiKeysForRequest(request.headers);

		// Get external URL setting
		const settingsService = getSystemSettingsService();
		const externalUrl = await settingsService.getExternalUrl();

		// Get TMDB status
		const apiKeySetting = await db.query.settings.findFirst({
			where: eq(settings.key, 'tmdb_api_key')
		});

		const metadataConfig = await getMetadataProviderConfig();

		return {
			mainApiKey,
			streamingApiKey,
			externalUrl,
			arrCompatEnabled: isArrCompatEnabled(),
			tmdb: {
				hasApiKey: !!apiKeySetting,
				configured: !!apiKeySetting
			},
			metadataProviders: {
				animeEnrichmentEnabled: metadataConfig.animeEnrichmentEnabled
			}
		};
	} catch (err) {
		logger.error({ err, component: 'SystemSettingsPage' }, 'Error loading system settings');
		return {
			mainApiKey: null,
			streamingApiKey: null,
			externalUrl: null,
			arrCompatEnabled: false,
			tmdb: { hasApiKey: false, configured: false },
			metadataProviders: {
				animeEnrichmentEnabled: true
			},
			error: 'Failed to load system settings'
		};
	}
};
