import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	findItem: vi.fn(),
	findList: vi.fn(),
	findMovies: vi.fn(),
	findSeries: vi.fn(),
	validateRootFolder: vi.fn(),
	getBlockedTmdbIdSet: vi.fn(),
	resolveLibrary: vi.fn(),
	getProfile: vi.fn(),
	insert: vi.fn()
}));

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		query: {
			smartListItems: { findFirst: mocks.findItem },
			smartLists: { findFirst: mocks.findList },
			movies: { findFirst: vi.fn(), findMany: mocks.findMovies },
			series: { findFirst: vi.fn(), findMany: mocks.findSeries }
		},
		insert: mocks.insert,
		update: vi.fn(),
		delete: vi.fn()
	},
	sqlite: {},
	initializeDatabase: vi.fn()
}));
vi.mock('#lib/server/library/LibraryAddService.js', () => ({
	validateRootFolder: mocks.validateRootFolder,
	getEffectiveScoringProfileId: mocks.getProfile,
	getLanguageProfileId: vi.fn(),
	fetchMovieDetails: vi.fn(),
	fetchMovieExternalIds: vi.fn(),
	triggerMovieSearch: vi.fn(),
	fetchSeriesDetails: vi.fn(),
	fetchSeriesExternalIds: vi.fn(),
	triggerSeriesSearch: vi.fn()
}));
vi.mock('#lib/server/library/status.js', () => ({
	getBlockedTmdbIdSet: mocks.getBlockedTmdbIdSet
}));
vi.mock('#lib/server/library/LibraryEntityService.js', () => ({
	getLibraryEntityService: vi.fn(() => ({
		resolveOwningLibraryForRootFolder: mocks.resolveLibrary
	}))
}));
vi.mock('#lib/server/tmdb.js', () => ({ tmdb: {} }));
vi.mock('#lib/logging/index.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
	createChildLogger: vi.fn(() => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: vi.fn()
	}))
}));

const { SmartListService } = await import('./SmartListService.js');

const list = {
	id: 'list-1',
	rootFolderId: 'read-only',
	autoAddMonitored: true,
	wantsSubtitles: false
} as any;
const item = {
	id: 'item-1',
	smartListId: 'list-1',
	tmdbId: 501,
	mediaType: 'movie',
	inLibrary: false,
	title: 'Movie'
} as any;

describe('SmartListService read-only destinations', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findItem.mockResolvedValue(item);
		mocks.findList.mockResolvedValue(list);
		mocks.getBlockedTmdbIdSet.mockResolvedValue(new Set());
		mocks.resolveLibrary.mockResolvedValue({ qualityProfileId: null, id: 'library-1' });
		mocks.getProfile.mockResolvedValue('profile-1');
		mocks.validateRootFolder.mockResolvedValue({});
	});

	it.each([
		['movie', 'addItemToLibrary'],
		['tv', 'addItemToLibrary']
	])('rejects a direct %s add before destination work', async (mediaType) => {
		mocks.findItem.mockResolvedValue({ ...item, mediaType });
		mocks.validateRootFolder
			.mockResolvedValueOnce({})
			.mockRejectedValueOnce(new Error('Root folder is read-only'));
		const result = await SmartListService.getInstance().addItemToLibrary('list-1', 'item-1');

		expect(result).toEqual({ success: false, error: 'Root folder is read-only' });
		expect(mocks.validateRootFolder).toHaveBeenCalledWith(
			'read-only',
			mediaType === 'movie' ? 'movie' : 'tv',
			{ requireWritable: true }
		);
		expect(mocks.insert).not.toHaveBeenCalled();
	});

	it.each([
		['movie', 'autoAddMovies', 'findMovies'],
		['tv', 'autoAddSeries', 'findSeries']
	])(
		'rejects bulk auto-add for %s before inserting media',
		async (mediaType, method, findMethod) => {
			const autoItem = { ...item, mediaType };
			mocks.validateRootFolder.mockRejectedValue(new Error('Root folder is read-only'));
			if (findMethod === 'findMovies') mocks.findMovies.mockResolvedValueOnce([]);
			else mocks.findSeries.mockResolvedValueOnce([]);
			const service = SmartListService.getInstance() as any;
			await expect(
				service[method]([autoItem], list, 'profile-1', true, false, false)
			).rejects.toThrow('Root folder is read-only');
			expect(mocks.validateRootFolder).toHaveBeenCalledWith(
				'read-only',
				mediaType === 'movie' ? 'movie' : 'tv',
				{ requireWritable: true }
			);
			expect(mocks.insert).not.toHaveBeenCalled();
		}
	);
});
