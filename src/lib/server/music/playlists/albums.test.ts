import { describe, expect, it } from 'vitest';
import { fillMissingAlbums, type TrackSearch } from './albums.js';
import type { PlaylistTrack } from './types.js';

function track(overrides: Partial<PlaylistTrack> = {}): PlaylistTrack {
	return {
		title: 'One More Time',
		artists: ['Daft Punk'],
		album: null,
		year: null,
		durationMs: null,
		isrc: null,
		...overrides
	};
}

interface Hit {
	title?: string;
	artist?: { name?: string };
	album?: { title?: string };
}

function catalog(handler: (query: string) => Hit[]): { api: TrackSearch; queries: string[] } {
	const queries: string[] = [];
	return {
		queries,
		api: {
			async search<T>(_kind: 'track', query: string): Promise<T[]> {
				queries.push(query);
				return handler(query) as T[];
			}
		}
	};
}

const DISCOVERY: Hit = {
	title: 'One More Time',
	artist: { name: 'Daft Punk' },
	album: { title: 'Discovery' }
};

describe('fillMissingAlbums', () => {
	it('takes the album from a hit that is the same song by the same act', async () => {
		const { api } = catalog(() => [DISCOVERY]);
		const result = await fillMissingAlbums([track()], api);

		expect(result.filled).toBe(1);
		expect(result.tracks[0].album).toBe('Discovery');
		// The pasted entry is what the preview shows; only the album is added.
		expect(result.tracks[0].title).toBe('One More Time');
		expect(result.tracks[0].artists).toEqual(['Daft Punk']);
	});

	it('matches a decorated title, because the decoration is not the work', async () => {
		const { api } = catalog(() => [
			{ title: 'One More Time (Remastered 2011)', artist: { name: 'Daft Punk' }, album: { title: 'Discovery' } }
		]);
		const result = await fillMissingAlbums([track()], api);
		expect(result.tracks[0].album).toBe('Discovery');
	});

	it('leaves the album empty when the only hit is a different act', async () => {
		const { api } = catalog(() => [
			{ title: 'One More Time', artist: { name: 'Some Tribute Band' }, album: { title: 'Tribute to Daft Punk' } }
		]);
		const result = await fillMissingAlbums([track()], api);
		expect(result.filled).toBe(0);
		expect(result.tracks[0].album).toBeNull();
	});

	it('leaves the album empty when the only hit is a different work', async () => {
		const { api } = catalog(() => [
			{ title: 'One More Time (Short Radio Edit)', artist: { name: 'Daft Punk' }, album: { title: 'One More Time' } }
		]);
		// The bracketed tail is a version tag, so this is the same work — but a
		// genuinely different title must not be taken.
		const result = await fillMissingAlbums([track({ title: 'Around the World' })], api);
		expect(result.filled).toBe(0);
		expect(result.tracks[0].album).toBeNull();
	});

	it('does not ask the catalog for a track that already has an album', async () => {
		const { api, queries } = catalog(() => [DISCOVERY]);
		const result = await fillMissingAlbums([track({ album: 'Discovery' })], api);
		expect(queries).toHaveLength(0);
		expect(result.filled).toBe(0);
	});

	it('keeps the playlist intact when the catalog fails', async () => {
		const api: TrackSearch = {
			async search(): Promise<never[]> {
				throw new Error('deezer is down');
			}
		};
		const tracks = [track(), track({ title: 'Get Lucky' })];
		const result = await fillMissingAlbums(tracks, api);

		expect(result.filled).toBe(0);
		expect(result.tracks).toEqual(tracks);
	});

	it('bounds how many lookups are in flight', async () => {
		let inFlight = 0;
		let peak = 0;
		const api: TrackSearch = {
			async search<T>(_kind: 'track', query: string): Promise<T[]> {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight -= 1;
				const title = /track:"([^"]*)"/.exec(query)?.[1] ?? '';
				return [{ title, artist: { name: 'Daft Punk' }, album: { title: 'Discovery' } }] as T[];
			}
		};
		const tracks = Array.from({ length: 8 }, (_, index) => track({ title: `Song ${index}` }));
		const result = await fillMissingAlbums(tracks, api, { concurrency: 2 });

		expect(result.filled).toBe(8);
		expect(peak).toBeLessThanOrEqual(2);
	});

	it('does not ask for a track with no artist to verify against', async () => {
		const { api, queries } = catalog(() => [DISCOVERY]);
		const result = await fillMissingAlbums([track({ artists: [] })], api);
		expect(queries).toHaveLength(0);
		expect(result.filled).toBe(0);
	});
});
