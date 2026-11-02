import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	torrentHandle: vi.fn(),
	usenetHandle: vi.fn(),
	streamingHandle: vi.fn(),
	nzbStreamingHandle: vi.fn(),
	seriesFindFirst: vi.fn(),
	episodesFindMany: vi.fn(),
	getDefaultAcquisitionProtocol: vi.fn((): 'torrent' | 'debrid' => 'torrent'),
	getDebridClientForAcquisition: vi.fn()
}));

vi.mock('#lib/server/filters/GrabDecisionPipeline.js', () => ({
	grabDecisionPipeline: {
		evaluate: vi.fn(async () => ({
			accepted: true,
			reason: 'Accepted',
			upgradeStatus: 'new',
			scores: { candidate: 0 },
			audit: { stages: [], finalResult: { accepted: true }, totalDurationMs: 0 }
		}))
	}
}));

vi.mock('#lib/server/quality/QualityFilter.js', () => ({
	qualityFilter: {
		getDefaultScoringProfile: vi.fn(async () => ({ id: 'profile-1', name: 'Default' }))
	}
}));

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		query: {
			movies: {
				findFirst: vi.fn(async () => ({
					id: 'movie-1',
					scoringProfileId: null,
					rootFolderId: null,
					path: null
				}))
			},
			series: { findFirst: mocks.seriesFindFirst },
			episodes: { findMany: mocks.episodesFindMany },
			movieFiles: { findMany: vi.fn(async () => []) },
			alternateTitles: { findMany: vi.fn(async () => []) }
		},
		select: () => ({
			from: () => ({
				where: () => Object.assign([], { limit: () => ({ all: () => [] }) })
			})
		})
	}
}));

vi.mock('#lib/server/acquisition/AcquisitionService.js', () => ({
	acquisitionService: {
		createIntent: vi.fn(() => ({ ok: true, intentId: 'intent-1' })),
		attachQueueId: vi.fn(),
		completeIntent: vi.fn(),
		failIntent: vi.fn(),
		cancelIntent: vi.fn(),
		setIdentity: vi.fn(() => ({ ok: true })),
		completeByQueueId: vi.fn(),
		failByQueueId: vi.fn(),
		cancelByQueueId: vi.fn()
	}
}));

vi.mock('#lib/server/acquisition/MediaOccupancyService.js', () => ({
	mediaOccupancyService: {
		runExclusive: vi.fn(async (_target, operation: () => Promise<unknown>) => operation())
	}
}));

vi.mock('#lib/server/settings/acquisition.js', () => ({
	getDefaultAcquisitionProtocol: mocks.getDefaultAcquisitionProtocol
}));

vi.mock('#lib/server/downloadClients/DownloadClientManager.js', () => ({
	getDownloadClientManager: () => ({
		getDebridClientForAcquisition: mocks.getDebridClientForAcquisition
	})
}));

vi.mock('./handlers/TorrentHandler.js', () => ({
	TorrentHandler: class {
		handle = mocks.torrentHandle;
	}
}));

vi.mock('./handlers/UsenetHandler.js', () => ({
	UsenetHandler: class {
		handle = mocks.usenetHandle;
	}
}));

vi.mock('./handlers/StreamingHandler.js', () => ({
	StreamingHandler: class {
		handle = mocks.streamingHandle;
	}
}));

vi.mock('./handlers/NzbStreamingHandler.js', () => ({
	NzbStreamingHandler: class {
		handle = mocks.nzbStreamingHandle;
	}
}));

const { GrabService } = await import('./GrabService.js');

function request(acquisitionProtocol?: 'default' | 'torrent' | 'debrid') {
	return {
		release: {
			title: 'Movie.2026.1080p',
			protocol: 'torrent' as const,
			magnetUrl: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
			infoHash: '0123456789abcdef0123456789abcdef01234567'
		},
		target: { type: 'movie' as const, movieId: 'movie-1' },
		options: {
			force: true,
			skipBlocklist: false,
			allowSidegrade: false,
			isAutomatic: false,
			acquisitionProtocol
		}
	};
}

