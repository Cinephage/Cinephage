/**
 * Live TV Providers Index
 *
 * Exports all provider implementations and the provider manager.
 */

export type { LiveTvProvider } from './LiveTvProvider';
export type {
	AuthResult,
	StreamResolutionResult,
	ProviderCapabilities
} from '#lib/types/livetv.js';
export { StalkerProvider, getStalkerProvider } from './StalkerProvider';
export { XstreamProvider, getXstreamProvider } from './XstreamProvider';
export { M3uProvider, getM3uProvider } from './M3uProvider';
export { CinephageIptvProvider, getCinephageIptvProvider } from './CinephageIptvProvider';

import type { LiveTvProvider } from './LiveTvProvider';
import { getStalkerProvider } from './StalkerProvider';
import { getXstreamProvider } from './XstreamProvider';
import { getM3uProvider } from './M3uProvider';
import { getCinephageIptvProvider } from './CinephageIptvProvider';
import type { LiveTvProviderType, LiveTvAccount } from '#lib/types/livetv.js';

/**
 * Get the appropriate provider for a given type
 */
export function getProvider(type: LiveTvProviderType): LiveTvProvider {
	switch (type) {
		case 'stalker':
			return getStalkerProvider();
		case 'xstream':
			return getXstreamProvider();
		case 'm3u':
			return getM3uProvider();
		case 'cinephage-iptv':
			return getCinephageIptvProvider();
		default:
			throw new Error(`Unknown provider type: ${type}`);
	}
}

/**
 * Get the appropriate provider for an account
 */
export function getProviderForAccount(account: LiveTvAccount): LiveTvProvider {
	return getProvider(account.providerType);
}

/**
 * Get all available providers
 */
export function getAllProviders(): LiveTvProvider[] {
	return [getStalkerProvider(), getXstreamProvider(), getM3uProvider(), getCinephageIptvProvider()];
}
