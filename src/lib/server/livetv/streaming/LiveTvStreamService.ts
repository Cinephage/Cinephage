/**
 * Live TV Stream Service
 *
 * Main orchestration service for Live TV streaming.
 * Handles stream URL resolution with failover support across multiple provider types.
 * Supports Stalker Portal, XStream Codes, and M3U playlist sources.
 */

import { createChildLogger } from '#lib/logging/index.js';
import { channelLineupService } from '#lib/server/livetv/lineup/ChannelLineupService.js';
import { getProvider } from '#lib/server/livetv/providers/index.js';
import { recordToAccount } from '#lib/server/livetv/LiveTvAccountManager.js';
import { db } from '#lib/server/db/index.js';
import { livetvAccounts, livetvChannels } from '#lib/server/db/schema.js';
import { and, eq, ne } from 'drizzle-orm';
import { resolveAndValidateUrl } from '#lib/server/http/ssrf-protection.js';
import type { BackgroundService, ServiceStatus } from '#lib/server/services/background-service.js';
import { ValidationError, ExternalServiceError } from '#lib/errors/index.js';
import { STB_USER_AGENT } from '#lib/server/livetv/stalker/StalkerPortalClient.js';
import type {
	FetchStreamResult,
	StreamError,
	CachedChannel,
	LiveTvProviderType
} from '#lib/types/livetv.js';

const logger = createChildLogger({ module: 'LiveTvStreamService' });

/**
 * Result of resolving a stream URL (without opening an HTTP connection)
 */
export interface StreamUrlResolution {
	url: string;
	type: 'hls' | 'direct' | 'unknown';
	accountId: string;
	channelId: string;
	lineupItemId: string;
	providerType: LiveTvProviderType;
	providerHeaders?: Record<string, string>;
}

/**
 * Result of fetching a URL with redirect tracking.
 * Includes the final URL after all redirects were followed.
 */
export interface FetchFromUrlResult {
	response: Response;
	/** The final URL after following all redirects (same as input if no redirects) */
	finalUrl: string;
}

/**
 * Stream source info for failover
 */
interface StreamSource {
	accountId: string;
	channelId: string;
	channel: CachedChannel;
	providerType: LiveTvProviderType;
	priority: number;
}

export class LiveTvStreamService implements BackgroundService {
	readonly name = 'LiveTvStreamService';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;

	// Metrics
	private totalResolutions = 0;
	private failovers = 0;

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	/**
	 * Start the service (non-blocking)
	 * Implements BackgroundService.start()
	 */
	start(): void {
		if (this._status === 'ready' || this._status === 'starting') {
			logger.debug('LiveTvStreamService already running');
			return;
		}

		this._status = 'starting';
		logger.info('Starting LiveTvStreamService');

		// Service initialization is synchronous for this service
		setImmediate(() => {
			this._status = 'ready';
			logger.info('LiveTvStreamService ready');
		});
	}

	/**
	 * Stop the service gracefully
	 * Implements BackgroundService.stop()
	 */
	async stop(): Promise<void> {
		if (this._status === 'pending') {
			return;
		}

		logger.info('Stopping LiveTvStreamService');
		this._status = 'pending';
		logger.info('LiveTvStreamService stopped');
	}