describe('GrabService debrid acquisition routing', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getDefaultAcquisitionProtocol.mockReturnValue('torrent');
		mocks.getDebridClientForAcquisition.mockResolvedValue(undefined);
		mocks.torrentHandle.mockResolvedValue({
			success: true,
			queueId: 'torrent-queue',
			hash: 'torrent-hash',
			clientId: 'torrent-client',
			clientName: 'qBittorrent'
		});
		mocks.usenetHandle.mockResolvedValue({
			success: true,
			queueId: 'usenet-queue',
			hash: 'usenet-id',
			clientId: 'usenet-client',
			clientName: 'SABnzbd'
		});
	});

	it('routes torrent-source plus acquisitionProtocol=debrid to the dedicated debrid path and never falls back to torrent when no debrid client is usable', async () => {
		const result = await new GrabService().grab(request('debrid'));

		expect(mocks.getDebridClientForAcquisition).toHaveBeenCalledOnce();
		expect(mocks.torrentHandle).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: false,
			error: expect.stringMatching(/no enabled debrid download client|stored api token/i)
		});
	});

	it.each([undefined, 'torrent'] as const)(
		'preserves legacy torrent routing for acquisitionProtocol=%s',
		async (acquisitionProtocol) => {
			const result = await new GrabService().grab(request(acquisitionProtocol));

			expect(result.success).toBe(true);
			expect(mocks.torrentHandle).toHaveBeenCalledOnce();
			expect(mocks.getDebridClientForAcquisition).not.toHaveBeenCalled();
		}
	);

	it('resolves acquisitionProtocol=default through the global torrent default without changing release.protocol', async () => {
		const grabRequest = request('default');
		const result = await new GrabService().grab(grabRequest);

		expect(result.success).toBe(true);
		expect(mocks.getDefaultAcquisitionProtocol).toHaveBeenCalledOnce();
		expect(mocks.torrentHandle).toHaveBeenCalledWith(
			expect.objectContaining({
				release: expect.objectContaining({ protocol: 'torrent' })
			}),
			expect.anything()
		);
	});

	it('resolves acquisitionProtocol=default through the global debrid default without changing release.protocol', async () => {
		mocks.getDefaultAcquisitionProtocol.mockReturnValue('debrid');
		const grabRequest = request('default');
		const result = await new GrabService().grab(grabRequest);

		expect(mocks.getDefaultAcquisitionProtocol).toHaveBeenCalledOnce();
		expect(mocks.getDebridClientForAcquisition).toHaveBeenCalledOnce();
		expect(mocks.torrentHandle).not.toHaveBeenCalled();
		expect(grabRequest.release.protocol).toBe('torrent');
		expect(result.success).toBe(false);
	});

	it('rejects explicit debrid acquisition for a non-torrent release instead of invoking any existing protocol handler', async () => {
		const grabRequest = request('debrid');
		const result = await new GrabService().grab({
			...grabRequest,
			release: { ...grabRequest.release, protocol: 'usenet' }
		});

		expect(result).toMatchObject({
			success: false,
			error: expect.stringMatching(/debrid acquisition requires a torrent release/i)
		});
		expect(mocks.torrentHandle).not.toHaveBeenCalled();
		expect(mocks.usenetHandle).not.toHaveBeenCalled();
		expect(mocks.getDebridClientForAcquisition).not.toHaveBeenCalled();
	});

	it('does not apply the global debrid default to an ordinary Usenet release', async () => {
		mocks.getDefaultAcquisitionProtocol.mockReturnValue('debrid');
		const grabRequest = request('default');
		const result = await new GrabService().grab({
			...grabRequest,
			release: { ...grabRequest.release, protocol: 'usenet' }
		});

		expect(result.success).toBe(true);
		expect(mocks.usenetHandle).toHaveBeenCalledOnce();
		expect(mocks.getDefaultAcquisitionProtocol).not.toHaveBeenCalled();
		expect(mocks.getDebridClientForAcquisition).not.toHaveBeenCalled();
	});

	it('hydrates an empty complete-series target with missing monitored episode IDs', async () => {
		mocks.seriesFindFirst.mockResolvedValue({
			id: 'series-wire',
			scoringProfileId: null,
			rootFolderId: null,
			path: null
		});
		mocks.episodesFindMany.mockResolvedValue([{ id: 'wire-s01e01' }, { id: 'wire-s05e10' }]);

		const service = new GrabService() as unknown as {
			resolveTarget(input: unknown): Promise<{ episodeIds?: string[] }>;
		};
		const resolved = await service.resolveTarget({
			...request('debrid'),
			target: { type: 'series', seriesId: 'series-wire', episodeIds: [] }
		});

		expect(resolved.episodeIds).toEqual(['wire-s01e01', 'wire-s05e10']);
		// 2x: the missing-episode backfill + the episodeScope materialization.
		expect(mocks.episodesFindMany).toHaveBeenCalledTimes(2);
	});
});
