import { afterEach, describe, expect, it, vi } from 'vitest';
import { QBittorrentClient } from './QBittorrentClient';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('QBittorrentClient sequential download', () => {
	it.each([
		[true, 'true'],
		[false, null]
	] as const)('sends the add option only when enabled (%s)', async (enabled, expected) => {
		let addBody: FormData | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				if (String(url).endsWith('/api/v2/auth/login')) {
					return new Response('Ok.', {
						status: 200,
						headers: { 'set-cookie': 'SID=test-session; path=/' }
					});
				}
				if (String(url).endsWith('/api/v2/torrents/add')) {
					addBody = init?.body as FormData;
					return new Response('Ok.', { status: 200 });
				}
				throw new Error(`Unexpected qBittorrent request: ${String(url)}`);
			})
		);

		const client = new QBittorrentClient({
			host: 'localhost',
			port: 8080,
			useSsl: false,
			sequentialDownload: enabled
		});

		await client.addDownload({
			downloadUrl: 'https://example.com/test.torrent',
			category: 'movies'
		});

		expect(addBody?.get('sequentialDownload')).toBe(expected);
	});
});

describe('QBittorrentClient add response parsing', () => {
	function stubAddResponse(body: string, status = 200): void {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL | Request) => {
				if (String(url).endsWith('/api/v2/auth/login')) {
					return new Response('Ok.', {
						status: 200,
						headers: { 'set-cookie': 'SID=test-session; path=/' }
					});
				}
				if (String(url).endsWith('/api/v2/torrents/add')) {
					return new Response(body, { status });
				}
				throw new Error(`Unexpected qBittorrent request: ${String(url)}`);
			})
		);
	}

	function createClient(): QBittorrentClient {
		return new QBittorrentClient({
			host: 'localhost',
			port: 8080,
			useSsl: false
		});
	}

	function stubTorrent(hash: string) {
		return {
			hash,
			name: 'test',
			state: 'uploading',
			size: 0,
			progress: 0,
			dlspeed: 0,
			upspeed: 0,
			priority: 0,
			num_seeds: 0,
			num_complete: 0,
			num_leechs: 0,
			num_incomplete: 0,
			ratio: 0,
			eta: 0,
			category: 'movies',
			save_path: '/downloads',
			content_path: '/downloads/test',
			downloaded: 0,
			uploaded: 0,
			tags: ''
		};
	}

	function stubPreferences() {
		return {
			save_path: '/downloads',
			max_ratio_enabled: false,
			max_ratio: -1,
			max_seeding_time_enabled: false,
			max_seeding_time: -1,
			max_ratio_act: 0
		};
	}

	it('accepts a successful WebAPI v2.14 response containing failure_count', async () => {
		stubAddResponse(
			JSON.stringify({
				added_torrent_ids: ['3e0e520f8ac598a94539458192f71cbd01857c1e'],
				failure_count: 0,
				pending_count: 0,
				success_count: 1
			})
		);

		await expect(
			createClient().addDownload({
				downloadUrl: 'https://example.com/test.torrent',
				category: 'movies'
			})
		).resolves.toBe('3e0e520f8ac598a94539458192f71cbd01857c1e');
	});

	it('accepts a pending WebAPI v2.14 response', async () => {
		stubAddResponse(
			JSON.stringify({
				added_torrent_ids: [],
				failure_count: 0,
				pending_count: 1,
				success_count: 0
			}),
			202
		);

		await expect(
			createClient().addDownload({
				downloadUrl: 'https://example.com/test.torrent',
				category: 'movies'
			})
		).resolves.toBe('');
	});

	it('rejects a failed WebAPI v2.14 response', async () => {
		stubAddResponse(
			JSON.stringify({
				added_torrent_ids: [],
				failure_count: 1,
				pending_count: 0,
				success_count: 0
			})
		);

		await expect(
			createClient().addDownload({
				downloadUrl: 'https://example.com/test.torrent',
				category: 'movies'
			})
		).rejects.toThrow('qBittorrent rejected the torrent');
	});

	it('continues to reject the legacy Fails. response', async () => {
		stubAddResponse('Fails.');

		await expect(
			createClient().addDownload({
				downloadUrl: 'https://example.com/test.torrent',
				category: 'movies'
			})
		).rejects.toThrow('qBittorrent rejected the torrent: Fails.');
	});

	it('detects duplicate via infoHash on structured failure', async () => {
		const hash = 'abc123def456abc123def456abc123def456abc1';
		const magnetUrl = `magnet:?xt=urn:btih:${hash}&dn=test`;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL | Request) => {
				const u = String(url);
				if (u.endsWith('/api/v2/auth/login'))
					return new Response('Ok.', {
						status: 200,
						headers: { 'set-cookie': 'SID=test-session; path=/' }
					});
				if (u.endsWith('/api/v2/torrents/add'))
					return new Response(
						JSON.stringify({
							added_torrent_ids: [],
							failure_count: 1,
							pending_count: 0,
							success_count: 0
						}),
						{ status: 200 }
					);
				if (u.includes('/api/v2/app/preferences'))
					return new Response(JSON.stringify(stubPreferences()), { status: 200 });
				if (u.includes('/api/v2/torrents/info'))
					return new Response(JSON.stringify([stubTorrent(hash)]), { status: 200 });
				throw new Error(`Unexpected request: ${u}`);
			})
		);

		const err = await createClient()
			.addDownload({ magnetUri: magnetUrl, category: 'movies' })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as { isDuplicate?: boolean }).isDuplicate).toBe(true);
	});

	it('applies forceStart using hash returned by structured add response', async () => {
		const returnedHash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
		const setForceStartCalled: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL | Request) => {
				const u = String(url);
				if (u.endsWith('/api/v2/auth/login'))
					return new Response('Ok.', {
						status: 200,
						headers: { 'set-cookie': 'SID=test-session; path=/' }
					});
				if (u.endsWith('/api/v2/torrents/add'))
					return new Response(
						JSON.stringify({
							added_torrent_ids: [returnedHash],
							failure_count: 0,
							pending_count: 0,
							success_count: 1
						}),
						{ status: 200 }
					);
				if (u.includes('/api/v2/app/preferences'))
					return new Response(JSON.stringify(stubPreferences()), { status: 200 });
				if (u.includes('/api/v2/torrents/info'))
					return new Response(JSON.stringify([stubTorrent(returnedHash)]), { status: 200 });
				if (u.includes('/api/v2/torrents/setForceStart')) {
					setForceStartCalled.push(u);
					return new Response('Ok.', { status: 200 });
				}
				throw new Error(`Unexpected request: ${u}`);
			})
		);

		await createClient().addDownload({
			downloadUrl: 'https://example.com/test.torrent',
			category: 'movies',
			priority: 'force'
		});

		expect(setForceStartCalled.length).toBe(1);
	});
});

