/**
 * Regression tests for EpisodeMonitoredSpecification's season-link handling.
 *
 * A null/dangling episode.seasonId used to silently "accept" (treat the
 * episode as monitored) regardless of what the user set on the season,
 * letting episodes under an unmonitored season bypass that check entirely
 * and get endlessly re-searched/re-grabbed. It must fail closed instead.
 */

import { describe, it, expect, vi } from 'vitest';
import type { EpisodeContext, MovieContext } from './types.js';
import { RejectionReason } from './types.js';
import { createSeries, createEpisode, createMovie } from '../../../../test/fixtures/media.js';

const findFirstSeasonMock = vi.fn();

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		query: {
			seasons: { findFirst: findFirstSeasonMock }
		}
	}
}));

vi.mock('#lib/logging/index.js', () => ({
	createChildLogger: vi.fn(() => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn()
	}))
}));

const { MovieMonitoredSpecification, EpisodeMonitoredSpecification } =
	await import('./MonitoredSpecification.js');

function episodeContext(overrides: Partial<EpisodeContext> = {}): EpisodeContext {
	return {
		series: createSeries({
			id: 'series-1',
			monitored: true
		}) as unknown as EpisodeContext['series'],
		episode: createEpisode({
			id: 'episode-1',
			seriesId: 'series-1',
			seasonId: 'season-1',
			monitored: true
		}) as unknown as EpisodeContext['episode'],
		...overrides
	};
}

describe('MovieMonitoredSpecification', () => {
	it('accepts a monitored movie', async () => {
		const spec = new MovieMonitoredSpecification();
		const context: MovieContext = {
			movie: createMovie({ monitored: true }) as unknown as MovieContext['movie']
		};
		expect(await spec.isSatisfied(context)).toEqual({ accepted: true });
	});

	it('rejects an unmonitored movie', async () => {
		const spec = new MovieMonitoredSpecification();
		const context: MovieContext = {
			movie: createMovie({ monitored: false }) as unknown as MovieContext['movie']
		};
		const result = await spec.isSatisfied(context);
		expect(result.accepted).toBe(false);
	});
});

describe('EpisodeMonitoredSpecification', () => {
	it('rejects when the series is unmonitored', async () => {
		findFirstSeasonMock.mockResolvedValue({ id: 'season-1', monitored: true });
		const spec = new EpisodeMonitoredSpecification();
		const context = episodeContext({
			series: createSeries({
				id: 'series-1',
				monitored: false
			}) as unknown as EpisodeContext['series']
		});
		const result = await spec.isSatisfied(context);
		expect(result.accepted).toBe(false);
		if (!result.accepted) expect(result.reason).toBe(RejectionReason.SERIES_NOT_MONITORED);
	});

	it('rejects when the episode itself is unmonitored', async () => {
		findFirstSeasonMock.mockResolvedValue({ id: 'season-1', monitored: true });
		const spec = new EpisodeMonitoredSpecification();
		const context = episodeContext({
			episode: createEpisode({
				id: 'episode-1',
				seasonId: 'season-1',
				monitored: false
			}) as unknown as EpisodeContext['episode']
		});
		const result = await spec.isSatisfied(context);
		expect(result.accepted).toBe(false);
		if (!result.accepted) expect(result.reason).toBe(RejectionReason.NOT_MONITORED);
	});

	it('rejects when the linked season is unmonitored', async () => {
		findFirstSeasonMock.mockResolvedValue({ id: 'season-1', monitored: false });
		const spec = new EpisodeMonitoredSpecification();
		const result = await spec.isSatisfied(episodeContext());
		expect(result.accepted).toBe(false);
		if (!result.accepted) expect(result.reason).toBe(RejectionReason.SEASON_NOT_MONITORED);
	});

	it('accepts when series, episode, and season are all monitored', async () => {
		findFirstSeasonMock.mockResolvedValue({ id: 'season-1', monitored: true });
		const spec = new EpisodeMonitoredSpecification();
		const result = await spec.isSatisfied(episodeContext());
		expect(result).toEqual({ accepted: true });
	});

	it('fails closed (rejects) when the episode has no seasonId', async () => {
		const spec = new EpisodeMonitoredSpecification();
		const context = episodeContext({
			episode: createEpisode({
				id: 'episode-1',
				seasonId: null,
				monitored: true
			}) as unknown as EpisodeContext['episode']
		});
		const result = await spec.isSatisfied(context);
		expect(result.accepted).toBe(false);
		if (!result.accepted) expect(result.reason).toBe(RejectionReason.SEASON_LINK_MISSING);
		expect(findFirstSeasonMock).not.toHaveBeenCalled();
	});

	it('fails closed (rejects) when seasonId points to a season row that no longer exists', async () => {
		findFirstSeasonMock.mockResolvedValue(undefined);
		const spec = new EpisodeMonitoredSpecification();
		const result = await spec.isSatisfied(episodeContext());
		expect(result.accepted).toBe(false);
		if (!result.accepted) expect(result.reason).toBe(RejectionReason.SEASON_LINK_MISSING);
	});
});
