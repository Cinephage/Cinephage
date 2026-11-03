/**
 * CinephageAPI subsystem - first-class integration with api.cinephage.net.
 *
 * Public API surface. Consumers should import from this barrel rather than
 * reaching into subpaths directly.
 *
 * Top-level service: getCinephageApiService() (implements BackgroundService).
 * Settings: getCinephageSettingsService() for config + per-module state.
 * HTTP core: getCinephageCore() for the shared api.cinephage.net client.
 * Registry: getCinephageModuleRegistry() for the module map.
 */

export {
	CinephageApiService,
	getCinephageApiService,
	resetCinephageApiService
} from './CinephageApiService.js';
export {
	CinephageSettingsService,
	getCinephageSettingsService,
	resetCinephageSettingsService,
	DEFAULT_CINEPHAGE_CONFIG,
	type CinephageSubsystemConfig,
	type CinephageModuleState
} from './settings/CinephageSettingsService.js';
export { CinephageCore, getCinephageCore, resetCinephageCore } from './core/CinephageCore.js';
export {
	CinephageModuleRegistry,
	getCinephageModuleRegistry,
	resetCinephageModuleRegistry
} from './registry/CinephageModuleRegistry.js';
export { BaseCinephageModule } from './modules/BaseCinephageModule.js';
export {
	LibraryStreamingModule,
	getLibraryStreamingModule,
	resetLibraryStreamingModule,
	CINEPHAGE_STREAM_DEFINITION_ID,
	libraryStreamingSettingsSchema,
	type LibraryStreamingSettings,
	type CinephageStreamLookupParams,
	type CinephageStreamLookupResult
} from './modules/library-streaming/LibraryStreamingModule.js';
export type {
	CinephageModule,
	CinephageModuleCapabilities,
	CinephageModuleContext,
	ConnectionTestResult
} from './modules/types.js';
export { getServerIdentity, type CinephageServerIdentity } from './core/version.js';
