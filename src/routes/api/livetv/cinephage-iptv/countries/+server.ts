/**
 * Cinephage IPTV Countries API
 *
 * GET /api/livetv/cinephage-iptv/countries - List all IPTV countries from Cinephage API
 */

import type { RequestHandler } from './$types';
import { createChildLogger } from '#lib/logging/index.js';
import { getStreamingIndexerSettings } from '#lib/server/streaming/settings.js';
import { getCinephageCore } from '#lib/server/cinephage/core/CinephageCore.js';
import {
	getSignatureHeaders,
	isGatewaySignatureRejection,
	signedGatewayFetch
} from '#lib/server/cinephage/core/signing.js';

const logger = createChildLogger({ module: 'LiveTvCinephageIptvCountries', logDomain: 'livetv' });

const CINEPHAGE_API_BASE = 'https://api.cinephage.net';
const CACHE_TTL = 24 * 60 * 60 * 1000;

interface CinephageCountry {
	code: string;
	name: string;
	channel_count?: number;
	flag?: string | null;
	languages?: string | null;
}

interface CachedData {
	data: CinephageCountry[];
	fetchedAt: number;
}

let cachedCountries: CachedData | null = null;

async function getAuthHeaders(): Promise<Record<string, string>> {
	const settings = await getStreamingIndexerSettings();
	const version = settings?.cinephageVersion;
	const commit = settings?.cinephageCommit;

	if (!version || !commit) {
		throw new Error('Cinephage API not configured: missing cinephageVersion or cinephageCommit');
	}

	return {
		'X-Cinephage-Version': version,
		'X-Cinephage-Commit': commit
	};
}

async function fetchCinephageCountries(): Promise<CinephageCountry[]> {
	const url = `${CINEPHAGE_API_BASE}/api/v1/iptv/countries`;

	const response = await signedGatewayFetch(
		url,
		{ accept: 'application/json', timeoutMs: 30_000 },
		async () => ({
			...(await getAuthHeaders()),
			...getSignatureHeaders({ method: 'GET', url })
		})
	);

	if (!response.ok) {
		if (response.status === 401) {
			if (await isGatewaySignatureRejection(response)) {
				// Signature-specific: the identity pair is fine, the signature
				// is missing or wrong — an identity re-sync cannot heal this.
				throw new Error(
					'Gateway rejected the request signature. Verify CINEPHAGE_SIGNING_SECRET matches this build.'
				);
			}
			// The gateway rejected our identity (likely stale release pair).
			// Kick off a self-heal refresh so the next request authenticates
			// with the latest release.
			void getCinephageCore().refreshLatestIdentity(true);
			throw new Error('Cinephage API rejected authentication');
		}
		if (response.status === 429) {
			throw new Error('Cinephage API rate limited this request');
		}
		throw new Error(`Cinephage API returned HTTP ${response.status}`);
	}

	const data = (await response.json()) as { countries?: CinephageCountry[] };

	if (!data.countries || !Array.isArray(data.countries)) {
		throw new Error('Unexpected response format from Cinephage API');
	}

	return data.countries;
}

async function getCachedCountries(): Promise<CinephageCountry[]> {
	if (cachedCountries && Date.now() - cachedCountries.fetchedAt < CACHE_TTL) {
		return cachedCountries.data;
	}

	logger.info('[CinephageCountries] Fetching countries data from Cinephage API');

	let countries: CinephageCountry[];
	try {
		countries = await fetchCinephageCountries();
	} catch (error) {
		if (cachedCountries) {
			logger.warn({ err: error }, '[CinephageCountries] Fetch failed, serving stale cache');
			return cachedCountries.data;
		}
		throw error;
	}

	countries.sort((a, b) => a.name.localeCompare(b.name));

	cachedCountries = { data: countries, fetchedAt: Date.now() };

	logger.info({ count: countries.length }, '[CinephageCountries] Cached countries data');
	return countries;
}

export const GET: RequestHandler = async () => {
	try {
		const countries = await getCachedCountries();

		return Response.json({
			success: true,
			countries: countries.map((c) => ({
				code: c.code,
				name: c.name,
				flag: c.flag || ''
			})),
			cached: cachedCountries !== null && Date.now() - cachedCountries.fetchedAt < CACHE_TTL,
			count: countries.length
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error({ error: message }, '[CinephageCountries] Failed to fetch countries');

		return Response.json({ success: false, error: message }, { status: 500 });
	}
};
