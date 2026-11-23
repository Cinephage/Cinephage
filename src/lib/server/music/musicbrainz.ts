import { createChildLogger } from '#lib/logging/index.js';
import { RateGate } from './rate-gate.js';
import type {
	MusicArtistDetail,
	MusicArtistRef,
	MusicRelease,
	MusicArtistSearchResult,
	MusicRecordingHit,
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
// MusicBrainz blocks an IP for exceeding one request per second *average*;
// a short retry loop is what turns a busy minute into a block, so waits are
// long enough to fall back under the limit.
const RETRY_BASE_MS = 2500;
const RETRY_MAX_MS = 10000;

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
	/** How MusicBrainz joins this credit to the next one (comma, ampersand, ...). */
	joinphrase?: string | null;
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
	/** Present on browse results (`inc=release-groups`); the group an edition belongs to. */
	'release-group'?: {
		id?: string | null;
		title?: string | null;
		'primary-type'?: string | null;
		'secondary-types'?: string[] | null;
		'first-release-date'?: string | null;
	} | null;
}

interface RawReleaseGroup {
	id?: string | null;
	title?: string | null;
	'primary-type'?: string | null;
	'secondary-types'?: string[] | null;
	'first-release-date'?: string | null;
	score?: number | null;
	'artist-credit'?: ArtistCredit[] | null;
	genres?: Array<{ name?: string | null }> | null;
}

interface RawArtist {
	id?: string | null;
	name?: string | null;
	'sort-name'?: string | null;
	disambiguation?: string | null;
	type?: string | null;
	country?: string | null;
	score?: number | null;
}

interface RawRecording {
	id?: string | null;
	title?: string | null;
	length?: number | null;
	score?: number | null;
	'artist-credit'?: ArtistCredit[] | null;
	releases?: Array<{
		id?: string | null;
		title?: string | null;
		status?: string | null;
		date?: string | null;
		/** Whose release this is; a Various Artists compilation is not the artist's album. */
		'artist-credit'?: ArtistCredit[] | null;
		'release-group'?: {
			id?: string | null;
			title?: string | null;
			'primary-type'?: string | null;
			'secondary-types'?: string[] | null;
			'first-release-date'?: string | null;
		} | null;
	}> | null;
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
	album?: string;
	/** Join artist and title with OR instead of AND — a one-box search that
	 *  should hit either field, ranked by MusicBrainz relevance. */
	matchAny?: boolean;
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
	const named = (credits ?? []).filter(
		(credit): credit is ArtistCredit & { name: string } => !!credit.name
	);
	if (named.length === 0) return null;
	// Respect the credit as written: three collaborators are one credit, not
	// three artists comma-joined into a different-looking string.
	return named
		.map((credit, index) => {
			const join = credit.joinphrase ?? (index < named.length - 1 ? ', ' : '');
			return `${credit.name}${join}`;
		})
		.join('')
		.trim();
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

		if (clauses.length === 0) return [];

		const body = await this.request<{ 'release-groups'?: RawReleaseGroup[] }>('/release-group', {
			query: clauses.join(options.matchAny ? ' OR ' : ' AND '),
			limit: String(options.limit ?? 25)
		});

