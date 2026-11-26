import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseEvent, ReleaseKind } from '#lib/server/availability/types.js';

const mocks = vi.hoisted(() => ({ events: new Map<string, ReleaseEvent[]>() }));

vi.mock('#lib/server/db/index.js', () => ({ db: {}, sqlite: {}, initializeDatabase: vi.fn() }));
vi.mock('#lib/server/tmdb.js', () => ({ tmdb: {} }));
vi.mock('#lib/server/availability/event-store.js', () => ({
	listEvents: vi.fn(async (_type: string, id: string) => mocks.events.get(id) ?? []),
	listEventsForMany: vi.fn(async (_type: string, ids: string[]) => {
		const byId = new Map<string, ReleaseEvent[]>();
		for (const id of ids) {
			const events = mocks.events.get(id);
			if (events) byId.set(id, events);
		}
		return byId;
	}),
	upsertEvents: vi.fn(),
	pruneEvents: vi.fn()
}));

import {
	computeMissingMovieAvailabilityCounts,
	enrichMoviesWithAvailability
} from './movie-availability.js';

function event(mediaId: string, kind: ReleaseKind, releaseDate: string): ReleaseEvent {
	return {
		id: `${mediaId}-${kind}-${releaseDate}`,
		mediaType: 'movie',
		mediaId,
		kind,
		region: 'US',
		platform: null,
		releaseDate,
		releaseTime: null,
		timezone: null,
		source: 'tmdb',
		sourceId: null,
		confidence: 'confirmed',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z'
	};
}

function daysAgo(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

const currentYear = new Date().getFullYear();

function row(id: string, year: number) {
	return { id, tmdbId: 1, year, added: null, monitored: true, minimumAvailability: 'released' };
}

describe('dashboard movie availability', () => {
	beforeEach(() => {
		mocks.events.clear();
	});

	it('treats an old film with no release events as released (year fallback)', async () => {
		const [movie] = await enrichMoviesWithAvailability([row('old-no-events', 1982)]);
		expect(movie.availability).toBe('released');
		expect(movie.isReleased).toBe(true);
	});

	it('treats an old film listed only with its cinema release as released (90-day grace)', async () => {
		mocks.events.set('old-theatrical', [event('old-theatrical', 'theatrical', '1982-12-10')]);
		const [movie] = await enrichMoviesWithAvailability([row('old-theatrical', 1982)]);
		expect(movie.availability).toBe('released');
		expect(movie.isReleased).toBe(true);
	});

	it('keeps a film that opened in cinemas 10 days ago as in cinemas', async () => {
		mocks.events.set('in-cinemas', [event('in-cinemas', 'theatrical', daysAgo(10))]);
		const [movie] = await enrichMoviesWithAvailability([row('in-cinemas', currentYear)]);
		expect(movie.availability).toBe('inCinemas');
		expect(movie.isReleased).toBe(false);
	});

	it('keeps a current-year film with no release events as not released', async () => {
		const [movie] = await enrichMoviesWithAvailability([row('new-no-events', currentYear)]);
		expect(movie.availability).toBe('announced');
		expect(movie.isReleased).toBe(false);
	});

	it('counts old films as released missing, not unreleased, in the stats', async () => {
		mocks.events.set('old-theatrical', [event('old-theatrical', 'theatrical', '1982-12-10')]);
		mocks.events.set('in-cinemas', [event('in-cinemas', 'theatrical', daysAgo(10))]);
		const counts = await computeMissingMovieAvailabilityCounts([
			row('old-no-events', 1983),
			row('old-theatrical', 1982),
			row('in-cinemas', currentYear),
			row('new-no-events', currentYear)
		]);
		expect(counts.monitoredReleasedMissing).toBe(2);
		expect(counts.monitoredUnreleased).toBe(2);
	});
});
