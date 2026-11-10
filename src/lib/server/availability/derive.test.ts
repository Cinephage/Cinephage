import { describe, expect, it } from 'vitest';
import { deriveAvailability, firstDownloadableDate, isSearchable, windowsFrom } from './derive.js';
import type { ReleaseEvent, ReleaseKind } from './types.js';

function event(kind: ReleaseKind, releaseDate: string): ReleaseEvent {
	return {
		id: `${kind}-${releaseDate}`,
		mediaType: 'movie',
		mediaId: 'm1',
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

const TODAY = '2026-06-01';

describe('deriveAvailability', () => {
	it('reports announced when nothing is known', () => {
		const result = deriveAvailability({
			events: [],
			hasFile: false,
			minimumAvailability: 'released',
			today: TODAY
		});
		expect(result.level).toBe('announced');
		expect(result.nextActionableAt).toBeNull();
	});

	it('reports announced for a future theatrical date', () => {
		const result = deriveAvailability({
			events: [event('theatrical', '2026-09-01')],
			hasFile: false,
			minimumAvailability: 'released',
			today: TODAY
		});
		expect(result.level).toBe('announced');
	});

	it('reports inCinemas when theatrical passed but digital has not', () => {
		const result = deriveAvailability({
			events: [event('theatrical', '2026-05-01'), event('digital', '2026-08-01')],
			hasFile: false,
			minimumAvailability: 'released',
			today: TODAY
		});
		expect(result.level).toBe('inCinemas');
		expect(result.nextActionableAt).toBe('2026-08-01');
	});

	it('reports released once a downloadable window has passed', () => {
		const result = deriveAvailability({
			events: [event('theatrical', '2026-01-01'), event('digital', '2026-04-01')],
			hasFile: false,
			minimumAvailability: 'released',
			today: TODAY
		});
		expect(result.level).toBe('released');
		expect(result.nextActionableAt).toBeNull();
	});

	it('treats theatrical as non-downloadable: it never makes a title released', () => {
		const result = deriveAvailability({
			events: [event('theatrical', '2026-05-01')],
			hasFile: false,
			minimumAvailability: 'released',
			today: TODAY
		});
		expect(result.level).toBe('inCinemas');
	});

	it('honours hasFile over every date', () => {
		const result = deriveAvailability({
			events: [event('theatrical', '2027-01-01')],
			hasFile: true,
			minimumAvailability: 'released',
			today: TODAY
		});
		expect(result.level).toBe('released');
	});

	it('picks the earliest future downloadable as the next actionable moment', () => {
		const result = deriveAvailability({
			events: [
				event('physical', '2026-12-01'),
				event('digital', '2026-07-01'),
				event('tv', '2026-09-01')
			],
			hasFile: false,
			minimumAvailability: 'released',
			today: TODAY
		});
		expect(result.nextActionableAt).toBe('2026-07-01');
	});
});

describe('isSearchable', () => {
	const future = [event('theatrical', '2026-09-01')];

	it('never searches an unreleased title at minimumAvailability=released', () => {
		expect(
			isSearchable({
				events: future,
				hasFile: false,
				minimumAvailability: 'released',
				today: TODAY
			})
		).toBe(false);
	});

	it('searches from theatrical when the minimum is inCinemas', () => {
		expect(
			isSearchable({
				events: [event('theatrical', '2026-05-01')],
				hasFile: false,
				minimumAvailability: 'inCinemas',
				today: TODAY
			})
		).toBe(true);
	});

	it('does not search before theatrical when the minimum is inCinemas', () => {
		expect(
			isSearchable({
				events: future,
				hasFile: false,
				minimumAvailability: 'inCinemas',
				today: TODAY
			})
		).toBe(false);
	});

	it('always searches when the minimum is announced', () => {
		expect(
			isSearchable({ events: [], hasFile: false, minimumAvailability: 'announced', today: TODAY })
		).toBe(true);
	});
});

describe('projections', () => {
	const events = [
		event('theatrical', '2026-05-01'),
		event('theatrical', '2026-05-15'),
		event('digital', '2026-07-01'),
		event('physical', '2026-09-01')
	];

	it('takes the earliest date per window', () => {
		expect(windowsFrom(events)).toEqual({
			theatrical: '2026-05-01',
			digital: '2026-07-01',
			physical: '2026-09-01',
			tv: null
		});
	});

	it('ignores theatrical when computing the first downloadable date', () => {
		expect(firstDownloadableDate(events)).toBe('2026-07-01');
	});

	it('returns null when only theatrical events exist', () => {
		expect(firstDownloadableDate([event('theatrical', '2026-05-01')])).toBeNull();
	});
});
