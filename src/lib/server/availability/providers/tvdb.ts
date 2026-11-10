import { createChildLogger } from '#lib/logging/index.js';
import { decryptSettingValue } from '#lib/server/settings/secretSettings.js';
import { db } from '#lib/server/db/index.js';
import { settings } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';

const logger = createChildLogger({ module: 'TvdbClient', logDomain: 'monitoring' });

const BASE = 'https://api4.thetvdb.com/v4';
/** TVDB v4 tokens are JWTs valid ~1 month; refresh well inside that. */
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface SeriesSchedule {
	airTime: string | null;
	airsDays: string[];
	country: string | null;
	network: string | null;
}

interface TokenCache {
	token: string;
	apiKeyFingerprint: string;
	obtainedAt: number;
}

let cache: TokenCache | null = null;

async function readSetting(key: string): Promise<string | null> {
	const row = await db
		.select({ value: settings.value })
		.from(settings)
		.where(eq(settings.key, key))
		.get();

	if (!row?.value) return null;
	return decryptSettingValue(key, row.value);
}

/**
 * TVDB v4 client.
 *
 * Deliberately narrow: the only thing Cinephage needs from TVDB is the broadcast
 * schedule, because TMDB has no air time. Identity, overviews and release
 * windows stay TMDB's job — see `providers/tmdb.ts`.
 */
export class TvdbClient {
	private token: string | null = null;

	async isConfigured(): Promise<boolean> {
		return Boolean(await readSetting('tvdb_api_key'));
	}

	private async authenticate(): Promise<string | null> {
		const apiKey = await readSetting('tvdb_api_key');
		if (!apiKey) return null;

		const fingerprint = `${apiKey.length}:${apiKey.slice(-4)}`;
		if (
			cache &&
			cache.apiKeyFingerprint === fingerprint &&
			Date.now() - cache.obtainedAt < TOKEN_TTL_MS
		) {
			return cache.token;
		}

		const pin = await readSetting('tvdb_api_pin');
		const body: Record<string, string> = { apikey: apiKey };
		if (pin) body.pin = pin;

		const response = await fetch(`${BASE}/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});

		if (!response.ok) {
			logger.warn({ status: response.status }, '[Tvdb] Login failed');
			return null;
		}

		const payload = (await response.json()) as { data?: { token?: string } };
		const token = payload.data?.token ?? null;
		if (!token) {
			logger.warn('[Tvdb] Login returned no token');
			return null;
		}

		cache = { token, apiKeyFingerprint: fingerprint, obtainedAt: Date.now() };
		this.token = token;
		return token;
	}

	/**
	 * Series broadcast schedule, or null when TVDB has none. Never throws: a
	 * missing schedule is not an error for a backfill that runs over a library.
	 */
	async getSeriesSchedule(tvdbId: number): Promise<SeriesSchedule | null> {
		const token = this.token ?? (await this.authenticate());
		if (!token) return null;

		try {
			const response = await fetch(`${BASE}/series/${tvdbId}/extended`, {
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});

			if (response.status === 401) {
				cache = null;
				this.token = null;
				const refreshed = await this.authenticate();
				if (!refreshed) return null;
				return this.getSeriesSchedule(tvdbId);
			}

			if (!response.ok) {
				logger.debug({ tvdbId, status: response.status }, '[Tvdb] Series lookup failed');
				return null;
			}

			const payload = (await response.json()) as {
				data?: {
					airsTime?: string | null;
					airsDays?: Record<string, boolean> | null;
					originalNetwork?: { name?: string; country?: string } | null;
					originalCountry?: string | null;
				};
			};

			const data = payload.data;
			if (!data) return null;

			const airsDays = Object.entries(data.airsDays ?? {})
				.filter(([, active]) => active)
				.map(([day]) => day);

			return {
				airTime: normalizeTime(data.airsTime),
				airsDays,
				country: data.originalNetwork?.country ?? data.originalCountry ?? null,
				network: data.originalNetwork?.name ?? null
			};
		} catch (error) {
			logger.warn({ err: error, tvdbId }, '[Tvdb] Series lookup threw');
			return null;
		}
	}
}

/** TVDB returns `21:00` or `9:00 PM`; normalise to 24-hour `HH:MM`. */
function normalizeTime(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();

	const twentyFour = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
	if (twentyFour) {
		const hours = Number(twentyFour[1]);
		const minutes = Number(twentyFour[2]);
		if (hours > 23 || minutes > 59) return null;
		return `${String(hours).padStart(2, '0')}:${twentyFour[2]}`;
	}

	const twelve = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/.exec(trimmed);
	if (twelve) {
		let hours = Number(twelve[1]) % 12;
		if (twelve[3].toLowerCase() === 'pm') hours += 12;
		return `${String(hours).padStart(2, '0')}:${twelve[2]}`;
	}

	return null;
}

/**
 * Country → representative timezone. TVDB gives a country, not a zone, and a
 * country can span several (the US has four). This is the documented default;
 * `series.air_tz` is per-series so a wrong guess can be corrected without code.
 */
const COUNTRY_TIMEZONES: Record<string, string> = {
	usa: 'America/New_York',
	can: 'America/Toronto',
	mex: 'America/Mexico_City',
	bra: 'America/Sao_Paulo',
	arg: 'America/Argentina/Buenos_Aires',
	gbr: 'Europe/London',
	irl: 'Europe/Dublin',
	fra: 'Europe/Paris',
	deu: 'Europe/Berlin',
	esp: 'Europe/Madrid',
	ita: 'Europe/Rome',
	nld: 'Europe/Amsterdam',
	bel: 'Europe/Brussels',
	che: 'Europe/Zurich',
	aut: 'Europe/Vienna',
	swe: 'Europe/Stockholm',
	nor: 'Europe/Oslo',
	dnk: 'Europe/Copenhagen',
	fin: 'Europe/Helsinki',
	pol: 'Europe/Warsaw',
	prt: 'Europe/Lisbon',
	rus: 'Europe/Moscow',
	jpn: 'Asia/Tokyo',
	kor: 'Asia/Seoul',
	chn: 'Asia/Shanghai',
	hkg: 'Asia/Hong_Kong',
	sgp: 'Asia/Singapore',
	ind: 'Asia/Kolkata',
	aus: 'Australia/Sydney',
	nzl: 'Pacific/Auckland',
	zaf: 'Africa/Johannesburg'
};

export function timezoneForCountry(country: string | null | undefined): string | null {
	if (!country) return null;
	return COUNTRY_TIMEZONES[country.toLowerCase()] ?? null;
}

export const tvdbClient = new TvdbClient();