		return this.mapReleaseGroups(body['release-groups'] ?? []);
	}

	/** A search hit and a batch hit are the same shape, so both map here. */
	private mapReleaseGroups(groups: RawReleaseGroup[]): MusicReleaseGroup[] {
		return groups.flatMap((group) => {
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
					genres: (group.genres ?? []).flatMap((genre) => (genre.name ? [genre.name] : [])),
					score: typeof group.score === 'number' ? group.score : undefined
				} satisfies MusicReleaseGroup
			];
		});
	}


	/** Artist search, used by "find an artist to add" and by interactive search. */
	async searchArtists(query: string, limit = 20): Promise<MusicArtistSearchResult[]> {
		if (!query.trim()) return [];
		const body = await this.request<{ artists?: RawArtist[] }>('/artist', {
			query: `artist:"${escapeLucene(query.trim())}"`,
			limit: String(limit)
		});
		return (body.artists ?? []).flatMap((artist) => {
			if (!artist.id || !artist.name) return [];
			return [
				{
					mbid: artist.id,
					name: artist.name,
					sortName: artist['sort-name'] ?? null,
					disambiguation: artist.disambiguation ?? null,
					type: artist.type ?? null,
					country: artist.country ?? null,
					score: typeof artist.score === 'number' ? artist.score : undefined
				} satisfies MusicArtistSearchResult
			];
		});
	}

	/**
	 * Song search. `arid:` in MusicBrainz matches the *artist credit*, so this
	 * finds a guest appearance as well as the artist's own tracks — measured on
	 * Chris Webby: 29 of the first 100 credited recordings are features.
	 *
	 * Each hit carries the release group it first appeared on, because a song is
	 * never an importable unit on its own: the album is.
	 */
	async searchRecordings(options: {
		artist?: string;
		track?: string;
		limit?: number;
	}): Promise<MusicRecordingHit[]> {
		const clauses: string[] = [];
		if (options.artist?.trim()) clauses.push(`artist:"${escapeLucene(options.artist.trim())}"`);
		if (options.track?.trim()) clauses.push(`recording:"${escapeLucene(options.track.trim())}"`);
		if (clauses.length === 0) return [];

		const body = await this.request<{ recordings?: RawRecording[] }>('/recording', {
			query: clauses.join(' AND '),
			limit: String(options.limit ?? 25)
		});

		return this.mapRecordings(body.recordings ?? []);
	}

	/** A search hit and a batch hit are the same shape, so both map here. */
	private mapRecordings(recordings: RawRecording[]): MusicRecordingHit[] {
		return recordings.flatMap((recording) => {
			if (!recording.id || !recording.title) return [];
			const artists = (recording['artist-credit'] ?? []).flatMap((credit) => {
				const ref =
					credit.artist?.id && credit.artist?.name
						? {
								mbid: credit.artist.id,
								name: credit.artist.name,
								sortName: credit.artist['sort-name'] ?? null
							}
						: null;
				return ref ? [ref] : [];
			});
			// Which release this song "came from". MusicBrainz lists every release
			// carrying the recording, and the first is frequently a Various Artists
			// compilation — importing that instead of the artist's own album is how a
			// song ends up filed under a karaoke disc. Order: credited to the
			// recording's artist, then Official, then the oldest release.
			const credited = new Set(
				(recording['artist-credit'] ?? []).flatMap((credit) =>
					credit.artist?.id ? [credit.artist.id] : []
				)
			);
			const isOwned = (entry: NonNullable<RawRecording['releases']>[number]): boolean =>
				(entry['artist-credit'] ?? []).some(
					(credit) => credit.artist?.id && credited.has(credit.artist.id)
				);
			const scoreRelease = (entry: NonNullable<RawRecording['releases']>[number]): number =>
				(isOwned(entry) ? 2 : 0) + (entry.status === 'Official' ? 1 : 0);
			const releases = (recording.releases ?? [])
				.filter((release) => release['release-group']?.id)
				.sort(
					(a, b) =>
						scoreRelease(b) - scoreRelease(a) ||
						(a.date ?? '9999').localeCompare(b.date ?? '9999')
				);
			const release = releases[0] ?? null;
			const owned = release ? isOwned(release) : false;

			return [
				{
					mbid: recording.id,
					title: recording.title,
					duration:
						typeof recording.length === 'number' ? Math.round(recording.length / 1000) : null,
					artistCredit: artistCreditOf(recording['artist-credit']) ?? '',
					artists,
					releaseGroup: release
						? {
								mbid: release['release-group']!.id!,
								title: release['release-group']!.title ?? '',
								primaryType: release['release-group']!['primary-type'] ?? null,
								secondaryTypes: release['release-group']!['secondary-types'] ?? [],
								firstReleaseDate:
									release['release-group']!['first-release-date'] ?? release.date ?? null,
								artist: artistOf(release['artist-credit'] ?? null)
							}
						: null,
					releaseMbid: release?.id ?? null,
					releaseOwned: owned,
					score: typeof recording.score === 'number' ? recording.score : undefined
				} satisfies MusicRecordingHit
			];
		});
	}


	/**
	 * Every release group an artist owns, paged. Browse (not search) is the right
	 * endpoint here: it is exact by artist id and pages deterministically, which
	 * "add this artist" depends on.
	 */
	async getArtistReleaseGroups(
		artistMbid: string,
		artist: MusicArtistRef,
		options: { limit?: number; offset?: number } = {}
	): Promise<{ releaseGroups: MusicReleaseGroup[]; total: number }> {
		const body = await this.request<{
			'release-groups'?: RawReleaseGroup[];
			'release-group-count'?: number;
		}>(`/release-group`, {
			artist: artistMbid,
			limit: String(Math.min(options.limit ?? 100, 100)),
			offset: String(options.offset ?? 0)
		});

		const releaseGroups = (body['release-groups'] ?? []).flatMap((group) => {
			if (!group.id || !group.title) return [];
			return [
				{
					mbid: group.id,
					title: group.title,
					primaryType: group['primary-type'] ?? null,
					secondaryTypes: group['secondary-types'] ?? [],
					firstReleaseDate: group['first-release-date'] ?? null,
					year: yearOf(group['first-release-date']),
					// A browse by artist id often omits the credit; the caller knows
					// whose page this is, so its ref is the fallback (never a blank name).
					artist: artistOf(group['artist-credit']) ?? artist
				} satisfies MusicReleaseGroup
			];
		});

		return { releaseGroups, total: body['release-group-count'] ?? releaseGroups.length };
	}

	/** One release group by MBID — the album's own metadata, without its editions. */
	async getReleaseGroup(releaseGroupMbid: string): Promise<MusicReleaseGroup> {
		// `artist-credits` is not included by default on a lookup, and without it the
		// entity carries no artist — which read as "not found" on the first live call.
		const body = await this.request<RawReleaseGroup>(`/release-group/${releaseGroupMbid}`, {
			inc: 'artist-credits+genres'
		});
		const artist = artistOf(body['artist-credit']);
		if (!body.id || !body.title || !artist) {
			throw new MusicBrainzError(`Release group ${releaseGroupMbid} not found`, 404, false);
		}
		return {
			mbid: body.id,
			title: body.title,
			primaryType: body['primary-type'] ?? null,
			secondaryTypes: body['secondary-types'] ?? [],
			firstReleaseDate: body['first-release-date'] ?? null,
			year: yearOf(body['first-release-date']),
			artist,
			genres: (body.genres ?? []).flatMap((genre) => (genre.name ? [genre.name] : []))
		};
	}

	/**
	 * The release group and its editions in one request. A release-group lookup
	 * accepts `releases` as a subquery, so a page that needs both does not pay
	 * the rate gate twice. Track counts come back empty here — callers that draw
	 * an edition list use `getReleaseGroupReleases`.
	 */
	async getReleaseGroupWithReleases(releaseGroupMbid: string): Promise<{
		group: MusicReleaseGroup;
		releases: MusicReleaseSummary[];
	}> {
		const body = await this.request<RawReleaseGroup & { releases?: RawRelease[] }>(
			`/release-group/${releaseGroupMbid}`,
			{ inc: 'artist-credits+releases+genres' }
		);
		const artist = artistOf(body['artist-credit']);
		if (!body.id || !body.title || !artist) {
			throw new MusicBrainzError(`Release group ${releaseGroupMbid} not found`, 404, false);
		}
		return {
			group: {
				mbid: body.id,
				title: body.title,
				primaryType: body['primary-type'] ?? null,
				secondaryTypes: body['secondary-types'] ?? [],
				firstReleaseDate: body['first-release-date'] ?? null,
				year: yearOf(body['first-release-date']),
				artist,
				genres: (body.genres ?? []).flatMap((genre) => (genre.name ? [genre.name] : []))
			},
			releases: (body.releases ?? []).flatMap((release) => {
				if (!release.id) return [];
				return [
					{
						mbid: release.id,
						title: release.title ?? 'Untitled',
						status: release.status ?? null,
						date: release.date ?? null,
						year: yearOf(release.date),
						country: release.country ?? null,
						trackCount: 0
					} satisfies MusicReleaseSummary
				];
			})
		};
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

		return this.mapRelease(release, releaseMbid);
	}

	/** Raw release -> the domain shape. The one place a tracklist is built. */
	private mapRelease(release: RawRelease, fallbackMbid: string): MusicRelease {
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
			mbid: release.id ?? fallbackMbid,
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

	/**
	 * The group, one official edition and that edition's tracklist in a single
	 * request — everything adding an album needs.
	 *
	 * The browse endpoint accepts `inc=recordings`, so an import no longer pays
	 * three round trips (group, editions, release) per album; at one request per
	 * second those round trips were most of the wall clock.
	 */
	async getReleaseGroupWithTracklist(
		releaseGroupMbid: string,
		options: { editions?: number } = {}
	): Promise<{ group: MusicReleaseGroup; release: MusicRelease }> {
		const limit = String(Math.max(1, Math.min(options.editions ?? 3, 10)));
		const fetchEditions = (status?: string) =>
			this.request<{ releases?: RawRelease[] }>('/release', {
				...(status ? { status } : {}),
				'release-group': releaseGroupMbid,
				inc: 'recordings+artist-credits+release-groups',
				limit
			});

		// Official editions are what an import wants; a group with none is still
		// importable (a bootleg-only entry), so retry without the filter.
		let body = await fetchEditions('official');
		let editions = (body.releases ?? []).filter((release) => release.id);
		if (editions.length === 0) {
			body = await fetchEditions();
			editions = (body.releases ?? []).filter((release) => release.id);
		}

		const chosen = pickPrimaryRelease(editions);
		if (!chosen?.id) {
			throw new MusicBrainzError(
				`Release group ${releaseGroupMbid} has no editions to import`,
				404,
				false
			);
		}

		const release = this.mapRelease(chosen, chosen.id);
		const rawGroup = chosen['release-group'];
		const artist = artistOf(chosen['artist-credit']);
		if (!rawGroup?.id || !artist) {
			throw new MusicBrainzError(
				`Release ${chosen.id} came back without its group or artist`,
				502,
				false
			);
		}

		return {
			group: {
				mbid: rawGroup.id,
				title: rawGroup.title ?? release.title,
				primaryType: rawGroup['primary-type'] ?? null,
				secondaryTypes: rawGroup['secondary-types'] ?? [],
				firstReleaseDate: rawGroup['first-release-date'] ?? release.date ?? null,
				year: yearOf(rawGroup['first-release-date'] ?? release.date),
				artist
			},
			release
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
