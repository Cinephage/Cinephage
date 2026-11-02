import type { RequestHandler } from './$types';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { getNewznabCapabilitiesProvider } from '#lib/server/indexers/newznab/NewznabCapabilitiesProvider.js';
import { indexerTestSchema } from '#lib/validation/schemas.js';
import { mergeBlankSensitiveIndexerSettings } from '#lib/server/indexers/settingsSecrets.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import {
	getJackettConnection,
	isIndexerFromJackett,
	normalizeJackettUrl
} from '#lib/server/indexers/jackett/JackettConnectionService.js';
import {
	fetchProwlarrIndexers,
	getProwlarrConnection,
	isIndexerFromConnection,
	normalizeProwlarrUrl
} from '#lib/server/indexers/prowlarr/ProwlarrConnectionService.js';

function redactSensitiveDetails(message: string): string {
	return message
		.replace(
			/([?&](?:apikey|api_key|password|passkey|token|secret|cookie)=)[^&\s;]+/gi,
			'$1[REDACTED]'
		)
		.replace(/https?:\/\/[^\s;]+/gi, '<indexer-url>');
}

type ApiStandard = 'torznab' | 'newznab';

function inferApiStandard(definitionId: string | undefined): ApiStandard | undefined {
	if (!definitionId) return undefined;
	const lower = definitionId.toLowerCase();
	if (lower.includes('torznab')) return 'torznab';
	if (lower.includes('newznab') || lower.includes('newsznab')) return 'newznab';
	return undefined;
}

function getApiStandardLabel(apiStandard: ApiStandard | undefined): string {
	if (apiStandard === 'torznab') return 'Torznab';
	if (apiStandard === 'newznab') return 'Newznab';
	return 'Torznab/Newznab';
}

function toFriendlyTestError(rawMessage: string, apiStandard?: ApiStandard): string {
	const message = rawMessage.trim().replace(/^Indexer test failed:\s*/i, '');
	const lower = message.toLowerCase();
	const apiLabel = getApiStandardLabel(apiStandard);

	// Provider-reported API errors (e.g. Newznab XML <error .../>)
	const apiErrorMatch = message.match(/Indexer(?: API)? error\s*([0-9]+)?\s*:?\s*(.+)/i);
	if (apiErrorMatch) {
		const code = apiErrorMatch[1];
		const description = apiErrorMatch[2]?.trim() ?? 'Unknown API error';

		if (/wrong api key|invalid api key|missing api key|apikey/i.test(description)) {
			return 'Authentication failed: invalid API key.';
		}

		return code
			? `Indexer API error (${code}): ${description}`
			: `Indexer API error: ${description}`;
	}

	if (
		lower.includes('wrong api key') ||
		lower.includes('invalid api key') ||
		lower.includes('missing api key')
	) {
		return 'Authentication failed: invalid API key.';
	}

	if (
		lower.includes('unable to reach indexer server') ||
		lower.includes('all test requests failed') ||
		lower.includes('all urls failed') ||
		lower.includes('fetch failed') ||
		lower.includes('econnrefused') ||
		lower.includes('enotfound') ||
		lower.includes('eai_again') ||
		lower.includes('etimedout') ||
		lower.includes('timeout') ||
		lower.includes('timed out') ||
		lower.includes('unreachable')
	) {
		return 'Unable to reach the indexer. Check URL, port, and SSL settings.';
	}

	if (
		lower.includes('authentication failed') ||
		lower.includes('login failed') ||
		lower.includes('unauthorized') ||
		lower.includes('forbidden')
	) {
		const usesApiKey = apiStandard === 'torznab' || apiStandard === 'newznab';
		return usesApiKey
			? 'Authentication failed. Check your API key.'
			: 'Authentication failed. Check your credentials/cookies.';
	}

	if (lower.includes('cloudflare')) {
		return 'Connection blocked by Cloudflare protection.';
	}

	if (lower.includes('returned html instead of xml')) {
		return `Endpoint returned HTML instead of XML. Verify you are using the ${apiLabel} API URL.`;
	}

	if (lower.includes('missing <caps>')) {
		return `Endpoint is reachable but did not return a valid ${apiLabel} caps response.`;
	}

	if (lower.includes('no test request could be generated')) {
		return 'Unable to build a valid test request for this indexer definition.';
	}

	const sanitized = redactSensitiveDetails(message);

	// Final fallback: collapse long chained test traces into a single concise reason.
	const sequenceMatch = sanitized.match(/(?:All test requests failed|All URLs failed):\s*(.+)/i);
	if (sequenceMatch?.[1]) {
		const firstReason = sequenceMatch[1]
			.split(';')
			.map((part) => part.trim())
			.map((part) => part.replace(/^<indexer-url>:\s*/i, ''))
			.find(Boolean);
		if (firstReason) {
			return firstReason.length > 180 ? `${firstReason.slice(0, 177)}...` : firstReason;
		}
	}

	return sanitized.length > 180 ? `${sanitized.slice(0, 177)}...` : sanitized;
}

