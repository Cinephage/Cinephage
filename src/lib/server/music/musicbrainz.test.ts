import { describe, it, expect, vi } from 'vitest';
import { MusicBrainzClient, MusicBrainzError, pickPrimaryRelease } from './musicbrainz.js';

/**
 * The client is tested against recorded response shapes, not the network: the
 * contract that has to hold is the mapping and the failure classification,
 * because MusicBrainz reports throttling as a 200 with an `error` body.
 */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function clientWith(
	fetchImpl: typeof fetch,
	options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}
) {
	return new MusicBrainzClient({
		fetchImpl,
		now: options.now ?? (() => 0),
		sleep: options.sleep ?? (async () => {}),
		minIntervalMs: 1100
	});
}

const RELEASE_GROUP_HIT = {
	'release-groups': [
		{
			id: '48117b90-a16e-34ca-a514-19c702df1158',
			title: 'Discovery',
			'primary-type': 'Album',
			'secondary-types': [],
			'first-release-date': '2001-02-26',
			score: 100,
			'artist-credit': [
				{
					name: 'Daft Punk',
					artist: {
						id: '056e4f3e-d505-4dad-8ec1-d04f521cbb56',
						name: 'Daft Punk',
						'sort-name': 'Daft Punk'
					}
				}
			]
		},
		{
			// No artist credit: MusicBrainz search results can carry a group with no
			// credited artist, and a row without an artist cannot be stored.
			id: 'orphan-group',
			title: 'Untitled',
			'primary-type': 'Album',
			'first-release-date': '1999'
		}
	]
};

// A lookup by MBID returns the release object itself — this is the real shape,
// and the one that a wrapper-shaped fixture would have hidden.
const RELEASE_DETAIL = {
	id: 'ab5ca495-8983-41b9-86b4-46a981d173be',
	title: 'Discovery',
	status: 'Official',
	country: 'JP',
	barcode: '4988006788367',
	packaging: 'Jewel Case',
	date: '2001-03-10',
	'label-info': [{ label: { name: 'Virgin' }, 'catalog-number': 'VJCP-68283' }],
	media: [
		{
			position: 1,
			format: 'CD',
			'track-count': 2,
			tracks: [
				{
					number: '1',
					title: 'One More Time',
					length: 321400,
					recording: { id: '60fa767a-d85d-4991-82bc-4294e0b11ae7' },
					'artist-credit': [{ name: 'Daft Punk' }]
				},
				{
					number: '2',
					title: 'Aerodynamic',
					length: 207493,
					recording: { id: '7c0e11a3-1c7a-4e6d-a14d-6e86d86dbaad' }
				}
			]
		},
		{
			position: 2,
			format: 'CD',
			'track-count': 1,
			tracks: [{ number: 'A1', title: 'Bonus', length: 60000 }]
		}
	]
};

describe('MusicBrainzClient.searchReleaseGroups', () => {
	it('maps hits and drops a hit with no credited artist', async () => {
		let requested = '';
		const client = clientWith((async (url: string | URL | Request) => {
			requested = String(url);
			return jsonResponse(RELEASE_GROUP_HIT);
		}) as typeof fetch);

		const groups = await client.searchReleaseGroups({ artist: 'Daft Punk', album: 'Discovery' });

		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({
			mbid: '48117b90-a16e-34ca-a514-19c702df1158',
			title: 'Discovery',
			primaryType: 'Album',
			year: 2001,
			score: 100,
			artist: { mbid: '056e4f3e-d505-4dad-8ec1-d04f521cbb56', name: 'Daft Punk' }
		});
		expect(new URL(requested).searchParams.get('query')).toBe(
			'artist:"Daft Punk" AND releasegroup:"Discovery"'
		);
	});

	it('escapes quotes so a title cannot break the Lucene query', async () => {
		let requested = '';
		const client = clientWith((async (url: string | URL | Request) => {
			requested = String(url);
			return jsonResponse({ 'release-groups': [] });
		}) as typeof fetch);

		await client.searchReleaseGroups({ album: 'Say "Hello"' });
		expect(new URL(requested).searchParams.get('query')).toBe('releasegroup:"Say \\"Hello\\""');
	});
});

describe('MusicBrainzClient.searchArtists', () => {
	it('maps artist hits, keeping the disambiguation that separates namesakes', async () => {
		const client = clientWith((async () =>
			jsonResponse({
				artists: [
					{
						id: '4771b7f6-f4e8-4d5d-81c4-4fd3c6accc7c',
						name: 'Chris Webby',
						'sort-name': 'Webby, Chris',
						disambiguation: 'US rapper',
						type: 'Person',
						country: 'US',
						score: 100
					}
				]
			})) as typeof fetch);

		const artists = await client.searchArtists('Chris Webby');

		expect(artists).toHaveLength(1);
		expect(artists[0]).toMatchObject({
			mbid: '4771b7f6-f4e8-4d5d-81c4-4fd3c6accc7c',
			name: 'Chris Webby',
			disambiguation: 'US rapper',
			type: 'Person',
			country: 'US'
		});
	});
});

