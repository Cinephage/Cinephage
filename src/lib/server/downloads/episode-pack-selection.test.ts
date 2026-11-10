import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	resolveScope: vi.fn(),
	buildSelection: vi.fn()
}));

vi.mock('./episode-pack-scope.js', () => ({ resolveEpisodePackScope: mocks.resolveScope }));

vi.mock('./episode-pointer.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./episode-pointer.js')>();
	return { ...actual, buildEpisodePointerFileSelection: mocks.buildSelection };
});

import { resolveEpisodePackSelection } from './episode-pack-selection.js';

const target = { season: 1, episode: 7, token: 'S01E07' };
const torrentFile = Buffer.from('fake');

function selectionOf(matchedEpisodes: number[]) {
	return {
		fileIndices: matchedEpisodes.map((episode) => episode - 1),
		allFileIndices: [0, 1, 2, 3, 4, 5, 6, 7],
		filePaths: matchedEpisodes.map((episode) => `S01E0${episode}.mkv`),
		matchedEpisodes,
		selectedSize: matchedEpisodes.length * 100
	};
}

describe('resolveEpisodePackSelection', () => {
	beforeEach(() => {
		mocks.resolveScope.mockReset();
		mocks.buildSelection.mockReset();
	});

	it('asks the matcher for every wanted episode of an automatic season grab', async () => {
		mocks.resolveScope.mockResolvedValue([
			{ episodeId: 'ep-1', episodeNumber: 1 },
			{ episodeId: 'ep-2', episodeNumber: 2 },
			{ episodeId: 'ep-7', episodeNumber: 7 }
		]);
		mocks.buildSelection.mockResolvedValue(selectionOf([1, 2, 7]));

		const result = await resolveEpisodePackSelection({
			torrentFile,
			target,
			seriesId: 'series-1',
			seasonNumber: 1,
			targetEpisodeId: 'ep-7',
			isAutomatic: true
		});

		expect(mocks.resolveScope).toHaveBeenCalledWith({
			seriesId: 'series-1',
			seasonNumber: 1,
			targetEpisode: 7,
			targetEpisodeId: 'ep-7'
		});
		expect(mocks.buildSelection.mock.calls[0][1]).toEqual([
			{ season: 1, episode: 1, token: 'S01E01' },
			{ season: 1, episode: 2, token: 'S01E02' },
			{ season: 1, episode: 7, token: 'S01E07' }
		]);
		expect(result).toEqual({
			ok: true,
			selection: {
				...selectionOf([1, 2, 7]),
				episodeIds: ['ep-1', 'ep-2', 'ep-7']
			}
		});
	});

	it('keeps interactive grabs to the single triggering episode', async () => {
		mocks.buildSelection.mockResolvedValue(selectionOf([7]));

		const result = await resolveEpisodePackSelection({
			torrentFile,
			target,
			seriesId: 'series-1',
			seasonNumber: 1,
			isAutomatic: false
		});

		expect(mocks.resolveScope).not.toHaveBeenCalled();
		expect(mocks.buildSelection.mock.calls[0][1]).toEqual([target]);
		expect(result.ok && result.selection.episodeIds).toEqual([]);
	});

	it('drops scoped episode ids whose files are not in this pack version', async () => {
		mocks.resolveScope.mockResolvedValue([
			{ episodeId: 'ep-1', episodeNumber: 1 },
			{ episodeId: 'ep-7', episodeNumber: 7 },
			{ episodeId: 'ep-8', episodeNumber: 8 }
		]);
		mocks.buildSelection.mockResolvedValue(selectionOf([1, 7]));

		const result = await resolveEpisodePackSelection({
			torrentFile,
			target,
			seriesId: 'series-1',
			seasonNumber: 1,
			isAutomatic: true
		});

		expect(result.ok && result.selection.episodeIds).toEqual(['ep-1', 'ep-7']);
	});

	it('fails when the pack does not contain the triggering episode', async () => {
		mocks.resolveScope.mockResolvedValue([
			{ episodeId: 'ep-1', episodeNumber: 1 },
			{ episodeId: 'ep-2', episodeNumber: 2 }
		]);
		mocks.buildSelection.mockResolvedValue(selectionOf([1, 2]));

		const result = await resolveEpisodePackSelection({
			torrentFile,
			target,
			seriesId: 'series-1',
			seasonNumber: 1,
			isAutomatic: true
		});

		expect(result).toEqual({
			ok: false,
			error: 'Could not map S01E07 to files inside this season pack'
		});
	});
});
