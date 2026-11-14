/**
 * AutoSearchPausedSpecification Unit Tests
 *
 * Lets a user pause auto-search for a single item independent of `monitored`
 * and the (missing-content-only) failure cap.
 */

import { describe, it, expect } from 'vitest';
import {
	MovieAutoSearchPausedSpecification,
	EpisodeAutoSearchPausedSpecification
} from './AutoSearchPausedSpecification.js';
import type { MovieContext, EpisodeContext } from './types.js';
import { createMovie, createSeries, createEpisode } from '../../../../test/fixtures/media.js';

const testMovie = (overrides?: Parameters<typeof createMovie>[0]): MovieContext['movie'] =>
	createMovie(overrides) as unknown as MovieContext['movie'];
const testSeries = (overrides?: Parameters<typeof createSeries>[0]): EpisodeContext['series'] =>
	createSeries(overrides) as unknown as EpisodeContext['series'];
const testEpisode = (overrides?: Parameters<typeof createEpisode>[0]): EpisodeContext['episode'] =>
	createEpisode(overrides) as unknown as EpisodeContext['episode'];

describe('MovieAutoSearchPausedSpecification', () => {
	it('accepts an unpaused movie', async () => {
		const spec = new MovieAutoSearchPausedSpecification();
		const result = await spec.isSatisfied({ movie: testMovie({ autoSearchPaused: false }) });
		expect(result.accepted).toBe(true);
	});

	it('rejects a paused movie', async () => {
		const spec = new MovieAutoSearchPausedSpecification();
		const result = await spec.isSatisfied({ movie: testMovie({ autoSearchPaused: true }) });
		expect(result.accepted).toBe(false);
		expect(result.reason).toContain('paused');
	});
});

describe('EpisodeAutoSearchPausedSpecification', () => {
	const series = testSeries({ id: 'series-1' });

	it('accepts an unpaused episode', async () => {
		const spec = new EpisodeAutoSearchPausedSpecification();
		const result = await spec.isSatisfied({
			series,
			episode: testEpisode({ seriesId: 'series-1', autoSearchPaused: false })
		});
		expect(result.accepted).toBe(true);
	});

	it('rejects a paused episode', async () => {
		const spec = new EpisodeAutoSearchPausedSpecification();
		const result = await spec.isSatisfied({
			series,
			episode: testEpisode({ seriesId: 'series-1', autoSearchPaused: true })
		});
		expect(result.accepted).toBe(false);
		expect(result.reason).toContain('paused');
	});
});
