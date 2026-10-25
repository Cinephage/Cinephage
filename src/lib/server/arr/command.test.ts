import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchMissingMovies = vi.fn().mockResolvedValue(undefined);
const searchMissingEpisodes = vi.fn().mockResolvedValue(undefined);
const searchForUpgrades = vi.fn().mockResolvedValue(undefined);
const scanRootFolder = vi.fn().mockResolvedValue(undefined);
const refreshMovieMetadata = vi.fn().mockResolvedValue(undefined);
const refreshSeriesMetadata = vi.fn().mockResolvedValue(undefined);
const previewMovie = vi.fn().mockResolvedValue({ willChange: [{ fileId: 'file-1' }] });
const previewSeries = vi.fn().mockResolvedValue({ willChange: [] });
const executeRenames = vi.fn().mockResolvedValue(undefined);
const getEntityIdForArrId = vi
	.fn()
	.mockImplementation((_type: string, id: number) =>
		Promise.resolve(id === 999999 ? undefined : `uuid-${id}`)
	);
const dbDelete = vi.fn().mockReturnValue(Promise.resolve());
const dbGet = vi.fn().mockResolvedValue({ rootFolderId: 'root-1' });
const searchForMovie = vi.fn().mockResolvedValue(undefined);
const searchForSeries = vi.fn().mockResolvedValue(undefined);
const searchForEpisode = vi.fn().mockResolvedValue(undefined);

vi.mock('#lib/logging/index.js', () => ({
	createChildLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() })
}));
vi.mock('#lib/server/monitoring/search/MonitoringSearchService.js', () => ({
	monitoringSearchService: { searchMissingMovies, searchMissingEpisodes, searchForUpgrades }
}));
vi.mock('#lib/server/library/disk-scan.js', () => ({
	diskScanService: { scanRootFolder }
}));
vi.mock('#lib/server/metadata/metadata-refresh.js', () => ({
	refreshMovieMetadata,
	refreshSeriesMetadata
}));
vi.mock('#lib/server/library/naming/RenamePreviewService.js', () => ({
	RenamePreviewService: class {
		previewMovie = previewMovie;
		previewSeries = previewSeries;
		executeRenames = executeRenames;
	}
}));
vi.mock('#lib/server/db/index.js', () => ({
	db: {
		delete: dbDelete,
		select: () => ({
			from: () => ({
				where: () => ({
					get: dbGet
				})
			})
		})
	}
}));
vi.mock('./ArrIdMappingService.js', () => ({ getEntityIdForArrId }));
vi.mock('#lib/server/library/searchOnAdd/index.js', () => ({
	searchOnAdd: { searchForMovie, searchForSeries, searchForEpisode }
}));

const { handleCommand, listCommands, getCommand } = await import('./command.js');

function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
	vi.clearAllMocks();
	getEntityIdForArrId.mockImplementation((_type: string, id: number) =>
		Promise.resolve(id === 999999 ? undefined : `uuid-${id}`)
	);
	previewMovie.mockResolvedValue({ willChange: [{ fileId: 'file-1' }] });
	dbGet.mockResolvedValue({ rootFolderId: 'root-1' });
});

