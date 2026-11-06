import { describe, expect, it } from 'vitest';
import { deriveMovieStatus } from './movieShape.js';

/**
 * Characterisation tests for the Radarr-compatible status derivation.
 *
 * This is an EXTERNAL CONTRACT: `status` is consumed by Radarr/Sonarr-compatible
 * clients and by the arr API responses. These tests freeze today's behaviour —
 * including the awkward parts — so the availability module can be refactored
 * underneath without silently changing what external clients see.
 */
const past = '2020-01-01';
const future = '2099-01-01';
const invalid = 'not-a-date';

describe('deriveMovieStatus (Radarr contract)', () => {
	it('reports released when a file exists, regardless of dates', () => {
		expect(
			deriveMovieStatus({
				hasFile: true,
				releaseDate: future,
				digitalReleaseDate: future,
				physicalReleaseDate: future
			})
		).toBe('released');
	});

	it('reports tba when no release date is known', () => {
		expect(
			deriveMovieStatus({
				hasFile: false,
				releaseDate: null,
				digitalReleaseDate: null,
				physicalReleaseDate: null
			})
		).toBe('tba');
	});

	it('reports announced for a future theatrical date', () => {
		expect(
			deriveMovieStatus({
				hasFile: false,
				releaseDate: future,
				digitalReleaseDate: null,
				physicalReleaseDate: null
			})
		).toBe('announced');
	});

	it('reports inCinemas when theatrical has passed but digital is still ahead', () => {
		expect(
			deriveMovieStatus({
				hasFile: false,
				releaseDate: past,
				digitalReleaseDate: future,
				physicalReleaseDate: null
			})
		).toBe('inCinemas');
	});

	it('reports inCinemas when theatrical has passed but physical is still ahead', () => {
		expect(
			deriveMovieStatus({
				hasFile: false,
				releaseDate: past,
				digitalReleaseDate: null,
				physicalReleaseDate: future
			})
		).toBe('inCinemas');
	});

	it('reports released when theatrical has passed and no home dates are known', () => {
		expect(
			deriveMovieStatus({
				hasFile: false,
				releaseDate: past,
				digitalReleaseDate: null,
				physicalReleaseDate: null
			})
		).toBe('released');
	});

	it('reports released when theatrical and both home dates have passed', () => {
		expect(
			deriveMovieStatus({
				hasFile: false,
				releaseDate: past,
				digitalReleaseDate: past,
				physicalReleaseDate: past
			})
		).toBe('released');
	});

	// Documented quirk: an unparseable date is treated as "still upcoming".
	// Radarr compatibility depends on this not throwing.
	it('treats an unparseable release date as announced rather than throwing', () => {
		expect(
			deriveMovieStatus({
				hasFile: false,
				releaseDate: invalid,
				digitalReleaseDate: null,
				physicalReleaseDate: null
			})
		).toBe('announced');
	});
});
