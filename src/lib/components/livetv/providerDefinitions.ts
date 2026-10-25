import type { LiveTvProviderType } from '#lib/types/livetv.js';

/**
 * Live TV Provider Definition
 * Metadata for each supported provider type
 */
export interface LiveTvProviderDefinition {
	/** Provider type identifier */
	id: LiveTvProviderType;

	/** Display name */
	name: string;

	/** Description of the provider type */
	description: string;

	/** Icon name (from @lucide/svelte) */
	icon: 'Tv' | 'Radio' | 'List' | 'Globe';

	/** Whether authentication is required */
	requiresAuth: boolean;

	/** Authentication method description */
	authDescription: string;

	/** Features supported by this provider */
	features: {
		supportsEpg: boolean;
		supportsArchive: boolean;
		supportsCategories: boolean;
		supportsAutoRefresh: boolean;
	};
}

/**
 * Available Live TV provider definitions
 */
export const providerDefinitions: LiveTvProviderDefinition[] = [
	{
		id: 'stalker',
		name: 'Stalker Portal',
		description: 'MAG/Ministra portals using MAC address authentication',
		icon: 'Tv',
		requiresAuth: true,
		authDescription: 'MAC Address',
		features: {
			supportsEpg: true,
			supportsArchive: true,
			supportsCategories: true,
			supportsAutoRefresh: false
		}
	},
	{
		id: 'xstream',
		name: 'XStream Codes',
		description: 'Username/password IPTV API (Xtream Codes compatible)',
		icon: 'Radio',
		requiresAuth: true,
		authDescription: 'Username & Password',
		features: {
			supportsEpg: true,
			supportsArchive: true,
			supportsCategories: true,
			supportsAutoRefresh: false
		}
	},
	{
		id: 'm3u',
		name: 'M3U Playlist',
		description: 'Playlist file via URL or file upload',
		icon: 'List',
		requiresAuth: false,
		authDescription: 'None (URL or File)',
		features: {
			supportsEpg: true,
			supportsArchive: false,
			supportsCategories: true,
			supportsAutoRefresh: true
		}
	},
	{
		id: 'cinephage-iptv',
		name: 'Cinephage IPTV',
		description: 'Free IPTV channels from the Cinephage network',
		icon: 'Globe',
		requiresAuth: false,
		authDescription: 'Automatic (Cinephage account)',
		features: {
			supportsEpg: true,
			supportsArchive: false,
			supportsCategories: true,
			supportsAutoRefresh: false
		}
	}
];

/**
 * Get provider definition by ID
 */
export function getProviderDefinition(
	id: LiveTvProviderType
): LiveTvProviderDefinition | undefined {
	return providerDefinitions.find((d) => d.id === id);
}

/**
 * Get default provider (first in list)
 */
export function getDefaultProvider(): LiveTvProviderDefinition {
	return providerDefinitions[0];
}