describe('handleCommand', () => {
	it('returns a completed CommandResource immediately regardless of mapping', () => {
		const result = handleCommand('Radarr', { name: 'SomeUnknownCommand' });
		expect(result.status).toBe('completed');
		expect(result.name).toBe('SomeUnknownCommand');
		expect(typeof result.id).toBe('number');
	});

	it('triggers searchMissingMovies for MissingMoviesSearch/MoviesSearch', async () => {
		handleCommand('Radarr', { name: 'MissingMoviesSearch' });
		handleCommand('Radarr', { name: 'MoviesSearch' });
		await flush();
		expect(searchMissingMovies).toHaveBeenCalledTimes(2);
	});

	it('triggers searchMissingEpisodes for episode search command names', async () => {
		handleCommand('Sonarr', { name: 'MissingEpisodeSearch' });
		await flush();
		expect(searchMissingEpisodes).toHaveBeenCalledTimes(1);
	});

	it('resolves the movie and scans its root folder for RescanMovie', async () => {
		handleCommand('Radarr', { name: 'RescanMovie', movieId: 42 });
		await flush();
		expect(getEntityIdForArrId).toHaveBeenCalledWith('movie', 42);
		expect(scanRootFolder).toHaveBeenCalledWith('root-1');
	});

	it('does nothing for RescanMovie when the movie id does not resolve', async () => {
		handleCommand('Radarr', { name: 'RescanMovie', movieId: 999999 });
		await flush();
		expect(scanRootFolder).not.toHaveBeenCalled();
	});

	it('refreshes metadata for RefreshMovie/RefreshSeries', async () => {
		handleCommand('Radarr', { name: 'RefreshMovie', movieId: 1 });
		handleCommand('Sonarr', { name: 'RefreshSeries', seriesId: 2 });
		await flush();
		expect(refreshMovieMetadata).toHaveBeenCalledWith('uuid-1');
		expect(refreshSeriesMetadata).toHaveBeenCalledWith('uuid-2');
	});

	it('calls searchForUpgrades with cutoffUnmetOnly for CutOffUnmet* commands', async () => {
		handleCommand('Radarr', { name: 'CutOffUnmetMoviesSearch' });
		await flush();
		expect(searchForUpgrades).toHaveBeenCalledWith({ cutoffUnmetOnly: true });
	});

	it('clears the blocklist table for ClearBlocklist', async () => {
		handleCommand('Radarr', { name: 'ClearBlocklist' });
		await flush();
		expect(dbDelete).toHaveBeenCalled();
	});

	it('previews then executes renames for RenameMovie', async () => {
		handleCommand('Radarr', { name: 'RenameMovie', movieId: 5 });
		await flush();
		expect(previewMovie).toHaveBeenCalledWith('uuid-5');
		expect(executeRenames).toHaveBeenCalledWith(['file-1'], 'movie');
	});

	it('skips executeRenames when nothing would change', async () => {
		previewMovie.mockResolvedValueOnce({ willChange: [] });
		handleCommand('Radarr', { name: 'RenameMovie', movieId: 6 });
		await flush();
		expect(executeRenames).not.toHaveBeenCalled();
	});

	it('does not map Backup - accepted but no real trigger fires', async () => {
		handleCommand('Radarr', { name: 'Backup' });
		await flush();
		expect(searchMissingMovies).not.toHaveBeenCalled();
		expect(dbDelete).not.toHaveBeenCalled();
	});

	describe('numeric-string ids (a client that serializes ids as strings)', () => {
		it('still scopes RescanMovie to the given movie instead of silently no-op-ing', async () => {
			handleCommand('Radarr', { name: 'RescanMovie', movieId: '42' });
			await flush();
			expect(getEntityIdForArrId).toHaveBeenCalledWith('movie', 42);
			expect(scanRootFolder).toHaveBeenCalledWith('root-1');
		});

		it('still scopes SeriesSearch to the given series instead of falling back to a global sweep', async () => {
			handleCommand('Sonarr', { name: 'SeriesSearch', seriesId: '7' });
			await flush();
			expect(getEntityIdForArrId).toHaveBeenCalledWith('series', 7);
			expect(searchForSeries).toHaveBeenCalledTimes(1);
			// The whole point: a per-series command must never fall through to
			// a library-wide sweep just because the id arrived as a string.
			expect(searchMissingEpisodes).not.toHaveBeenCalled();
		});

		it('still scopes EpisodeSearch to the given episode instead of falling back to a global sweep', async () => {
			handleCommand('Sonarr', { name: 'EpisodeSearch', episodeId: '9' });
			await flush();
			expect(getEntityIdForArrId).toHaveBeenCalledWith('episode', 9);
			expect(searchForEpisode).toHaveBeenCalledTimes(1);
			expect(searchMissingEpisodes).not.toHaveBeenCalled();
		});
	});

	describe('command history (GET /command, /command/{id})', () => {
		it('records a command and reports it as started, then completed once the work settles', async () => {
			const result = handleCommand('Sonarr', { name: 'MissingEpisodeSearch' });
			const id = result.id as number;

			// Synchronously after handleCommand returns, the async work has been
			// dispatched but not yet settled.
			expect(getCommand(id)?.status).toBe('started');
			expect(listCommands().some((c) => c.id === id)).toBe(true);

			await flush();

			expect(getCommand(id)?.status).toBe('completed');
			expect(getCommand(id)?.ended).toBeTruthy();
		});

		it('records a failed command when the dispatched work rejects', async () => {
			searchMissingEpisodes.mockRejectedValueOnce(new Error('indexer unreachable'));
			const result = handleCommand('Sonarr', { name: 'MissingEpisodeSearch' });
			const id = result.id as number;

			await flush();

			expect(getCommand(id)?.status).toBe('failed');
			expect(getCommand(id)?.exception).toContain('indexer unreachable');
		});

		it('reports commands with nothing to dispatch as completed immediately', () => {
			const result = handleCommand('Radarr', { name: 'SomeUnknownCommand' });
			expect(getCommand(result.id as number)?.status).toBe('completed');
		});
	});
});
