/**
 * FailureCapSpecification Unit Tests
 *
 * The incident this guards against: a release's files got removed from the
 * indexer after being grabbed, and the missing-content search kept grabbing
 * a *different*, not-yet-tried release every cycle - forever, since neither
 * the per-release cooldown nor the blocklist stop a fresh release from being
 * tried. This specification is the circuit breaker: once an item has failed
 * too many times in a row (regardless of which release), stop searching it.
 */

import { describe, it, expect } from 'vitest';
import {
	MovieFailureCapSpecification,
	EpisodeFailureCapSpecification,
	DEFAULT_MAX_CONSECUTIVE_FAILURES,
	backoffCooldownHours,
	MAX_BACKOFF_HOURS
} from './FailureCapSpecification.js';
import type { MovieContext, EpisodeContext } from './types.js';
import { createMovie, createSeries, createEpisode } from '../../../../test/fixtures/media.js';

const testMovie = (overrides?: Parameters<typeof createMovie>[0]): MovieContext['movie'] =>
	createMovie(overrides) as unknown as MovieContext['movie'];
const testSeries = (overrides?: Parameters<typeof createSeries>[0]): EpisodeContext['series'] =>
	createSeries(overrides) as unknown as EpisodeContext['series'];
const testEpisode = (overrides?: Parameters<typeof createEpisode>[0]): EpisodeContext['episode'] =>
	createEpisode(overrides) as unknown as EpisodeContext['episode'];

describe('MovieFailureCapSpecification', () => {
	it('accepts a movie below the failure cap', async () => {
		const spec = new MovieFailureCapSpecification();
		const result = await spec.isSatisfied({
			movie: testMovie({ consecutiveFailureCount: DEFAULT_MAX_CONSECUTIVE_FAILURES - 1 })
		});
		expect(result.accepted).toBe(true);
	});

	it('rejects a movie at the failure cap', async () => {
		const spec = new MovieFailureCapSpecification();
		const result = await spec.isSatisfied({
			movie: testMovie({ consecutiveFailureCount: DEFAULT_MAX_CONSECUTIVE_FAILURES })
		});
		expect(result.accepted).toBe(false);
		expect(result.reason).toContain('Max consecutive failures reached');
	});

	it('rejects a movie above the failure cap', async () => {
		const spec = new MovieFailureCapSpecification();
		const result = await spec.isSatisfied({
			movie: testMovie({ consecutiveFailureCount: DEFAULT_MAX_CONSECUTIVE_FAILURES + 10 })
		});
		expect(result.accepted).toBe(false);
	});

	it('accepts a movie that has never failed', async () => {
		const spec = new MovieFailureCapSpecification();
		const result = await spec.isSatisfied({ movie: testMovie({ consecutiveFailureCount: 0 }) });
		expect(result.accepted).toBe(true);
	});

	it('respects a custom max failures value', async () => {
		const spec = new MovieFailureCapSpecification(2);
		const belowCustomCap = await spec.isSatisfied({
			movie: testMovie({ consecutiveFailureCount: 1 })
		});
		const atCustomCap = await spec.isSatisfied({
			movie: testMovie({ consecutiveFailureCount: 2 })
		});
		expect(belowCustomCap.accepted).toBe(true);
		expect(atCustomCap.accepted).toBe(false);
	});
});

describe('EpisodeFailureCapSpecification', () => {
	const series = testSeries({ id: 'series-1' });

	it('accepts an episode below the failure cap', async () => {
		const spec = new EpisodeFailureCapSpecification();
		const result = await spec.isSatisfied({
			series,
			episode: testEpisode({
				seriesId: 'series-1',
				consecutiveFailureCount: DEFAULT_MAX_CONSECUTIVE_FAILURES - 1
			})
		});
		expect(result.accepted).toBe(true);
	});

	it('rejects an episode at the failure cap', async () => {
		const spec = new EpisodeFailureCapSpecification();
		const result = await spec.isSatisfied({
			series,
			episode: testEpisode({
				seriesId: 'series-1',
				consecutiveFailureCount: DEFAULT_MAX_CONSECUTIVE_FAILURES
			})
		});
		expect(result.accepted).toBe(false);
		expect(result.reason).toContain('Max consecutive failures reached');
	});
});

describe('backoffCooldownHours', () => {
	it('returns the base cooldown unchanged with zero failures', () => {
		expect(backoffCooldownHours(12, 0)).toBe(12);
	});

	it('doubles the cooldown per consecutive failure', () => {
		expect(backoffCooldownHours(12, 1)).toBe(24);
		expect(backoffCooldownHours(12, 2)).toBe(48);
	});

	it('caps the escalating delay at MAX_BACKOFF_HOURS', () => {
		expect(backoffCooldownHours(12, 4)).toBe(MAX_BACKOFF_HOURS);
		expect(backoffCooldownHours(12, 10)).toBe(MAX_BACKOFF_HOURS);
	});
});
