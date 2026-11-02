import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';
import type { MetadataProviderConfig } from './providers/types.js';

const PROVIDER_SETTINGS_KEY = 'metadata_providers';

const DEFAULT_PROVIDER_CONFIG: MetadataProviderConfig = {
	animeEnrichmentEnabled: true
};

export async function getMetadataProviderConfig(): Promise<MetadataProviderConfig> {
	const row = await db.query.settings.findFirst({
		where: eq(settings.key, PROVIDER_SETTINGS_KEY)
	});

	if (!row) return DEFAULT_PROVIDER_CONFIG;

	try {
		const parsed = JSON.parse(row.value) as Partial<MetadataProviderConfig> & {
			// Legacy fields - ignored but not rejected so old DB rows parse cleanly
			anilistEnabled?: boolean;
			malClientId?: string;
			animeProviderPriority?: unknown;
		};
		return {
			animeEnrichmentEnabled:
				typeof parsed.animeEnrichmentEnabled === 'boolean'
					? parsed.animeEnrichmentEnabled
					: // Migrate: if either legacy provider was enabled, treat enrichment as enabled
						Boolean(parsed.anilistEnabled) || Boolean(parsed.malClientId)
						? true
						: DEFAULT_PROVIDER_CONFIG.animeEnrichmentEnabled
		};
	} catch {
		return DEFAULT_PROVIDER_CONFIG;
	}
}

export async function setMetadataProviderConfig(
	config: Partial<MetadataProviderConfig>
): Promise<MetadataProviderConfig> {
	const current = await getMetadataProviderConfig();
	const next: MetadataProviderConfig = {
		animeEnrichmentEnabled:
			typeof config.animeEnrichmentEnabled === 'boolean'
				? config.animeEnrichmentEnabled
				: current.animeEnrichmentEnabled
	};

	await db
		.insert(settings)
		.values({ key: PROVIDER_SETTINGS_KEY, value: JSON.stringify(next) })
		.onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(next) } });

	return next;
}

export function getDefaultMetadataProviderConfig(): MetadataProviderConfig {
	return DEFAULT_PROVIDER_CONFIG;
}
