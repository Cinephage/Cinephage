import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelugeClient } from './DelugeClient';

function createClient(): DelugeClient {
	return new DelugeClient({
		host: 'localhost',
		port: 8112,
		useSsl: false,
		password: 'deluge'
	});
}

interface RpcRequestPayload {
	method?: string;
	params?: unknown[];
}

function mockDelugeResponse(torrent: Record<string, unknown>): ReturnType<typeof vi.fn> {
	return vi.fn(async (_url: string, init?: RequestInit) => {
		const payload = JSON.parse(String(init?.body ?? '{}')) as RpcRequestPayload;

		if (payload.method === 'auth.login') {
			return new Response(JSON.stringify({ result: true, error: null }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (payload.method === 'web.connected') {
			return new Response(JSON.stringify({ result: true, error: null }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		if (payload.method === 'web.update_ui' || payload.method === 'web.get_torrent_status') {
			// Deluge answers with the requested status keys only, so a key the
			// client asks for that Deluge does not expose never arrives.
			const keys = (payload.params?.[0] as string[] | undefined) ?? [];
			const answered = Object.fromEntries(
				Object.entries(torrent).filter(([key]) => keys.includes(key))
			);
			return new Response(
				JSON.stringify({
					result: { torrents: { deadbeef: answered } },
					error: null
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);
		}

		return new Response(JSON.stringify({ result: {}, error: null }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	});
}

describe('DelugeClient', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function mockAddFlow(
		captured: RpcRequestPayload[],
		downloadLocation = '/downloads'
	): ReturnType<typeof vi.fn> {
		return vi.fn(async (_url: string, init?: RequestInit) => {
			const payload = JSON.parse(String(init?.body ?? '{}')) as RpcRequestPayload;
			captured.push(payload);

			switch (payload.method) {
				case 'auth.login':
				case 'web.connected':
					return new Response(JSON.stringify({ result: true, error: null }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					});
				case 'web.get_torrent_status':
					return new Response(JSON.stringify({ result: {}, error: null }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					});
				case 'web.update_ui':
					return new Response(JSON.stringify({ result: { torrents: {} }, error: null }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					});
				case 'core.get_config_values':
					return new Response(
						JSON.stringify({ result: { download_location: downloadLocation }, error: null }),
						{ status: 200, headers: { 'Content-Type': 'application/json' } }
					);
				case 'label.add':
					return new Response(JSON.stringify({ result: true, error: null }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					});
				case 'core.add_torrent_magnet':
					return new Response(
						JSON.stringify({
							result: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
							error: null
						}),
						{ status: 200, headers: { 'Content-Type': 'application/json' } }
					);
				default:
					return new Response(JSON.stringify({ result: {}, error: null }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					});
			}
		});
	}

	describe('addDownload category paths', () => {
		it('derives download_location from category when savePath is absent', async () => {
			const captured: RpcRequestPayload[] = [];
			vi.stubGlobal('fetch', mockAddFlow(captured));

			const client = createClient();
			const hash = await client.addDownload({
				magnetUri: 'magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
				category: 'movies'
			});

			expect(hash).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
			const addCall = captured.find((call) => call.method === 'core.add_torrent_magnet');
			const addOptions = addCall?.params?.[1] as Record<string, unknown>;
			expect(addOptions.download_location).toBe('/downloads/movies');
			// The classic label plugin has no label add-option; it must be applied
			// via label.set_torrent after the add succeeds, not in addOptions.
			expect(addOptions.label).toBeUndefined();
			expect(captured.some((call) => call.method === 'label.add')).toBe(true);
			const labelSetCall = captured.find((call) => call.method === 'label.set_torrent');
			expect(labelSetCall?.params).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'movies']);
		});

		it('prefers an explicit savePath over the derived category path', async () => {
			const captured: RpcRequestPayload[] = [];
			vi.stubGlobal('fetch', mockAddFlow(captured));

			const client = createClient();
			await client.addDownload({
				magnetUri: 'magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
				category: 'movies',
				savePath: '/custom/path'
			});

			const addCall = captured.find((call) => call.method === 'core.add_torrent_magnet');
			const addOptions = addCall?.params?.[1] as Record<string, unknown>;
			expect(addOptions.download_location).toBe('/custom/path');
			expect(captured.some((call) => call.method === 'core.get_config_values')).toBe(false);
		});
	});

	describe('canBeRemoved', () => {
		const baseTorrent = {
			name: 'test',
			total_size: 1000,
			total_done: 1000,
			progress: 100,
			download_payload_rate: 0,
			upload_payload_rate: 0,
			eta: 0,
			save_path: '/downloads',
			label: '',
			time_added: 1234567890,
			finished_time: 1234567900,
			seeding_time: 3600,
			ratio: 1.5,
			hash: 'deadbeef',
			error: ''
		};

		it('returns true when seeding and ratio limit is reached', async () => {
			vi.stubGlobal(
				'fetch',
				mockDelugeResponse({
					...baseTorrent,
					state: 'Seeding',
					stop_at_ratio: true,
					stop_ratio: 1.0
				})
			);

			const client = createClient();
			const download = await client.getDownload('deadbeef');

			expect(download?.status).toBe('seeding');
			expect(download?.canBeRemoved).toBe(true);
			expect(download?.ratioLimit).toBe(1.0);
		});

		it('returns false when seeding and ratio limit is not reached', async () => {
			vi.stubGlobal(
				'fetch',
				mockDelugeResponse({
					...baseTorrent,
					state: 'Seeding',
					stop_at_ratio: true,
					stop_ratio: 2.0
				})
			);

			const client = createClient();
			const download = await client.getDownload('deadbeef');

			expect(download?.status).toBe('seeding');
			expect(download?.canBeRemoved).toBe(false);
			expect(download?.ratioLimit).toBe(2.0);
		});

		it('returns false when seeding and stop_at_ratio is disabled', async () => {
			vi.stubGlobal(
				'fetch',
				mockDelugeResponse({
					...baseTorrent,
					state: 'Seeding',
					stop_at_ratio: false,
					stop_ratio: 1.0
				})
			);

			const client = createClient();
			const download = await client.getDownload('deadbeef');

			expect(download?.status).toBe('seeding');
			expect(download?.canBeRemoved).toBe(false);
			expect(download?.ratioLimit).toBeUndefined();
		});

		it('returns true when paused regardless of ratio', async () => {
			vi.stubGlobal(
				'fetch',
				mockDelugeResponse({
					...baseTorrent,
					state: 'Paused',
					stop_at_ratio: true,
					stop_ratio: 2.0
				})
			);

			const client = createClient();
			const download = await client.getDownload('deadbeef');

			expect(download?.status).toBe('paused');
			expect(download?.canBeRemoved).toBe(true);
		});

		it('returns true when completed regardless of ratio', async () => {
			vi.stubGlobal(
				'fetch',
				mockDelugeResponse({
					...baseTorrent,
					state: 'Seeding',
					progress: 100,
					stop_at_ratio: true,
					stop_ratio: 2.0
				})
			);

			const client = createClient();
			const download = await client.getDownload('deadbeef');

			// Deluge "Seeding" with progress=100 maps to 'seeding' status
			expect(download?.status).toBe('seeding');
			expect(download?.canBeRemoved).toBe(false);
		});
	});
});

describe('DelugeClient swarm signals', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const downloading = {
		name: 'Some.Release',
		total_size: 1000,
		total_wanted: 1000,
		total_done: 65,
		progress: 6.5,
		state: 'Downloading',
		download_payload_rate: 0,
		upload_payload_rate: 0,
		eta: 0,
		save_path: '/downloads',
		label: 'tv',
		hash: 'deadbeef',
		error: '',
		num_seeds: 0,
		num_peers: 1,
		distributed_copies: 0.065,
		private: true,
		has_metadata: true
	};

	it('maps seeds, peers, availability, downloaded bytes and the private flag', async () => {
		vi.stubGlobal('fetch', mockDelugeResponse(downloading));
		const client = new DelugeClient({
			host: 'localhost',
			port: 8112,
			useSsl: false,
			password: 'deluge'
		});
		const d = await client.getDownload('deadbeef');
		expect(d).toMatchObject({
			downloadedBytes: 65,
			connectedSeeds: 0,
			connectedPeers: 1,
			availability: 0.065,
			isPrivate: true,
			metadataPending: false
		});
	});

	it('reports a download that receives nothing as stalled', async () => {
		vi.stubGlobal('fetch', mockDelugeResponse(downloading));
		const client = new DelugeClient({
			host: 'localhost',
			port: 8112,
			useSsl: false,
			password: 'deluge'
		});
		expect((await client.getDownload('deadbeef'))?.status).toBe('stalled');
	});

	it('keeps a download that receives data as downloading', async () => {
		vi.stubGlobal('fetch', mockDelugeResponse({ ...downloading, download_payload_rate: 2048 }));
		const client = new DelugeClient({
			host: 'localhost',
			port: 8112,
			useSsl: false,
			password: 'deluge'
		});
		expect((await client.getDownload('deadbeef'))?.status).toBe('downloading');
	});

	it('flags a magnet still fetching metadata', async () => {
		vi.stubGlobal(
			'fetch',
			mockDelugeResponse({
				...downloading,
				total_size: 0,
				total_done: 0,
				download_payload_rate: 10
			})
		);
		const client = new DelugeClient({
			host: 'localhost',
			port: 8112,
			useSsl: false,
			password: 'deluge'
		});
		const d = await client.getDownload('deadbeef');
		expect(d?.metadataPending).toBe(true);
		expect(d?.status).toBe('stalled');
	});

	it('asks only for status keys Deluge reports', async () => {
		const fetchMock = mockDelugeResponse({ ...downloading });
		vi.stubGlobal('fetch', fetchMock);
		const client = new DelugeClient({
			host: 'localhost',
			port: 8112,
			useSsl: false,
			password: 'deluge'
		});
		await client.getDownload('deadbeef');

		const bodies = fetchMock.mock.calls
			.map((call) => JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}')))
			.filter((body) => body.params?.[0]);
		const keys = bodies.at(-1)?.params?.[0] as string[];
		expect(keys).toContain('total_size');
		expect(keys).not.toContain('has_metadata');
	});
});