describe('QBittorrentClient extendFileSelection', () => {
	it('marks only the additional files as wanted', async () => {
		const priorityCalls: string[] = [];

		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				const u = String(url);
				if (u.endsWith('/api/v2/auth/login')) {
					return new Response('Ok.', {
						status: 200,
						headers: { 'set-cookie': 'SID=test-session; path=/' }
					});
				}
				if (u.includes('/api/v2/torrents/files?')) {
					return new Response(
						JSON.stringify([
							{ index: 0, name: 'Show/S01E01.mkv', size: 10, priority: 0 },
							{ index: 1, name: 'Show/S01E02.mkv', size: 10, priority: 0 },
							{ index: 2, name: 'Show/S01E03.mkv', size: 10, priority: 0 }
						]),
						{ status: 200 }
					);
				}
				if (u.endsWith('/api/v2/torrents/filePrio')) {
					priorityCalls.push(String(init?.body));
					return new Response('Ok.', { status: 200 });
				}
				throw new Error(`Unexpected qBittorrent request: ${u}`);
			})
		);

		const client = new QBittorrentClient({
			host: 'localhost',
			port: 8080,
			useSsl: false
		});

		await client.extendFileSelection('abc123', { fileIndices: [1, 2] });

		expect(priorityCalls).toHaveLength(1);
		const body = new URLSearchParams(priorityCalls[0]);
		expect(body.get('priority')).toBe('1');
		expect(body.get('id')).toBe('1|2');
	});
});
