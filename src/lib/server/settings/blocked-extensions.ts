import { db } from '#lib/server/db/index.js';
import { settings, movies, series, rootFolders } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import {
	globalBlockedVideoExtensionsSchema,
	type GlobalBlockedVideoExtensions
} from '#lib/validation/schemas.js';

const logger = createChildLogger({ module: 'BlockedVideoExtensions' });
const SETTINGS_KEY = 'global_blocked_video_extensions';

let cached: GlobalBlockedVideoExtensions | null = null;

export async function getBlockedVideoExtensions(): Promise<GlobalBlockedVideoExtensions> {
	if (cached) return cached;

	const row = await db.query.settings.findFirst({ where: eq(settings.key, SETTINGS_KEY) });

	if (row?.value) {
		try {
			const parsed = globalBlockedVideoExtensionsSchema.parse(JSON.parse(row.value));
			cached = parsed;
			return parsed;
		} catch {
			logger.warn('Failed to parse global blocked video extensions, using defaults');
		}
	}

	const defaults = globalBlockedVideoExtensionsSchema.parse({});
	cached = defaults;
	return defaults;
}

export async function setBlockedVideoExtensions(
	data: GlobalBlockedVideoExtensions
): Promise<GlobalBlockedVideoExtensions> {
	await db
		.insert(settings)
		.values({ key: SETTINGS_KEY, value: JSON.stringify(data) })
		.onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(data) } });

	cached = data;
	return data;
}

export function invalidateBlockedVideoExtensionsCache(): void {
	cached = null;
}

export async function resolveBlockedExtensionsForQueueItem(options: {
	movieId?: string | null;
	seriesId?: string | null;
}): Promise<string[]> {
	let rootFolderId: string | null = null;

	if (options.movieId) {
		const [movie] = await db
			.select({ rootFolderId: movies.rootFolderId })
			.from(movies)
			.where(eq(movies.id, options.movieId))
			.limit(1);
		rootFolderId = movie?.rootFolderId ?? null;
	} else if (options.seriesId) {
		const [seriesData] = await db
			.select({ rootFolderId: series.rootFolderId })
			.from(series)
			.where(eq(series.id, options.seriesId))
			.limit(1);
		rootFolderId = seriesData?.rootFolderId ?? null;
	}

	if (rootFolderId) {
		const [folder] = await db
			.select({ blockedVideoExtensions: rootFolders.blockedVideoExtensions })
			.from(rootFolders)
			.where(eq(rootFolders.id, rootFolderId))
			.limit(1);

		if (folder?.blockedVideoExtensions) {
			try {
				const parsed = JSON.parse(folder.blockedVideoExtensions) as string[];
				if (parsed.length > 0) return parsed;
			} catch {
				logger.warn('Failed to parse root folder blocked video extensions');
			}
		}
	}

	const global = await getBlockedVideoExtensions();
	return global.extensions;
}
