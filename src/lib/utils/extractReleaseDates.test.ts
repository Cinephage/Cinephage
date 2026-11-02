import { describe, it, expect } from 'vitest';
import { extractReleaseDates } from './extractReleaseDates.js';
import type { ReleaseDatesResponse } from '#lib/types/tmdb.js';

describe('extractReleaseDates', () => {
	const mkResponse = (results: ReleaseDatesResponse['results']): ReleaseDatesResponse => ({
		id: 1,
		results
	});

	it('returns null dates when no release_dates data', () => {
		const result = extractReleaseDates(undefined, 'US');
		expect(result).toEqual({
			theatricalDate: null,
			digitalReleaseDate: null,
			physicalReleaseDate: null,
			tvReleaseDate: null
		});
	});

	it('returns null dates for null input', () => {
		const result = extractReleaseDates(null, 'US');
		expect(result).toEqual({
			theatricalDate: null,
			digitalReleaseDate: null,
			physicalReleaseDate: null,
			tvReleaseDate: null
		});
	});

	it('extracts US theatrical, digital, and physical dates', () => {
		const response = mkResponse([
			{
				iso_3166_1: 'US',
				release_dates: [
					{
						certification: 'R',
						descriptors: [],
						iso_639_1: '',
						note: '',
						release_date: '2026-05-08T00:00:00.000Z',
						type: 3
					},
					{
						certification: 'R',
						descriptors: [],
						iso_639_1: '',
						note: '',
						release_date: '2026-06-09T00:00:00.000Z',
						type: 4
					},
					{
						certification: '',
						descriptors: [],
						iso_639_1: '',
						note: '',
						release_date: '2026-07-15T00:00:00.000Z',
						type: 5
					}
				]
			}
		]);

		const result = extractReleaseDates(response, 'US');
		expect(result).toEqual({
			theatricalDate: '2026-05-08',
			digitalReleaseDate: '2026-06-09',
			physicalReleaseDate: '2026-07-15',
			tvReleaseDate: null
		});
	});

	it('extracts TV/streaming (type 6) date', () => {
		const response = mkResponse([
			{
				iso_3166_1: 'US',
				release_dates: [
					{
						certification: '',
						descriptors: [],
						iso_639_1: '',
						note: '',
						release_date: '2026-04-20T00:00:00.000Z',
						type: 6
					}
				]
			}
		]);

		const result = extractReleaseDates(response, 'US');
		expect(result.tvReleaseDate).toBe('2026-04-20');
	});

	it('falls back to earliest across all countries when region not found', () => {
		const response = mkResponse([
			{
				iso_3166_1: 'FR',
				release_dates: [
					{
						certification: '',
						descriptors: [],
						iso_639_1: '',
						note: '',
						release_date: '2026-06-01T00:00:00.000Z',
						type: 4
					}
				]
			},
			{
				iso_3166_1: 'GB',
				release_dates: [
					{
						certification: '',
						descriptors: [],
						iso_639_1: '',
						note: '',
						release_date: '2026-05-28T00:00:00.000Z',
						type: 4
					}
				]
			}
		]);

		const result = extractReleaseDates(response, 'US');
		expect(result.digitalReleaseDate).toBe('2026-05-28');
	});

	it('uses region-specific dates when region is found', () => {
		const response = mkResponse([
			{
				iso_3166_1: 'US',
				release_dates: [
					{
						certification: '',
						descriptors: [],
						iso_639_1: '',
						note: '',
						release_date: '2026-07-01T00:00:00.000Z',
						type: 4
					}
				]
			},
			{
				iso_3166_1: 'IL',
				release_dates: [
					{
						certification: '',
						descriptors: [],
						iso_639_1: '',
						note: '',
						release_date: '2026-06-21T00:00:00.000Z',
						type: 4
					}
				]
			}
		]);

		const result = extractReleaseDates(response, 'US');
		expect(result.digitalReleaseDate).toBe('2026-07-01');
	});

	it('picks limited theatrical (type 2) as theatrical date', () => {
		const response = mkResponse([
			{
				iso_3166_1: 'US',
				release_dates: [
					{
						certification: '',
						descriptors: [],
						iso_639_1: '',
						note: '',
						release_date: '2026-05-01T00:00:00.000Z',
						type: 2
					}
				]
			}
		]);

		const result = extractReleaseDates(response, 'US');
		expect(result.theatricalDate).toBe('2026-05-01');
	});
});