	/**
	 * Resolve stream URL and metadata without opening an HTTP connection.
	 * Returns everything needed to fetch the stream (URL, headers, type).
	 *
	 * Used by StreamUrlCache to cache URL resolution results, and by the
	 * route handler to determine stream type before deciding how to proxy.
	 *
	 * @param lineupItemId - The lineup item ID
	 * @param format - Preferred format: 'ts' for direct MPEG-TS, 'hls' for HLS playlist (default)
	 */
	async resolveStream(
		lineupItemId: string,
		format: 'ts' | 'hls' = 'hls'
	): Promise<StreamUrlResolution> {
		this.totalResolutions++;

		// Get lineup item with backups (single DB query — includes channel data)
		const item = await channelLineupService.getChannelWithBackups(lineupItemId);
		if (!item) {
			throw this.createError('LINEUP_ITEM_NOT_FOUND', `Lineup item not found: ${lineupItemId}`);
		}

		// Build source list: primary first, then backups in priority order
		const sources: StreamSource[] = [
			{
				accountId: item.accountId,
				channelId: item.channelId,
				channel: item.channel,
				providerType: item.providerType,
				priority: 0
			}
		];

		// Add internal channel-level fallback from the same account.
		// When the primary channel fails (dead stream, unreachable redirect),
		// try 2 other channels from the same working account before failing
		// over to cross-account backups.
		const internalFallbackCount = 2;
		const fallbackRows = await db
			.select()
			.from(livetvChannels)
			.where(
				and(eq(livetvChannels.accountId, item.accountId), ne(livetvChannels.id, item.channelId))
			)
			.limit(internalFallbackCount);

		for (let i = 0; i < fallbackRows.length; i++) {
			const row = fallbackRows[i];
			const stalkerData = (row.stalkerData ?? undefined) as
				import('#lib/types/livetv.js').StalkerChannelData | undefined;
			sources.push({
				accountId: row.accountId,
				channelId: row.id,
				channel: {
					id: row.id,
					accountId: row.accountId,
					providerType: row.providerType as import('#lib/types/livetv.js').LiveTvProviderType,
					externalId: row.externalId,
					name: row.name,
					number: row.number,
					logo: row.logo,
					categoryId: row.categoryId,
					categoryTitle: null,
					providerCategoryId: row.providerCategoryId,
					stalker: stalkerData,
					createdAt: row.createdAt ?? new Date().toISOString(),
					updatedAt: row.updatedAt ?? new Date().toISOString()
				},
				providerType: row.providerType as import('#lib/types/livetv.js').LiveTvProviderType,
				priority: 0.1 + i * 0.1
			});
		}

		for (const backup of item.backups) {
			sources.push({
				accountId: backup.accountId,
				channelId: backup.channelId,
				channel: backup.channel,
				providerType: backup.providerType,
				priority: backup.priority
			});
		}

		// Try each source
		const errors: Array<{ source: StreamSource; error: Error }> = [];

		for (const source of sources) {
			try {
				const result = await this.resolveFromSource(source, lineupItemId, format);

				if (source.priority > 0) {
					this.failovers++;
					logger.info(
						{
							backupAccountId: source.accountId,
							failoverCount: this.failovers
						},
						'Used backup source'
					);
				}

				return result;
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				errors.push({ source, error: err });

				logger.warn(
					{
						accountId: source.accountId,
						channelId: source.channelId,
						error: err.message
					},
					'Source failed'
				);
			}
		}

		// All sources failed
		const errorMessages = errors.map((e) => `[${e.source.priority}] ${e.error.message}`).join('; ');
		throw this.createError(
			'ALL_SOURCES_FAILED',
			`All ${sources.length} sources failed: ${errorMessages}`,
			sources[0].accountId,
			sources[0].channelId,
			sources.length
		);
	}

	/**
	 * Fetch stream - resolves URL and fetches the actual content.
	 * For backward compatibility with callers that need the full Response.
	 */
	async fetchStream(lineupItemId: string): Promise<FetchStreamResult> {
		const resolved = await this.resolveStream(lineupItemId);
		const { response } = await this.fetchFromUrl(
			resolved.url,
			resolved.providerType,
			resolved.providerHeaders
		);

		return {
			...resolved,
			response
		};
	}

	/**
	 * Resolve stream URL from a single source (no HTTP fetch)
	 */
	private async resolveFromSource(
		source: StreamSource,
		lineupItemId: string,
		format: 'ts' | 'hls' = 'hls'
	): Promise<StreamUrlResolution> {
		const { accountId, channelId, channel, providerType } = source;

		// Get account
		const accountRecord = await db
			.select()
			.from(livetvAccounts)
			.where(eq(livetvAccounts.id, accountId))
			.limit(1)
			.then((rows) => rows[0]);

		if (!accountRecord) {
			throw this.createError('ACCOUNT_NOT_FOUND', `Account not found: ${accountId}`, accountId);
		}

		if (!accountRecord.enabled) {
			throw new ValidationError(`Account is disabled: ${accountId}`);
		}

		const account = recordToAccount(accountRecord);

		// Get the appropriate provider and resolve stream URL
		const provider = getProvider(providerType);
		const resolutionResult = await provider.resolveStreamUrl(account, channel, format);

		if (!resolutionResult.success || !resolutionResult.url) {
			throw new ExternalServiceError(
				providerType,
				resolutionResult.error || 'Failed to resolve stream URL',
				502
			);
		}

		const streamUrl = resolutionResult.url;

		// SSRF protection: validate resolved URL (with DNS resolution)
		const safetyCheck = await resolveAndValidateUrl(streamUrl);
		if (!safetyCheck.safe) {
			logger.warn(
				{
					url: streamUrl.substring(0, 100)
				},
				'Blocked unsafe stream URL'
			);
			throw new ValidationError(`Stream URL blocked: ${safetyCheck.reason}`);
		}

		logger.info(
			{
				url: streamUrl.substring(0, 100),
				type: resolutionResult.type,
				providerType
			},
			'Stream URL resolved'
		);

		return {
			url: streamUrl,
			type: resolutionResult.type,
			accountId,
			channelId,
			lineupItemId,
			providerType,
			providerHeaders: resolutionResult.headers
		};
	}

