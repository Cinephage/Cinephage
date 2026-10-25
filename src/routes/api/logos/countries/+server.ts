import type { RequestHandler } from './$types';
import { createChildLogger } from '#lib/logging/index.js';
import { getLogoDownloadService } from '#lib/server/logos/LogoDownloadService.js';
import { listLogoCountries } from '#lib/server/logos/logo-library.js';

const logger = createChildLogger({ module: 'LogosCountriesApi', logDomain: 'system' });

/**
 * GET /api/logos/countries
 * List all available countries with logo counts
 */
export const GET: RequestHandler = async () => {
	try {
		// Check if logos are downloaded
		const service = getLogoDownloadService();
		const isDownloaded = await service.isDownloaded();

		if (!isDownloaded) {
			return Response.json({
				success: false,
				error: 'Logos not downloaded',
				code: 'NOT_DOWNLOADED',
				data: []
			});
		}

		const validCountries = await listLogoCountries();

		return Response.json({
			success: true,
			data: validCountries
		});
	} catch (error) {
		logger.error('[LogosAPI] Failed to list countries', error);
		return Response.json(
			{
				success: false,
				error: 'Failed to load countries'
			},
			{ status: 500 }
		);
	}
};
