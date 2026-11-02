/**
 * Cinephage IPTV Countries API
 *
 * GET /api/livetv/cinephage-iptv/countries - List all IPTV countries from Cinephage API.
 * Routes through CinephageCore so the configured base URL and auth headers
 * (identity pair + install key) apply like every other gateway call.
 */

import type { RequestHandler } from './$types';
import { createChildLogger } from '#lib/logging/index.js';
import { getCinephageCore } from '#lib/server/cinephage/core/CinephageCore.js';

const logger = createChildLogger({ module: 'LiveTvCinephageIptvCountries', logDomain: 'livetv' });

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

async function fetchCinephageCountries(): Promise<CinephageCountry[]> {
	const core = getCinephageCore();
	try {
		const response = await core.get('/api/v1/iptv/countries');
		const data = JSON.parse(response.body) as { countries?: CinephageCountry[] };

		if (!data.countries || !Array.isArray(data.countries)) {
			throw new Error('Unexpected response format from Cinephage API');
		}

		return data.countries;
	} catch (error) {
		throw new Error(await core.toGatewayErrorMessage(error), { cause: error });
	}
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