	/**
	 * Fetch a stream from a resolved URL with SSRF-safe redirect handling.
	 * Used after resolveStream() when we need the actual HTTP response.
	 * Returns both the response and the final URL after all redirects.
	 */
	async fetchFromUrl(
		streamUrl: string,
		providerType: string,
		providerHeaders?: Record<string, string>,
		signal?: AbortSignal
	): Promise<FetchFromUrlResult> {
		throwIfAborted(signal);
		const initialSafetyCheck = await resolveAndValidateUrl(streamUrl);
		throwIfAborted(signal);
		if (!initialSafetyCheck.safe) {
			throw new ValidationError(`Stream URL blocked: ${initialSafetyCheck.reason}`);
		}

		const requestHeaders: Record<string, string> = {
			'User-Agent': STB_USER_AGENT,
			Accept: '*/*',
			...providerHeaders
		};

		// Fetch with manual redirect handling for SSRF protection
		const MAX_STREAM_REDIRECTS = 5;
		let currentStreamUrl = streamUrl;
		let redirectCount = 0;
		const visitedUrls = new Set<string>();
		let response: Response;

		while (true) {
			if (visitedUrls.has(currentStreamUrl)) {
				throw new ExternalServiceError(providerType, 'Redirect loop detected', 508);
			}
			visitedUrls.add(currentStreamUrl);

			if (redirectCount >= MAX_STREAM_REDIRECTS) {
				throw new ExternalServiceError(providerType, 'Too many redirects', 508);
			}

			response = await fetch(currentStreamUrl, {
				headers: requestHeaders,
				redirect: 'manual',
				signal
			});

			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get('location');
				if (location) {
					await response.body?.cancel();
					const redirectUrl = new URL(location, currentStreamUrl).toString();
					const redirectSafetyCheck = await resolveAndValidateUrl(redirectUrl);
					if (!redirectSafetyCheck.safe) {
						logger.warn(
							{
								url: redirectUrl.substring(0, 100),
								reason: redirectSafetyCheck.reason
							},
							'Blocked unsafe stream redirect'
						);
						throw new ValidationError(`Stream redirect blocked: ${redirectSafetyCheck.reason}`);
					}
					currentStreamUrl = redirectUrl;
					redirectCount++;
					continue;
				}
			}

			break;
		}

		if (!response.ok) {
			await response.body?.cancel();
			logger.error(
				{
					status: response.status,
					statusText: response.statusText
				},
				'Stream fetch failed'
			);
			throw new ExternalServiceError(
				providerType,
				`Upstream error: ${response.status}`,
				response.status
			);
		}

		return { response, finalUrl: currentStreamUrl };
	}

	/**
	 * Create a typed stream error
	 */
	private createError(
		code: StreamError['code'],
		message: string,
		accountId?: string,
		channelId?: string,
		attempts?: number
	): StreamError {
		const error = new Error(message) as StreamError;
		error.code = code;
		error.accountId = accountId;
		error.channelId = channelId;
		error.attempts = attempts;
		return error;
	}

	/**
	 * Get service metrics
	 */
	getMetrics(): {
		totalResolutions: number;
		failovers: number;
	} {
		return {
			totalResolutions: this.totalResolutions,
			failovers: this.failovers
		};
	}

	/**
	 * Shutdown service - cleanup resources
	 */
	shutdown(): void {
		logger.info('Service shutdown');
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

// Singleton instance
let streamServiceInstance: LiveTvStreamService | null = null;

/**
 * Get the singleton LiveTvStreamService instance
 */
export function getLiveTvStreamService(): LiveTvStreamService {
	if (!streamServiceInstance) {
		streamServiceInstance = new LiveTvStreamService();
	}
	return streamServiceInstance;
}

export type { FetchStreamResult };