function extractApiKey(
	settings: Record<string, string | number | boolean> | null | undefined
): string | undefined {
	if (!settings) return undefined;
	const candidate = settings.apikey ?? settings.apiKey ?? settings.api_key;
	if (typeof candidate !== 'string') return undefined;
	const trimmed = candidate.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const result = indexerTestSchema.safeParse(data);

	if (!result.success) {
		return Response.json(
			{
				success: false,
				error: 'Validation failed',
				details: result.error.flatten()
			},
			{ status: 400 }
		);
	}

	const validated = result.data;

	const manager = await getIndexerManager();
	const indexerId = validated.indexerId;

	// Verify the definition exists
	const definition = manager.getDefinition(validated.definitionId);
	if (!definition) {
		return Response.json(
			{
				success: false,
				error: `Unknown indexer definition: ${validated.definitionId}`
			},
			{ status: 400 }
		);
	}

	let existingSettings: Record<string, unknown> | undefined;
	let existingBaseUrl: string | undefined;
	let existingIndexer: Awaited<ReturnType<typeof manager.getIndexer>> | undefined;

	// If testing an existing saved indexer from overview, verify it exists
	// so health tracking updates apply only to real indexers.
	if (indexerId) {
		const existing = await manager.getIndexer(indexerId);
		if (!existing) {
			return Response.json(
				{
					success: false,
					error: `Unknown indexer ID: ${indexerId}`
				},
				{ status: 400 }
			);
		}
		existingSettings = existing.settings;
		existingBaseUrl = existing.baseUrl;
		existingIndexer = existing;

		// If Prowlarr has this indexer disabled, skip the test and tell the user where to fix it.
		if (existing.upstreamEnabled === false) {
			return Response.json(
				{
					success: false,
					error: 'This indexer is disabled in Prowlarr. Enable it there first, then re-sync.'
				},
				{ status: 422 }
			);
		}

		// For Jackett-sourced indexers, make a warm-up search against Jackett's Torznab
		// endpoint before running the Cinephage test. Jackett maintains an internal circuit
		// breaker per indexer; if FlareSolverr previously failed, Jackett marks the indexer
		// as broken and all subsequent searches return errors. A direct Torznab search request
		// gives Jackett a chance to retry FlareSolverr and reset its own circuit breaker.
		// Without this, the Cinephage test would keep failing even after FlareSolverr recovers,
		// requiring the user to manually test in Jackett first.
		try {
			const jackettConn = await getJackettConnection();
			if (jackettConn) {
				const jackettBase = normalizeJackettUrl(jackettConn.url);
				// Warmup via torznab only applies to legacy format; native indexers use baseUrl = jackettBase
				if (isIndexerFromJackett(existing, jackettBase) && existing.definitionId !== 'jackett') {
					const warmupUrl = `${existing.baseUrl}?apikey=${encodeURIComponent(jackettConn.apiKey)}&t=search&q=test`;
					await fetch(warmupUrl, { signal: AbortSignal.timeout(15000) });
				}
			}
		} catch {
			// Warm-up failure is expected when Jackett/FlareSolverr is down; proceed anyway.
		}

		// Refresh the API key from the current connection config so the test uses
		// fresh credentials without requiring a manual sync first.
		const [freshProwlarrConn, freshJackettConn] = await Promise.all([
			getProwlarrConnection(),
			getJackettConnection()
		]);
		if (freshProwlarrConn) {
			const prowlarrBase = normalizeProwlarrUrl(freshProwlarrConn.url);
			if (isIndexerFromConnection(existing, prowlarrBase)) {
				existingSettings = { ...existingSettings, apikey: freshProwlarrConn.apiKey };
			}
		}
		if (freshJackettConn) {
			const jackettBase = normalizeJackettUrl(freshJackettConn.url);
			if (isIndexerFromJackett(existing, jackettBase)) {
				existingSettings = { ...existingSettings, apikey: freshJackettConn.apiKey };
			}
		}
	}

	try {
		// Get protocol from YAML definition
		const protocol = definition.protocol;
		const settings = mergeBlankSensitiveIndexerSettings(
			validated.settings,
			existingSettings,
			definition.settings
		);

		// Aggregate Prowlarr indexer: skip the full fan-out search and do a lightweight
		// /api/v1/indexer request to verify connectivity and authentication only.
		if (validated.definitionId === 'prowlarr' && settings.aggregate) {
			const apiKey = extractApiKey(settings);
			if (!apiKey) {
				return Response.json(
					{ success: false, error: 'Prowlarr API key is missing.' },
					{ status: 400 }
				);
			}
			try {
				await fetchProwlarrIndexers(validated.baseUrl, apiKey);
				return Response.json({ success: true });
			} catch (e) {
				const message = e instanceof Error ? e.message : 'Unable to connect to Prowlarr.';
				return Response.json({ success: false, error: message }, { status: 400 });
			}
		}

		// Torznab validation: auto-discover the correct endpoint if the user entered a bare host URL,
		// then validate the resolved URL's caps endpoint.
		if (validated.definitionId === 'torznab') {
			const provider = getNewznabCapabilitiesProvider();
			const apiKey = extractApiKey(settings);
			const resolvedUrl = await provider.resolveTorznabBaseUrl(validated.baseUrl, apiKey);
			await provider.validateCapabilitiesEndpoint(resolvedUrl, apiKey);
		}

		await manager.testIndexer(
			{
				name: validated.name,
				definitionId: validated.definitionId,
				baseUrl: validated.baseUrl,
				alternateUrls: validated.alternateUrls,
				enabled: true,
				priority: 25,
				protocol,
				settings: settings as Record<string, string>,

				// Default values for test (not needed for connectivity test)
				enableAutomaticSearch: true,
				enableInteractiveSearch: true,
				minimumSeeders: 1,
				seedRatio: null,
				seedTime: null,
				packSeedTime: null
			},
			indexerId
		);

		return Response.json({ success: true });
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Unknown error';
		const lower = message.toLowerCase();
		const apiStandard = inferApiStandard(validated.definitionId);

		// Detect "indexer removed from upstream" and auto-disable to prevent it being
		// used in searches until the next sync cleans it up.
		// Patterns: HTTP 404 (Prowlarr and Jackett) or missing caps element (Jackett
		// returns error XML instead of caps when an indexer is deleted).
		const looksGone = lower.includes('404') || lower.includes('missing <caps>');

		if (indexerId && existingBaseUrl && looksGone) {
			const [prowlarrConn, jackettConn2] = await Promise.all([
				getProwlarrConnection(),
				getJackettConnection()
			]);

			let source: string | null = null;
			if (prowlarrConn) {
				const prowlarrBase = normalizeProwlarrUrl(prowlarrConn.url);
				if (existingIndexer && isIndexerFromConnection(existingIndexer, prowlarrBase))
					source = 'Prowlarr';
			}
			if (!source && jackettConn2) {
				const jackettBase = normalizeJackettUrl(jackettConn2.url);
				if (existingIndexer && isIndexerFromJackett(existingIndexer, jackettBase))
					source = 'Jackett';
			}

			if (source) {
				try {
					await manager.updateIndexer(indexerId, { enabled: false, orphaned: true });
				} catch {
					// Ignore - the error response below is still correct
				}
				return Response.json(
					{
						success: false,
						error: `Indexer not found in ${source} - it was likely removed. Marked as deleted; enable it to run a connection test and restore it if it comes back.`
					},
					{ status: 400 }
				);
			}
		}

		return Response.json(
			{ success: false, error: toFriendlyTestError(message, apiStandard) },
			{ status: 400 }
		);
	}
};
