/**
 * Provider Analytics API
 *
 * GET /api/subtitles/providers/analytics
 * Returns throttle status for all configured subtitle providers
 *
 * DELETE /api/subtitles/providers/analytics?provider=<id>
 * Clear throttle for a specific provider
 */

import type { RequestEvent } from '@sveltejs/kit';
import { getSubtitleProviderManager } from '#lib/server/subtitles/services/SubtitleProviderManager.js';
import { assertFound } from '#lib/server/api/validate.js';

export interface ProviderAnalyticsResponse {
	/** Provider ID */
	id: string;
	/** Provider name */
	name: string;
	/** Provider implementation */
	implementation: string;
	/** Whether the provider is enabled */
	enabled: boolean;
	/** Throttle status */
	throttle: {
		isThrottled: boolean;
		throttledUntil?: string;
		consecutiveFailures: number;
		lastError?: string;
		lastErrorAt?: string;
	};
}

export interface AllAnalyticsResponse {
	providers: ProviderAnalyticsResponse[];
	/** Total configured providers */
	totalProviders: number;
	/** Currently throttled providers count */
	throttledCount: number;
	/** Timestamp */
	timestamp: string;
}

/**
 * GET - Get throttle status for all providers
 */
export async function GET(): Promise<Response> {
	const providerManager = getSubtitleProviderManager();
	const configs = await providerManager.getProviders();

	const providers: ProviderAnalyticsResponse[] = [];
	let throttledCount = 0;

	for (const config of configs) {
		const isThrottled = providerManager.isThrottled(config);
		if (isThrottled) {
			throttledCount++;
		}

		providers.push({
			id: config.id,
			name: config.name,
			implementation: config.implementation,
			enabled: config.enabled,
			throttle: {
				isThrottled,
				throttledUntil: config.throttledUntil ?? undefined,
				consecutiveFailures: config.consecutiveFailures,
				lastError: config.lastError ?? undefined,
				lastErrorAt: config.lastErrorAt ?? undefined
			}
		});
	}

	// Sort by consecutive failures (most failures first)
	providers.sort((a, b) => b.throttle.consecutiveFailures - a.throttle.consecutiveFailures);

	const response: AllAnalyticsResponse = {
		providers,
		totalProviders: configs.length,
		throttledCount,
		timestamp: new Date().toISOString()
	};

	return Response.json(response);
}

/**
 * DELETE - Clear throttle for a specific provider
 *
 * Query params:
 * - provider: The provider ID to clear throttle for
 */
export async function DELETE({ url }: RequestEvent): Promise<Response> {
	const providerId = url.searchParams.get('provider');

	if (!providerId) {
		return Response.json({ error: 'Missing provider parameter' }, { status: 400 });
	}

	const providerManager = getSubtitleProviderManager();

	// Check if provider exists
	const config = assertFound(await providerManager.getProvider(providerId), 'Provider', providerId);

	// Clear throttle by recording a "success" which resets all error state
	await providerManager.recordSuccess(providerId);

	return Response.json({
		success: true,
		message: `Throttle cleared for ${config.name}`
	});
}
