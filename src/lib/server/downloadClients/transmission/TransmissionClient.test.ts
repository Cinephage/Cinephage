import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
	mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

import { TransmissionClient } from './TransmissionClient';

interface RpcRequestPayload {
	method?: string;
	arguments?: Record<string, unknown>;
}

function createClient(): TransmissionClient {
	return new TransmissionClient({
		host: 'localhost',
		port: 9091,
		useSsl: false
	});
}

function mockRpcAddSuccess(payloads: RpcRequestPayload[]): ReturnType<typeof vi.fn> {
	return vi.fn(async (_url: string, init?: RequestInit) => {
		const payload = JSON.parse(String(init?.body ?? '{}')) as RpcRequestPayload;
		payloads.push(payload);

		if (payloads.length === 1) {
			return new Response(null, {
				status: 409,
				headers: { 'X-Transmission-Session-Id': 'session-1' }
			});
		}

		if (payload.method === 'session-get') {
			return new Response(
				JSON.stringify({
					result: 'success',
					arguments: {
						version: '4.0.6',
						'rpc-version': 17,
						'download-dir': '/downloads'
					}
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				}
			);
		}

		return new Response(
			JSON.stringify({
				result: 'success',
				arguments: {
					'torrent-added': {
						id: 42,
						name: 'test',
						hashString: 'deadbeef'
					}
				}
			}),
			{
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	});
}

function mockRpcTorrentGet(
	mockTorrent: Record<string, unknown>,
	sessionOverrides: Record<string, unknown> = {}
): ReturnType<typeof vi.fn> {
	return vi.fn(async (_url: string, init?: RequestInit) => {
		const payload = JSON.parse(String(init?.body ?? '{}')) as RpcRequestPayload;

		if (payload.method === 'session-get') {
			return new Response(
				JSON.stringify({
					result: 'success',
					arguments: {
						version: '4.0.6',
						'rpc-version': 17,
						'download-dir': '/downloads',
						'idle-seeding-limit-enabled': false,
						'idle-seeding-limit': 30,
						'seed-ratio-limited': false,
						'seed-ratio-limit': 2,
						...sessionOverrides
					}
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);
		}

		const torrent = { ...mockTorrent };

		return new Response(
			JSON.stringify({
				result: 'success',
				arguments: {
					torrents: [torrent]
				}
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } }
		);
	});
}

describe('TransmissionClient', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('prefers torrent file metainfo over magnet or download URL when available', async () => {
		const payloads: RpcRequestPayload[] = [];
		vi.stubGlobal('fetch', mockRpcAddSuccess(payloads));

		const client = createClient();
		const torrentFile = Buffer.from('dummy-torrent-file');

		const hash = await client.addDownload({
			torrentFile,
			magnetUri: 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			downloadUrl: 'https://example.com/file.torrent',
			category: 'tv'
		});

		expect(hash).toBe('deadbeef');
		expect(payloads[1].method).toBe('session-get');
		const torrentAdd = payloads.find((payload) => payload.method === 'torrent-add');
		expect(torrentAdd?.arguments?.metainfo).toBe(torrentFile.toString('base64'));
		expect(torrentAdd?.arguments?.filename).toBeUndefined();
		expect(torrentAdd?.arguments?.['download-dir']).toBe('/downloads/tv');
		expect(torrentAdd?.arguments?.labels).toEqual(['tv']);
	});

	it('uses magnet URI when torrent file is unavailable', async () => {
		const payloads: RpcRequestPayload[] = [];
		vi.stubGlobal('fetch', mockRpcAddSuccess(payloads));

		const client = createClient();
		const magnetUri = 'magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

		const hash = await client.addDownload({
			magnetUri,
			downloadUrl: 'https://example.com/file.torrent',
			category: 'tv'
		});

		expect(hash).toBe('deadbeef');
		expect(payloads[1].method).toBe('session-get');
		const torrentAdd = payloads.find((payload) => payload.method === 'torrent-add');
		expect(torrentAdd?.arguments?.filename).toBe(magnetUri);
		expect(torrentAdd?.arguments?.metainfo).toBeUndefined();
		expect(torrentAdd?.arguments?.['download-dir']).toBe('/downloads/tv');
	});

	it('prefers an explicit savePath over the derived category path', async () => {
		const payloads: RpcRequestPayload[] = [];
		vi.stubGlobal('fetch', mockRpcAddSuccess(payloads));

		const client = createClient();

		const hash = await client.addDownload({
			magnetUri: 'magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			category: 'tv',
			savePath: '/custom/path'
		});

		expect(hash).toBe('deadbeef');
		expect(payloads.some((payload) => payload.method === 'session-get')).toBe(false);
		const torrentAdd = payloads.find((payload) => payload.method === 'torrent-add');
		expect(torrentAdd?.arguments?.['download-dir']).toBe('/custom/path');
	});

	it('logs a warning and falls back to labels-only when the default save path lookup fails', async () => {
		mockLogger.warn.mockClear();
		const payloads: RpcRequestPayload[] = [];
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const payload = JSON.parse(String(init?.body ?? '{}')) as RpcRequestPayload;
			payloads.push(payload);

			if (payloads.length === 1) {
				return new Response(null, {
					status: 409,
					headers: { 'X-Transmission-Session-Id': 'session-1' }
				});
			}

			if (payload.method === 'session-get') {
				// Simulate the default-save-path lookup failing (e.g. RPC error).
				return new Response('boom', { status: 500 });
			}

			return new Response(
				JSON.stringify({
					result: 'success',
					arguments: {
						'torrent-added': { id: 42, name: 'test', hashString: 'deadbeef' }
					}
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = createClient();
		const hash = await client.addDownload({
			magnetUri: 'magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			category: 'tv'
		});

		expect(hash).toBe('deadbeef');
		const torrentAdd = payloads.find((payload) => payload.method === 'torrent-add');
		expect(torrentAdd?.arguments?.['download-dir']).toBeUndefined();
		expect(torrentAdd?.arguments?.labels).toEqual(['tv']);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ category: 'tv' }),
			expect.stringContaining('Failed to resolve default save path')
		);
	});

	describe('canBeRemoved', () => {
		const baseTorrent = {
			id: 1,
			name: 'test',
			hashString: 'deadbeef',
			percentDone: 1,
			status: 6,
			isFinished: true,
			totalSize: 1000,
			rateDownload: 0,
			rateUpload: 0,
			eta: -1,
			downloadDir: '/downloads',
			labels: [],
			addedDate: 1234567890,
			doneDate: 1234567900,
			secondsSeeding: 3600,
			uploadRatio: 1.5,
			seedRatioLimit: 2.0,
			seedRatioMode: 1,
			seedIdleLimit: 60,
			seedIdleMode: 1,
			error: 0,
			errorString: ''
		};

		it('returns false while actively seeding even when isFinished is true', async () => {
			vi.stubGlobal('fetch', mockRpcTorrentGet({ ...baseTorrent }));

			const client = createClient();
			const download = await client.getDownload('deadbeef');

			expect(download?.status).toBe('seeding');
			expect(download?.canBeRemoved).toBe(false);
		});

		it('returns false while seeding with limits not yet met', async () => {
			vi.stubGlobal(
				'fetch',
				mockRpcTorrentGet({ ...baseTorrent, isFinished: false, secondsSeeding: 10 })
			);

			const client = createClient();
			const download = await client.getDownload('deadbeef');

			expect(download?.status).toBe('seeding');
			expect(download?.canBeRemoved).toBe(false);
		});

		it('returns true when stopped and the per-torrent ratio limit is met', async () => {
			vi.stubGlobal('fetch', mockRpcTorrentGet({ ...baseTorrent, status: 0, uploadRatio: 2.5 }));

			const client = createClient();
			const download = await client.getDownload('deadbeef');

			expect(download?.status).toBe('completed');
			expect(download?.canBeRemoved).toBe(true);
		});

		it('returns true when stopped and the per-torrent idle limit is met', async () => {
			vi.stubGlobal(
				'fetch',
				mockRpcTorrentGet({
					...baseTorrent,
					status: 0,
					uploadRatio: 0.5,
					seedIdleLimit: 60,
					secondsSeeding: 3600
				})
			);

			const client = createClient();
			const download = await client.getDownload('deadbeef');

			expect(download?.status).toBe('completed');
			expect(download?.canBeRemoved).toBe(true);
		});

		it('returns false when stopped but no seed limits are configured', async () => {
			vi.stubGlobal(
				'fetch',
				mockRpcTorrentGet({
					...baseTorrent,
					status: 0,
					uploadRatio: 2.5,
					seedRatioMode: 2,
					seedIdleMode: 2
				})
			);

			const client = createClient();
			const download = await client.getDownload('deadbeef');

			expect(download?.status).toBe('completed');
			expect(download?.canBeRemoved).toBe(false);
		});

		it('returns false when stopped and per-torrent limits are not met', async () => {
			vi.stubGlobal(
				'fetch',
				mockRpcTorrentGet({
					...baseTorrent,
					status: 0,
					uploadRatio: 1.5,
					secondsSeeding: 10
				})
			);

			const client = createClient();
			const download = await client.getDownload('deadbeef');

			expect(download?.status).toBe('completed');
			expect(download?.canBeRemoved).toBe(false);
		});

		it('applies the global session ratio limit when the torrent follows global mode', async () => {
			vi.stubGlobal(
				'fetch',
				mockRpcTorrentGet(
					{ ...baseTorrent, status: 0, seedRatioMode: 0, uploadRatio: 1.5 },
					{ 'seed-ratio-limited': true, 'seed-ratio-limit': 1 }
				)
			);

			const client = createClient();
			const download = await client.getDownload('deadbeef');

			expect(download?.status).toBe('completed');
			expect(download?.canBeRemoved).toBe(true);
		});

		it('ignores the global session limit when it is disabled', async () => {
			vi.stubGlobal(
				'fetch',
				mockRpcTorrentGet(
					{ ...baseTorrent, status: 0, seedRatioMode: 0, seedIdleMode: 2 },
					{ 'seed-ratio-limited': false }
				)
			);

			const client = createClient();
			const download = await client.getDownload('deadbeef');

			expect(download?.status).toBe('completed');
			expect(download?.canBeRemoved).toBe(false);
		});

		it('returns false when downloading', async () => {
			vi.stubGlobal(
				'fetch',
				mockRpcTorrentGet({ ...baseTorrent, status: 4, isFinished: false, percentDone: 0.5 })
			);

			const client = createClient();
			const download = await client.getDownload('deadbeef');

			expect(download?.status).toBe('downloading');
			expect(download?.canBeRemoved).toBe(false);
		});

		it('returns false when paused before finishing', async () => {
			vi.stubGlobal(
				'fetch',
				mockRpcTorrentGet({ ...baseTorrent, status: 0, isFinished: false, percentDone: 0 })
			);

			const client = createClient();
			const download = await client.getDownload('deadbeef');

			expect(download?.status).toBe('paused');
			expect(download?.canBeRemoved).toBe(false);
		});
	});
});
