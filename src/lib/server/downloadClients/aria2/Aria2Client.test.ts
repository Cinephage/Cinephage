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
});
