import { createChildLogger } from '#lib/logging/index.js';
import { RateGate } from './rate-gate.js';
import type {
	MusicArtistDetail,
	MusicArtistRef,
	MusicRelease,
	MusicReleaseGroup,
	MusicReleaseSummary,
	MusicTrack
} from './types.js';

const logger = createChildLogger({ module: 'MusicBrainzClient', logDomain: 'system' });

const BASE_URL = 'https://musicbrainz.org/ws/2';

/**
 * MusicBrainz blocks generic agents and asks for a contact URL, so the agent
 * is a constant here rather than the app's configurable one.
 */
const USER_AGENT = 'Cinephage/0.1.0 ( https://github.com/Cinephage/Cinephage )';

/**
 * Published limit is 1 req/s. Measured in practice: spacing at 1.1 s still
 * drew a 503 on the second call, because their window is not the same second
 * boundary the client sees — 1.2 s plus a retry is what actually holds.
 */
const MIN_INTERVAL_MS = 1200;

/** Attempts per request. MusicBrainz documents 503 as "slow down", not "failed". */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1500;
const RETRY_MAX_MS = 8000;

/** MusicBrainz errors answer 200 with an `error` field, or 503 when throttled. */
export class MusicBrainzError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly retryable: boolean = false,
		/** From a Retry-After header, when the server bothers to send one. */
		readonly retryAfterMs?: number
	) {
		super(message);
		this.name = 'MusicBrainzError';
	}
}

interface ArtistCredit {
	name?: string | null;
	artist?: { id?: string | null; name?: string | null; 'sort-name'?: string | null } | null;
}

interface RawTrack {
	number?: string | null;
	title?: string | null;
	length?: number | null;
	recording?: { id?: string | null } | null;
	'artist-credit'?: ArtistCredit[] | null;
}

interface RawMedium {
	position?: number | null;
	format?: string | null;
	'track-count'?: number | null;
	tracks?: RawTrack[] | null;
}

interface RawRelease {
	id?: string | null;
	title?: string | null;
	status?: string | null;
	country?: string | null;
	barcode?: string | null;
	packaging?: string | null;
	date?: string | null;
	'label-info'?: Array<{
		label?: { name?: string | null } | null;
		'catalog-number'?: string | null;
	}> | null;
	media?: RawMedium[] | null;
	'artist-credit'?: ArtistCredit[] | null;
}

interface RawReleaseGroup {
	id?: string | null;
	title?: string | null;
	'primary-type'?: string | null;
	'secondary-types'?: string[] | null;
	'first-release-date'?: string | null;
	score?: number | null;
	'artist-credit'?: ArtistCredit[] | null;
}

export interface MusicBrainzClientOptions {
	fetchImpl?: typeof fetch;
	userAgent?: string;
	minIntervalMs?: number;
	timeoutMs?: number;
	maxAttempts?: number;
	/** Injectable for tests; production uses the real clock. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface ReleaseGroupSearchOptions {
	/** Artist name as typed by the user; matched loosely, MusicBrainz ranks the result. */
	artist?: string;
	/** Album title as typed by the user. */
	album: string;
	limit?: number;
}

/** `year` from an ISO date prefix, never guessed from anything else. */
function yearOf(date: string | null | undefined): number | null {
	const match = /^(\d{4})/.exec(date ?? '');
	return match ? Number(match[1]) : null;
}

