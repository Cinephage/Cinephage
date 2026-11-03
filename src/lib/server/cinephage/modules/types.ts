import type { z } from 'zod';

/**
 * Capability advertisement for a Cinephage feature module.
 *
 * Modules declare what they provide via this object. The registry and the
 * subsystem consult these flags to route operations (e.g. "find all modules
 * that publish a virtual indexer") without instanceof checks or duck typing.
 */
export interface CinephageModuleCapabilities {
	/**
	 * Set when the module publishes one or more virtual indexer rows that
	 * surface on the indexers page (read-only, toggle-only). The definition
	 * IDs listed here are owned by the module - IndexerManager will not
	 * permit user delete/edit on them.
	 */
	readonly providesIndexer?: { readonly definitionId: string };
}

/**
 * Result of a module's test() call. Matches the codebase-wide connection-test
 * convention used by MediaBrowserClient, LiveTvProvider, ISubtitleProvider,
 * IDownloadClient.
 */
export interface ConnectionTestResult {
	readonly success: boolean;
	readonly error?: string;
	readonly details?: Record<string, unknown>;
}

/**
 * Context passed to a module's init() call. Provides the dependencies a module
 * needs to wire itself into the rest of the system without reaching for global
 * singletons.
 */
export interface CinephageModuleContext {
	/** Resolves the current subsystem config (baseUrl, enable state, overrides). */
	readonly getSubsystemConfig: () => Promise<{
		enabled: boolean;
		baseUrl: string;
		versionOverride: string | null;
		commitOverride: string | null;
	}>;
}

/**
 * CinephageModule - a feature that runs under the CinephageAPI subsystem.
 *
 * Modules are NOT interchangeable backends of the same function (that's the
 * existing `*Provider` pattern in this codebase). Each module is a distinct
 * feature that shares the subsystem's HTTP client, version identity, and
 * enable state. Examples today: library-streaming (local-DB streamer),
 * remote-streaming (api.cinephage.net VOD playback). Future: metadata-mirror,
 * dht-indexer, iptv.
 *
 * Lifecycle: register() → init() → (test() | isEnabled() | capabilities) → destroy()
 *
 * Implementers should extend BaseCinephageModule to inherit sensible defaults.
 */
export interface CinephageModule {
	/** Stable identifier ('library-streaming', 'remote-streaming'). Used as DB key. */
	readonly id: string;

	/** Display name shown in the settings panel. */
	readonly name: string;

	/** Short human-readable description. */
	readonly description: string;

	/** Stability badge. 'beta' surfaces a badge in the UI; 'planned' is inert. */
	readonly maturity: 'stable' | 'beta';

	/** What this module provides. See CinephageModuleCapabilities. */
	readonly capabilities: CinephageModuleCapabilities;

	/**
	 * Optional Zod schema for the module's per-module settings JSON. When
	 * present, the settings panel renders fields dynamically and writes are
	 * validated against this schema. When absent, the module has no UI config.
	 */
	readonly settingsSchema?: z.ZodType;

	/**
	 * Called once on subsystem startup (inside CinephageApiService.start()).
	 * Use to seed DB rows, register routes, subscribe to events, etc.
	 * Must resolve before the subsystem reports status 'ready'.
	 */
	init(ctx: CinephageModuleContext): Promise<void>;

	/**
	 * Called on subsystem shutdown. Best-effort cleanup.
	 * Default no-op via BaseCinephageModule.
	 */
	destroy?(): Promise<void>;

	/**
	 * Reports whether this module is currently active. The module is the
	 * authority on its own enable state - typically by consulting the
	 * CinephageSettingsService. Subsystem-level disable cascades: if the
	 * subsystem is disabled, isEnabled() MUST return false regardless of
	 * per-module state.
	 */
	isEnabled(): boolean;

	/**
	 * Connectivity / health check. Used by the settings panel's per-module
	 * status indicator and by the subsystem's periodic health ping.
	 * Default: returns { success: true } via BaseCinephageModule.
	 */
	test(): Promise<ConnectionTestResult>;
}
