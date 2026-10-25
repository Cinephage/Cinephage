import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getEnabledClientsForProtocol: vi.fn(),
	getDebridClientForAcquisition: vi.fn(),
	getIndexers: vi.fn(),
	getDefinitionCapabilities: vi.fn()
}));

vi.mock('#lib/server/downloadClients/DownloadClientManager.js', () => ({
	getDownloadClientManager: () => ({
		getEnabledClientsForProtocol: mocks.getEnabledClientsForProtocol,
		getDebridClientForAcquisition: mocks.getDebridClientForAcquisition
	})
}));

vi.mock('#lib/server/indexers/IndexerManager.js', () => ({
	getIndexerManager: async () => ({
		getIndexers: mocks.getIndexers,
		getDefinitionCapabilities: mocks.getDefinitionCapabilities
	})
}));

const { getAutoSearchPreflightIssue } = await import('./autoSearchPreflight.js');

// A torrent-capable indexer definition (movie search available + movie categories).
function torrentIndexer(definitionId = 'torrent-def-1') {
	return {
		id: 'idx-torrent',
		name: 'Torrent Indexer',
		definitionId,
		enabled: true,
		enableInteractiveSearch: true,
		protocol: 'torrent' as const
	};
}

function usenetIndexer(definitionId = 'usenet-def-1') {
	return {
		id: 'idx-usenet',
		name: 'Usenet Indexer',
		definitionId,
		enabled: true,
		enableInteractiveSearch: true,
		protocol: 'usenet' as const
	};
}

// Capabilities that satisfy movie search: movieSearch.available + a movie category (2000).
const movieCapabilities = {
	search: { available: true },
	movieSearch: { available: true },
	categories: new Map<number, string>([[2000, 'Movies']]),
	supportsPagination: false,
	supportsInfoHash: false,
	limitMax: 100,
	limitDefault: 50
};

const TORRENT_CLIENT = [{ client: { id: 'qb-1', implementation: 'qbittorrent' }, instance: {} }];
const USENET_CLIENT = [{ client: { id: 'sab-1', implementation: 'sabnzbd' }, instance: {} }];
const DEBRID_CLIENT = {
	client: { id: 'debrid-1', implementation: 'realdebrid' },
	adapter: {}
};

describe('getAutoSearchPreflightIssue - debrid satisfies torrent requirement', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getDefinitionCapabilities.mockReturnValue(movieCapabilities);
		mocks.getEnabledClientsForProtocol.mockImplementation(async (protocol: string) => {
			if (protocol === 'torrent') return [];
			if (protocol === 'usenet') return [];
			return [];
		});
		mocks.getDebridClientForAcquisition.mockResolvedValue(undefined);
	});

	it('only debrid client + torrent indexer returns null (debrid satisfies torrent)', async () => {
		// Bug case: debrid-only configuration should satisfy the torrent requirement.
		mocks.getIndexers.mockResolvedValue([torrentIndexer()]);
		mocks.getEnabledClientsForProtocol.mockImplementation(async (protocol: string) => {
			if (protocol === 'torrent') return [];
			if (protocol === 'usenet') return [];
			return [];
		});
		mocks.getDebridClientForAcquisition.mockResolvedValue(DEBRID_CLIENT);

		const issue = await getAutoSearchPreflightIssue('profile-1', 'movie');

		// The preflight must NOT consult getDefaultAcquisitionProtocol for this decision.
		// It should treat an enabled debrid client as satisfying the torrent requirement.
		expect(issue).toBeNull();
	});

	it('only torrent client + torrent indexer returns null (unchanged)', async () => {
		mocks.getIndexers.mockResolvedValue([torrentIndexer()]);
		mocks.getEnabledClientsForProtocol.mockImplementation(async (protocol: string) => {
			if (protocol === 'torrent') return TORRENT_CLIENT;
			if (protocol === 'usenet') return [];
			return [];
		});
		mocks.getDebridClientForAcquisition.mockResolvedValue(undefined);

		const issue = await getAutoSearchPreflightIssue('profile-1', 'movie');

		expect(issue).toBeNull();
	});

	it('no torrent client, no debrid client + torrent indexer returns NO_DOWNLOAD_CLIENT (unchanged)', async () => {
		mocks.getIndexers.mockResolvedValue([torrentIndexer()]);
		mocks.getEnabledClientsForProtocol.mockImplementation(async (protocol: string) => {
			if (protocol === 'torrent') return [];
			if (protocol === 'usenet') return [];
			return [];
		});
		mocks.getDebridClientForAcquisition.mockResolvedValue(undefined);

		const issue = await getAutoSearchPreflightIssue('profile-1', 'movie');

		expect(issue).toEqual(
			expect.objectContaining({
				code: 'NO_DOWNLOAD_CLIENT',
				message: 'No torrent or debrid download client is enabled'
			})
		);
	});

	it('only usenet client + torrent indexer returns NO_DOWNLOAD_CLIENT (usenet does not satisfy torrent; unchanged)', async () => {
		mocks.getIndexers.mockResolvedValue([torrentIndexer()]);
		mocks.getEnabledClientsForProtocol.mockImplementation(async (protocol: string) => {
			if (protocol === 'torrent') return [];
			if (protocol === 'usenet') return USENET_CLIENT;
			return [];
		});
		mocks.getDebridClientForAcquisition.mockResolvedValue(undefined);

		const issue = await getAutoSearchPreflightIssue('profile-1', 'movie');

		expect(issue).toEqual(
			expect.objectContaining({
				code: 'NO_DOWNLOAD_CLIENT',
				message: 'No torrent or debrid download client is enabled'
			})
		);
	});

	it('only debrid client + usenet indexer returns NO_DOWNLOAD_CLIENT (debrid does not satisfy usenet; unchanged)', async () => {
		mocks.getIndexers.mockResolvedValue([usenetIndexer()]);
		mocks.getEnabledClientsForProtocol.mockImplementation(async (protocol: string) => {
			if (protocol === 'torrent') return [];
			if (protocol === 'usenet') return [];
			return [];
		});
		mocks.getDebridClientForAcquisition.mockResolvedValue(DEBRID_CLIENT);

		const issue = await getAutoSearchPreflightIssue('profile-1', 'movie');

		expect(issue).toEqual(
			expect.objectContaining({
				code: 'NO_DOWNLOAD_CLIENT',
				message: 'No usenet download client is enabled'
			})
		);
	});

	it('only debrid client + mixed torrent+usenet indexers returns null (debrid satisfies torrent side)', async () => {
		mocks.getIndexers.mockResolvedValue([torrentIndexer(), usenetIndexer()]);
		mocks.getEnabledClientsForProtocol.mockImplementation(async (protocol: string) => {
			if (protocol === 'torrent') return [];
			if (protocol === 'usenet') return [];
			return [];
		});
		mocks.getDebridClientForAcquisition.mockResolvedValue(DEBRID_CLIENT);

		const issue = await getAutoSearchPreflightIssue('profile-1', 'movie');

		expect(issue).toBeNull();
	});
});