describe('MusicBrainzClient.searchRecordings', () => {
	it('keeps the release group a song came from, and renders the joined credit', async () => {
		const client = clientWith((async () =>
			jsonResponse({
				recordings: [
					{
						id: 'cd5e530c-9c55-4354-97b2-2d1f85b4cffe',
						title: 'Almost There',
						length: 277000,
						score: 100,
						'artist-credit': [
							{
								joinphrase: ' feat. ',
								name: 'Chris Webby',
								artist: { id: 'artist-webby', name: 'Chris Webby' }
							},
							{ name: 'Miss Daja', artist: { id: 'artist-daja', name: 'Miss Daja' } }
						],
						releases: [
							{
								id: 'release-1',
								title: 'Best in the Burbs',
								status: 'Official',
								date: '2010-06-01',
								'release-group': {
									id: 'rg-best',
									title: 'Best in the Burbs',
									'primary-type': 'Album'
								}
							}
						]
					}
				]
			})) as typeof fetch);

		const hits = await client.searchRecordings({ artist: 'Chris Webby', track: 'Almost There' });

		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({
			mbid: 'cd5e530c-9c55-4354-97b2-2d1f85b4cffe',
			title: 'Almost There',
			duration: 277,
			artistCredit: 'Chris Webby, Miss Daja',
			releaseMbid: 'release-1',
			releaseGroup: { mbid: 'rg-best', title: 'Best in the Burbs', primaryType: 'Album' }
		});
		expect(hits[0].artists.map((artist) => artist.mbid)).toEqual(['artist-webby', 'artist-daja']);
	});

	it('leaves the release group null when a recording has no release to point at', async () => {
		const client = clientWith((async () =>
			jsonResponse({
				recordings: [{ id: 'rec-x', title: 'Orphan', 'artist-credit': [], releases: [] }]
			})) as typeof fetch);

		const hits = await client.searchRecordings({ track: 'Orphan' });
		expect(hits[0].releaseGroup).toBeNull();
		expect(hits[0].releaseMbid).toBeNull();
	});
});

describe('MusicBrainzClient.getArtistReleaseGroups', () => {
	it('browses by artist id and reports the total, falling back to the caller-supplied artist', async () => {
		let requested = '';
		const client = clientWith((async (url: string | URL | Request) => {
			requested = String(url);
			return jsonResponse({
				'release-group-count': 65,
				'release-groups': [
					{
						id: 'rg-1',
						title: 'Best in the Burbs',
						'primary-type': 'Album',
						'secondary-types': ['Mixtape/Street'],
						'first-release-date': '2010-06-01'
					}
				]
			});
		}) as typeof fetch);

		const { releaseGroups, total } = await client.getArtistReleaseGroups(
			'4771b7f6-f4e8-4d5d-81c4-4fd3c6accc7c',
			{ mbid: '4771b7f6-f4e8-4d5d-81c4-4fd3c6accc7c', name: 'Chris Webby' }
		);

		const params = new URL(requested).searchParams;
		expect(params.get('artist')).toBe('4771b7f6-f4e8-4d5d-81c4-4fd3c6accc7c');
		expect(total).toBe(65);
		expect(releaseGroups[0]).toMatchObject({
			mbid: 'rg-1',
			title: 'Best in the Burbs',
			year: 2010,
			secondaryTypes: ['Mixtape/Street'],
			artist: { name: 'Chris Webby' }
		});
	});
});

describe('MusicBrainzClient.getReleaseGroup', () => {
	it('asks for artist credits, without which the entity has no artist', async () => {
		let requested = '';
		const client = clientWith((async (url: string | URL | Request) => {
			requested = String(url);
			return jsonResponse({
				id: '48117b90-a16e-34ca-a514-19c702df1158',
				title: 'Discovery',
				'primary-type': 'Album',
				'first-release-date': '2001-02-26',
				'artist-credit': [
					{
						name: 'Daft Punk',
						artist: { id: '056e4f3e', name: 'Daft Punk', 'sort-name': 'Daft Punk' }
					}
				]
			});
		}) as typeof fetch);

		const group = await client.getReleaseGroup('48117b90-a16e-34ca-a514-19c702df1158');

		expect(new URL(requested).searchParams.get('inc')).toBe('artist-credits');
		expect(group.artist.name).toBe('Daft Punk');
		expect(group.year).toBe(2001);
	});
});

