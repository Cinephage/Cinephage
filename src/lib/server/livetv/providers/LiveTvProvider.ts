/**
 * Live TV Provider Interface
 *
 * Abstract interface for all Live TV provider implementations.
 * Each provider type (Stalker, XStream, M3U) implements this interface
 * to provide a unified API for channel management and streaming.
 */

import type {
	LiveTvProviderType,
	LiveTvAccount,
	LiveTvChannel,
	LiveTvCategory,
	CachedChannel,
	ChannelSyncResult,
	EpgProgram,
	LiveTvAccountTestResult,
	AuthResult,
	StreamResolutionResult,
	ProviderCapabilities
} from '#lib/types/livetv.js';

/**
 * Live TV Provider Interface
 *
 * All provider implementations must implement this interface.
 */
export interface LiveTvProvider {
	/** Provider type identifier */
	readonly type: LiveTvProviderType;

	/** Provider capabilities */
	readonly capabilities: ProviderCapabilities;

	/**
	 * Get provider name for display
	 */
	getDisplayName(): string;

	// ============================================================================
	// Authentication
	// ============================================================================

	/**
	 * Authenticate with the provider
	 * @param account The account to authenticate
	 * @returns Authentication result with token if successful
	 */
	authenticate(account: LiveTvAccount): Promise<AuthResult>;

	/**
	 * Test account connection without fully authenticating
	 * @param account The account to test
	 * @returns Test result with profile info if successful
	 */
	testConnection(account: LiveTvAccount): Promise<LiveTvAccountTestResult>;

	/**
	 * Check if current authentication token is valid
	 * @param account The account to check
	 */
	isAuthenticated(account: LiveTvAccount): boolean;

	// ============================================================================
	// Channel Sync
	// ============================================================================

	/**
	 * Sync channels and categories from provider
	 * @param accountId The account ID to sync
	 * @returns Sync result with counts
	 */
	syncChannels(accountId: string): Promise<ChannelSyncResult>;

	/**
	 * Get categories from provider (for on-demand fetching)
	 * @param account The account to fetch categories for
	 */
	fetchCategories(account: LiveTvAccount): Promise<LiveTvCategory[]>;

	/**
	 * Get channels from provider (for on-demand fetching)
	 * @param account The account to fetch channels for
	 */
	fetchChannels(account: LiveTvAccount): Promise<LiveTvChannel[]>;

	// ============================================================================
	// Stream Resolution
	// ============================================================================

	/**
	 * Resolve stream URL for a channel
	 * @param account The account to use
	 * @param channel The channel to get stream for (CachedChannel from lineup)
	 * @param format Optional format preference: 'ts' for direct MPEG-TS, 'hls' for HLS playlist (default: 'hls')
	 * @returns Stream resolution result with URL
	 */
	resolveStreamUrl(
		account: LiveTvAccount,
		channel: CachedChannel | LiveTvChannel,
		format?: 'ts' | 'hls'
	): Promise<StreamResolutionResult>;

	/**
	 * Get direct stream URL (for providers that have static URLs)
	 * @param channel The channel to get URL for (CachedChannel from lineup)
	 */
	getDirectStreamUrl?(channel: CachedChannel | LiveTvChannel): string | null;

	// ============================================================================
	// EPG (Optional - only if provider supports EPG)
	// ============================================================================

	/**
	 * Fetch EPG data from provider
	 * @param account The account to fetch EPG for
	 * @param startTime Start time for EPG range
	 * @param endTime End time for EPG range
	 * @returns Array of EPG programs
	 */
	fetchEpg?(account: LiveTvAccount, startTime: Date, endTime: Date): Promise<EpgProgram[]>;

	/**
	 * Check if provider has EPG support
	 */
	hasEpgSupport(): boolean;

	// ============================================================================
	// Archive/Catch-up TV (Optional)
	// ============================================================================

	/**
	 * Get archive stream URL for a time-shifted stream
	 * @param account The account to use
	 * @param channel The channel (CachedChannel from lineup)
	 * @param startTime Archive start time
	 * @param duration Archive duration in seconds
	 */
	getArchiveStreamUrl?(
		account: LiveTvAccount,
		channel: CachedChannel | LiveTvChannel,
		startTime: Date,
		duration: number
	): Promise<StreamResolutionResult>;

	/**
	 * Check if provider supports archive/catch-up TV
	 */
	supportsArchive(): boolean;
}

/**
 * Provider factory interface
 */
export interface LiveTvProviderFactory {
	/**
	 * Create a provider instance for the given type
	 * @param type Provider type
	 */
	createProvider(type: LiveTvProviderType): LiveTvProvider;

	/**
	 * Get provider for an account
	 * @param account The account to get provider for
	 */
	getProviderForAccount(account: LiveTvAccount): LiveTvProvider;
}
