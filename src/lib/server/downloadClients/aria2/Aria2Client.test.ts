import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Aria2Client } from './Aria2Client';

describe('Aria2Client', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const gid = '0123456789abcdef';

	const baseStatus = {
		gid,
		status: 'active',
		totalLength: '1000',
		completedLength: '1000',
		downloadSpeed: '0',
		uploadSpeed: '1024',
		uploadLength: '500',
		eta: '0',
		dir: '/downloads',
		files: [{ path: '/downloads/test.mkv', length: '1000', selected: 'true' }],
		bittorrent: { infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', info: { name: 'test' } }
	};

	function mockTellStatus(status: Record<string, unknown>): ReturnType<typeof vi.fn> {
		return vi.fn(async (_url: string, init?: RequestInit) => {
			const payload = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
			if (payload.method !== 'aria2.tellStatus') {
				return new Response(JSON.stringify({ jsonrpc: '2.0', id: '0', result: null }), {
					status: 200
				});
			}
			return new Response(
				JSON.stringify({ jsonrpc: '2.0', id: '0', result: { ...baseStatus, ...status } }),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);
		});
	}

	it('is not removable while actively seeding', async () => {
		vi.stubGlobal('fetch', mockTellStatus({}));

		const client = new Aria2Client({ host: 'localhost', port: 6800, useSsl: false });
		const download = await client.getDownload(gid);

		expect(download?.status).toBe('seeding');
		expect(download?.canBeRemoved).toBe(false);
	});

	it('is removable once aria2 marks the download complete', async () => {
		vi.stubGlobal('fetch', mockTellStatus({ status: 'complete', uploadSpeed: '0' }));

		const client = new Aria2Client({ host: 'localhost', port: 6800, useSsl: false });
		const download = await client.getDownload(gid);

		expect(download?.status).toBe('completed');
		expect(download?.canBeRemoved).toBe(true);
	});

	it('is not removable while downloading', async () => {
		vi.stubGlobal(
			'fetch',
			mockTellStatus({
				status: 'active',
				completedLength: '500',
				downloadSpeed: '1024',
				uploadSpeed: '0',
				uploadLength: '0'
			})
		);

		const client = new Aria2Client({ host: 'localhost', port: 6800, useSsl: false });
		const download = await client.getDownload(gid);

		expect(download?.status).toBe('downloading');
		expect(download?.canBeRemoved).toBe(false);
	});

	it('is not removable when paused before finishing', async () => {
		vi.stubGlobal(
			'fetch',
			mockTellStatus({
				status: 'paused',
				completedLength: '500',
				uploadSpeed: '0',
				uploadLength: '0'
			})
		);

		const client = new Aria2Client({ host: 'localhost', port: 6800, useSsl: false });
		const download = await client.getDownload(gid);

		expect(download?.status).toBe('paused');
		expect(download?.canBeRemoved).toBe(false);
	});

	describe('swarm signals', () => {
		it('maps connected seeders and downloaded bytes, and reports no data as stalled', async () => {
			vi.stubGlobal(
				'fetch',
				mockTellStatus({
					completedLength: '65',
					downloadSpeed: '0',
					uploadSpeed: '0',
					numSeeders: '0',
					connections: '1'
				})
			);
			const d = await new Aria2Client({ host: 'localhost', port: 6800, useSsl: false }).getDownload(
				gid
			);
			expect(d).toMatchObject({
				status: 'stalled',
				downloadedBytes: 65,
				connectedSeeds: 0,
				connectedPeers: 1,
				metadataPending: false
			});
		});

		it('flags a magnet download that has no metadata yet', async () => {
			vi.stubGlobal(
				'fetch',
				mockTellStatus({
					totalLength: '0',
					completedLength: '0',
					downloadSpeed: '100',
					uploadSpeed: '0',
					bittorrent: { infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
				})
			);
			const d = await new Aria2Client({ host: 'localhost', port: 6800, useSsl: false }).getDownload(
				gid
			);
			expect(d?.metadataPending).toBe(true);
			expect(d?.status).toBe('stalled');
		});

		it('leaves plain HTTP downloads alone', async () => {
			vi.stubGlobal(
				'fetch',
				mockTellStatus({
					completedLength: '65',
					downloadSpeed: '0',
					uploadSpeed: '0',
					bittorrent: undefined
				})
			);
			const d = await new Aria2Client({ host: 'localhost', port: 6800, useSsl: false }).getDownload(
				gid
			);
			expect(d?.status).toBe('downloading');
			expect(d?.connectedSeeds).toBeUndefined();
		});
	});
});
