/**
 * SABnzbd Download Client module exports.
 */

export { SABnzbdClient, type SABnzbdConfig } from './SABnzbdClient';
export { SABnzbdProxy, SabnzbdApiError } from './SABnzbdProxy';
// Re-export availability checker from shared location for backwards compatibility
export {
	checkNzbAvailability,
	type AvailabilityResult,
	type AvailabilityCheckOptions
} from '#lib/server/downloads/nzb/index.js';
export * from './types';
