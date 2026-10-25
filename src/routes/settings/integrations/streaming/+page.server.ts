import type { PageServerLoad } from './$types';
import { getExtractionCacheManager } from '#lib/server/streaming/nzb/extraction/ExtractionCacheManager.js';

export const load: PageServerLoad = async () => {
	const cacheManager = getExtractionCacheManager();
	const stats = await cacheManager.getStats();

	return {
		cacheStats: {
			fileCount: stats.fileCount,
			totalSizeMB: Math.round(stats.totalSizeBytes / 1024 / 1024),
			expiredCount: stats.expiredCount
		},
		settings: {
			retentionHours: 48, // Default, could be stored in database
			maxCacheSizeGB: 0
		}
	};
};