/** Lucene syntax: quotes and backslashes would otherwise break the query. */
function escapeLucene(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function artistOf(credits: ArtistCredit[] | null | undefined): MusicArtistRef | null {
	const first = credits?.[0];
	const mbid = first?.artist?.id;
	const name = first?.artist?.name ?? first?.name;
	if (!mbid || !name) return null;
	return { mbid, name, sortName: first?.artist?.['sort-name'] ?? null };
}

function artistCreditOf(credits: ArtistCredit[] | null | undefined): string | null {
	const names = (credits ?? [])
		.map((credit) => credit.name)
		.filter((name): name is string => !!name);
	return names.length > 0 ? names.join(', ') : null;
}

/**
 * Pick the edition to track when a release group has several. Preference:
 * an official release, then the earliest one — a deluxe re-issue should not
 * become the primary edition just because it was listed first.
 */
export function pickPrimaryRelease<T extends { status?: string | null; date?: string | null }>(
	releases: T[]
): T | null {
	if (releases.length === 0) return null;
	const official = releases.filter((release) => release.status === 'Official');
	const pool = official.length > 0 ? official : releases;
	return [...pool].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'))[0];
}

export class MusicBrainzClient {
	private readonly fetchImpl: typeof fetch;
	private readonly userAgent: string;
	private readonly timeoutMs: number;
	private readonly maxAttempts: number;
	private readonly gate: RateGate;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(options: MusicBrainzClientOptions = {}) {
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.userAgent = options.userAgent ?? USER_AGENT;
		this.timeoutMs = options.timeoutMs ?? 15_000;
		this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.gate = new RateGate(options.minIntervalMs ?? MIN_INTERVAL_MS, options.now, options.sleep);
	}

	/**
	 * One attempt. Separated from the retry loop so the gate is taken for every
	 * attempt — a retry must not jump the queue it was throttled for.
	 */
	private async send<T>(url: string): Promise<T> {
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
				signal: AbortSignal.timeout(this.timeoutMs)
			});
		} catch (err) {
			throw new MusicBrainzError(
				`MusicBrainz request failed: ${err instanceof Error ? err.message : String(err)}`,
				undefined,
				true
			);
		}

		const retryAfterMs = this.retryAfterMs(response);
		if (response.status === 429 || response.status === 503) {
			logger.warn({ status: response.status }, '[MusicBrainz] throttled; backing off and retrying');
			throw new MusicBrainzError(
				`MusicBrainz throttled the request (${response.status})`,
				response.status,
				true,
				retryAfterMs
			);
		}
		if (!response.ok) {
			throw new MusicBrainzError(
				`MusicBrainz answered ${response.status}`,
				response.status,
				response.status >= 500,
				retryAfterMs
			);
		}

		const body = (await response.json()) as T & { error?: string };
		// A throttled MusicBrainz can also answer 200 with an error body and no result key.
		if (body && typeof body === 'object' && typeof body.error === 'string') {
			throw new MusicBrainzError(`MusicBrainz: ${body.error}`, response.status, true);
		}
		return body;
	}

	private retryAfterMs(response: Response): number | undefined {
		const header = response.headers.get('retry-after');
		if (!header) return undefined;
		const seconds = Number(header);
		return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
	}

	private async request<T>(path: string, params: Record<string, string>): Promise<T> {
		const url = `${BASE_URL}${path}?${new URLSearchParams({ fmt: 'json', ...params })}`;

		let lastError: MusicBrainzError | undefined;
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			await this.gate.wait();
			try {
				return await this.send<T>(url);
			} catch (err) {
				const error =
					err instanceof MusicBrainzError
						? err
						: new MusicBrainzError(
								err instanceof Error ? err.message : String(err),
								undefined,
								true
							);
				lastError = error;
				if (!error.retryable || attempt === this.maxAttempts) throw error;

				const backoff = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
				await this.sleep(Math.max(backoff, error.retryAfterMs ?? 0));
			}
		}
		throw lastError ?? new MusicBrainzError('MusicBrainz request failed');
	}

	/** Search release groups by artist and/or album title, best match first. */
	async searchReleaseGroups(options: ReleaseGroupSearchOptions): Promise<MusicReleaseGroup[]> {
		const clauses: string[] = [];
		if (options.artist?.trim()) clauses.push(`artist:"${escapeLucene(options.artist.trim())}"`);
		if (options.album?.trim()) clauses.push(`releasegroup:"${escapeLucene(options.album.trim())}"`);

		const body = await this.request<{ 'release-groups'?: RawReleaseGroup[] }>('/release-group', {
			query: clauses.join(' AND '),
			limit: String(options.limit ?? 25)
		});

		return (body['release-groups'] ?? []).flatMap((group) => {
			const artist = artistOf(group['artist-credit']);
			if (!group.id || !group.title || !artist) return [];
			return [
				{
					mbid: group.id,
					title: group.title,
					primaryType: group['primary-type'] ?? null,
					secondaryTypes: group['secondary-types'] ?? [],
					firstReleaseDate: group['first-release-date'] ?? null,
					year: yearOf(group['first-release-date']),
					artist,
					score: typeof group.score === 'number' ? group.score : undefined
				} satisfies MusicReleaseGroup
			];
		});
	}

	/** Every edition that belongs to a release group, in MusicBrainz order. */
	async getReleaseGroupReleases(releaseGroupMbid: string): Promise<MusicReleaseSummary[]> {
		const body = await this.request<{ releases?: RawRelease[] }>('/release', {
			'release-group': releaseGroupMbid,
			inc: 'media',
			limit: '100'
		});
		return (body.releases ?? []).flatMap((release) => {
			if (!release.id) return [];
			const trackCount = (release.media ?? []).reduce(
				(total, medium) => total + (medium['track-count'] ?? 0),
				0
			);
			return [
				{
					mbid: release.id,
					title: release.title ?? 'Untitled',
					status: release.status ?? null,
					date: release.date ?? null,
					year: yearOf(release.date),
					country: release.country ?? null,
					trackCount
				} satisfies MusicReleaseSummary
			];
		});
	}

	/**
	 * One release with its full tracklist. `recordings` is what makes titles,
	 * lengths and recording ids arrive in the same call — without it the tracks
	 * come back as stubs with no title.
	 */
	async getRelease(releaseMbid: string): Promise<MusicRelease> {
		// A lookup by MBID answers the entity itself; only a *search* wraps its
		// results in `{ releases: [...] }`. Accept both so callers never have to
		// know which endpoint produced the release.
		const body = await this.request<{ releases?: RawRelease[] } & RawRelease>(
			`/release/${releaseMbid}`,
			{
				inc: 'recordings+artist-credits+labels'
			}
		);
		const release = body.releases?.[0] ?? body;
		if (!release?.id) throw new MusicBrainzError(`Release ${releaseMbid} not found`, 404, false);

		const tracks: MusicTrack[] = [];
		let position = 0;
		let duration = 0;
		for (const medium of release.media ?? []) {
			const discNumber = medium.position ?? 1;
			for (const track of medium.tracks ?? []) {
				position += 1;
				const seconds = typeof track.length === 'number' ? Math.round(track.length / 1000) : null;
				if (seconds) duration += seconds;
				tracks.push({
					recordingMbid: track.recording?.id ?? null,
					title: track.title ?? 'Untitled',
					artistCredit: artistCreditOf(track['artist-credit']),
					discNumber,
					trackNumber: /^\d+$/.test(track.number ?? '') ? Number(track.number) : null,
					position,
					duration: seconds
				});
			}
		}

		const labelInfo = release['label-info']?.[0];
		return {
			mbid: release.id ?? releaseMbid,
			title: release.title ?? 'Untitled',
			status: release.status ?? null,
			country: release.country ?? null,
			barcode: release.barcode ?? null,
			packaging: release.packaging ?? null,
			labelName: labelInfo?.label?.name ?? null,
			catalogNumber: labelInfo?.['catalog-number'] ?? null,
			date: release.date ?? null,
			year: yearOf(release.date),
			mediaCount: release.media?.length ?? 0,
			trackCount: tracks.length,
			duration,
			tracks
		};
	}

	async getArtist(artistMbid: string): Promise<MusicArtistDetail> {
		const body = await this.request<{
			id?: string;
			name?: string;
			'sort-name'?: string;
			disambiguation?: string;
			type?: string;
			country?: string;
			genres?: Array<{ name?: string | null }>;
		}>(`/artist/${artistMbid}`, { inc: 'genres' });

		if (!body.id || !body.name)
			throw new MusicBrainzError(`Artist ${artistMbid} not found`, 404, false);
		return {
			mbid: body.id,
			name: body.name,
			sortName: body['sort-name'] ?? null,
			disambiguation: body.disambiguation ?? null,
			type: body.type ?? null,
			country: body.country ?? null,
			genres: (body.genres ?? []).flatMap((genre) => (genre.name ? [genre.name] : []))
		};
	}

	/**
	 * Front cover for a release. The Archive answers a 307 to the real image
	 * file, so callers that store the artwork must follow redirects.
	 */
	coverArtUrl(releaseMbid: string, size: 250 | 500 | 1200 = 500): string {
		return `https://coverartarchive.org/release/${releaseMbid}/front-${size}`;
	}
}

/**
 * One client for the process: the rate gate has to be shared, otherwise each
 * caller gets its own 1 req/s budget and MusicBrainz throttles all of them.
 */
export const musicBrainz = new MusicBrainzClient();