describe('MusicBrainzClient.getRelease', () => {
	it('flattens media into one tracklist with disc-major positions', async () => {
		const client = clientWith((async () => jsonResponse(RELEASE_DETAIL)) as typeof fetch);

		const release = await client.getRelease('ab5ca495-8983-41b9-86b4-46a981d173be');

		expect(release.trackCount).toBe(3);
		expect(release.mediaCount).toBe(2);
		expect(release.duration).toBe(321 + 207 + 60);
		expect(
			release.tracks.map((track) => [track.discNumber, track.trackNumber, track.position])
		).toEqual([
			[1, 1, 1],
			[1, 2, 2],
			[2, null, 3]
		]);
		expect(release).toMatchObject({
			status: 'Official',
			country: 'JP',
			labelName: 'Virgin',
			catalogNumber: 'VJCP-68283',
			year: 2001
		});
	});

	it('treats a 200 with an error body as a retryable failure', async () => {
		const client = clientWith((async () =>
			jsonResponse({
				error: 'Your requests are exceeding the allowable rate limit'
			})) as typeof fetch);

		await expect(client.getRelease('x')).rejects.toBeInstanceOf(MusicBrainzError);
		await expect(client.getRelease('x')).rejects.toMatchObject({ retryable: true });
	});

	it('marks 5xx retryable and 404 terminal', async () => {
		const server = clientWith((async () => jsonResponse({}, 503)) as typeof fetch);
		await expect(server.getRelease('x')).rejects.toMatchObject({ retryable: true, status: 503 });

		const missing = clientWith((async () => jsonResponse({}, 404)) as typeof fetch);
		await expect(missing.getRelease('x')).rejects.toMatchObject({ retryable: false, status: 404 });
	});

	it('sends a User-Agent that identifies the app', async () => {
		let headers: Record<string, string> = {};
		const client = clientWith((async (_url: string | URL | Request, init?: RequestInit) => {
			headers = init?.headers as Record<string, string>;
			return jsonResponse(RELEASE_DETAIL);
		}) as typeof fetch);

		await client.getRelease('x');
		expect(headers['User-Agent']).toContain('Cinephage');
	});
});

describe('MusicBrainzClient retry', () => {
	it('retries a 503 after backing off, and succeeds on the next attempt', async () => {
		const slept: number[] = [];
		let calls = 0;
		const client = clientWith(
			(async () => {
				calls += 1;
				return calls === 1 ? jsonResponse({}, 503) : jsonResponse(RELEASE_DETAIL);
			}) as typeof fetch,
			{ sleep: async (ms: number) => void slept.push(ms) }
		);

		const release = await client.getRelease('ab5ca495-8983-41b9-86b4-46a981d173be');

		expect(release.title).toBe('Discovery');
		expect(calls).toBe(2);
		// The gate's own spacing is asserted separately; here the backoff is what matters.
		expect(slept).toContain(1500);
	});

	it('honours Retry-After over the internal backoff', async () => {
		const slept: number[] = [];
		let calls = 0;
		const client = clientWith(
			(async () => {
				calls += 1;
				if (calls > 1) return jsonResponse(RELEASE_DETAIL);
				return new Response('{}', { status: 503, headers: { 'retry-after': '4' } });
			}) as typeof fetch,
			{ sleep: async (ms: number) => void slept.push(ms) }
		);

		await client.getRelease('x');
		expect(slept).toContain(4000);
	});

	it('gives up after the attempt budget and reports the last failure', async () => {
		let calls = 0;
		const client = clientWith((async () => {
			calls += 1;
			return jsonResponse({}, 503);
		}) as typeof fetch);

		await expect(client.getRelease('x')).rejects.toMatchObject({ status: 503, retryable: true });
		expect(calls).toBe(3);
	});
});

describe('MusicBrainzClient rate gate', () => {
	it('spaces request slots by the interval, not by response time', async () => {
		const slept: number[] = [];
		let clock = 0;
		const client = clientWith((async () => jsonResponse(RELEASE_GROUP_HIT)) as typeof fetch, {
			now: () => clock,
			sleep: async (ms: number) => {
				slept.push(ms);
				clock += ms;
			}
		});

		await client.searchReleaseGroups({ album: 'a' });
		await client.searchReleaseGroups({ album: 'b' });
		await client.searchReleaseGroups({ album: 'c' });

		// First call is free; the next two each wait one interval.
		expect(slept).toEqual([1100, 1100]);
	});
});

describe('pickPrimaryRelease', () => {
	it('prefers an official release and then the earliest date', () => {
		const picked = pickPrimaryRelease([
			{ status: 'Bootleg', date: '2001-01-01' },
			{ status: 'Official', date: '2005-01-01' },
			{ status: 'Official', date: '2001-03-10' }
		]);
		expect(picked).toEqual({ status: 'Official', date: '2001-03-10' });
	});

	it('falls back to the earliest of whatever exists', () => {
		expect(pickPrimaryRelease([{ status: 'Promotion', date: '2003' }])).toEqual({
			status: 'Promotion',
			date: '2003'
		});
		expect(pickPrimaryRelease([])).toBeNull();
	});
});
