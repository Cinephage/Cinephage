import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RTorrentClient } from './RTorrentClient';

function xmlResponse(innerValue: string): string {
	return `<?xml version="1.0"?><methodResponse><params><param><value>${innerValue}</value></param></params></methodResponse>`;
}

function xmlString(value: string): string {
	return xmlResponse(`<string>${value}</string>`);
}

function xmlInt(value: number): string {
	return xmlResponse(`<int>${value}</int>`);
}

function xmlI8(value: number): string {
	return xmlResponse(`<i8>${value}</i8>`);
}

function xmlStringArray(values: string[]): string {
	const entries = values.map((value) => `<value><string>${value}</string></value>`).join('');
	return xmlResponse(`<array><data>${entries}</data></array>`);
}

describe('RTorrentClient', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('collects hashes from fallback views when main is empty', async () => {
		const hash = '8eaca075d467a373b871dff7b9b694ea532b6a43';
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = String(init?.body ?? '');
			const method = body.match(/<methodName>([^<]+)<\/methodName>/)?.[1] ?? '';

			if (method === 'd.multicall2') {
				if (body.includes('<string>default</string>')) {
					return new Response(xmlStringArray([hash]), { status: 200 });
				}
				return new Response(xmlStringArray([]), { status: 200 });
			}

			if (method === 'd.multicall' || method === 'download_list') {
				return new Response(xmlStringArray([]), { status: 200 });
			}

			return new Response(xmlInt(0), { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false
		});

		const getTorrentHashes = (
			client as unknown as { getTorrentHashes: () => Promise<string[]> }
		).getTorrentHashes.bind(client);
		const hashes = await getTorrentHashes();

		expect(hashes).toEqual([hash]);
	});

	it('does not falsely treat a missing hash as duplicate during add', async () => {
		const infoHash = '3bd0fecad68932cb2e320d4dc19b750a36824173';
		const methodsCalled: string[] = [];

		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = String(init?.body ?? '');
			const method = body.match(/<methodName>([^<]+)<\/methodName>/)?.[1] ?? '';
			methodsCalled.push(method);

			if (method === 'd.multicall2' || method === 'd.multicall' || method === 'download_list') {
				return new Response(xmlStringArray([]), { status: 200 });
			}

			if (method === 'load.start') {
				return new Response(xmlInt(0), { status: 200 });
			}

			if (method === 'system.client_version' || method === 'system.client_version.get') {
				return new Response(xmlString('0.0.0'), { status: 200 });
			}

			return new Response(xmlInt(0), { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false
		});

		const result = await client.addDownload({ infoHash, category: 'movies' });

		expect(result).toBe(infoHash);
		expect(methodsCalled).toContain('load.start');
	});

	it('treats started magnet metadata state as downloading (not paused)', async () => {
		const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = String(init?.body ?? '');
			const method = body.match(/<methodName>([^<]+)<\/methodName>/)?.[1] ?? '';

			if (method === 'd.multicall2') {
				if (body.includes('<string>main</string>')) {
					return new Response(xmlStringArray([hash]), { status: 200 });
				}
				return new Response(xmlStringArray([]), { status: 200 });
			}

			if (method === 'd.multicall' || method === 'download_list') {
				return new Response(xmlStringArray([]), { status: 200 });
			}

			switch (method) {
				case 'd.name':
					return new Response(xmlString('magnet item'), { status: 200 });
				case 'd.size_bytes':
				case 'd.completed_bytes':
				case 'd.down.rate':
				case 'd.up.rate':
				case 'd.is_active':
				case 'd.complete':
				case 'd.ratio':
				case 'd.creation_date':
					return new Response(xmlInt(0), { status: 200 });
				case 'd.state':
					return new Response(xmlInt(1), { status: 200 });
				case 'd.directory':
					return new Response(xmlString('/downloads/incoming'), { status: 200 });
				case 'd.custom1':
					return new Response(xmlString('movies'), { status: 200 });
				default:
					return new Response(xmlInt(0), { status: 200 });
			}
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false
		});

		const download = await client.getDownload(hash);

		expect(download).toBeTruthy();
		expect(download?.status).toBe('downloading');
	});

	it('parses i8 numeric RPC values for status/progress/rates', async () => {
		const hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = String(init?.body ?? '');
			const method = body.match(/<methodName>([^<]+)<\/methodName>/)?.[1] ?? '';

			if (method === 'd.multicall2') {
				if (body.includes('<string>main</string>')) {
					return new Response(xmlStringArray([hash]), { status: 200 });
				}
				return new Response(xmlStringArray([]), { status: 200 });
			}

			if (method === 'd.multicall' || method === 'download_list') {
				return new Response(xmlStringArray([]), { status: 200 });
			}

			switch (method) {
				case 'd.name':
					return new Response(xmlString('active download'), { status: 200 });
				case 'd.size_bytes':
					return new Response(xmlI8(2_000_000_000), { status: 200 });
				case 'd.completed_bytes':
					return new Response(xmlI8(20_000_000), { status: 200 });
				case 'd.down.rate':
					return new Response(xmlI8(160_000), { status: 200 });
				case 'd.up.rate':
					return new Response(xmlI8(0), { status: 200 });
				case 'd.is_active':
				case 'd.state':
					return new Response(xmlI8(1), { status: 200 });
				case 'd.complete':
					return new Response(xmlI8(0), { status: 200 });
				case 'd.ratio':
				case 'd.creation_date':
					return new Response(xmlI8(0), { status: 200 });
				case 'd.directory':
					return new Response(xmlString('/downloads/incoming'), { status: 200 });
				case 'd.custom1':
					return new Response(xmlString('movies'), { status: 200 });
				default:
					return new Response(xmlInt(0), { status: 200 });
			}
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false
		});

		const download = await client.getDownload(hash);

		expect(download).toBeTruthy();
		expect(download?.status).toBe('downloading');
		expect(download?.size).toBe(2_000_000_000);
		expect(download?.downloadSpeed).toBe(160_000);
		expect(download?.progress).toBeGreaterThan(0);
	});

	it('uses rTorrent base_path as contentPath when available', async () => {
		const hash = 'cccccccccccccccccccccccccccccccccccccccc';
		const basePath = '/downloads/completed/The.Lord.of.the.Rings.mp4';

		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = String(init?.body ?? '');
			const method = body.match(/<methodName>([^<]+)<\/methodName>/)?.[1] ?? '';

			if (method === 'd.multicall2') {
				if (body.includes('<string>main</string>')) {
					return new Response(xmlStringArray([hash]), { status: 200 });
				}
				return new Response(xmlStringArray([]), { status: 200 });
			}

			if (method === 'd.multicall' || method === 'download_list') {
				return new Response(xmlStringArray([]), { status: 200 });
			}

			switch (method) {
				case 'd.name':
					return new Response(xmlString('The.Lord.of.the.Rings.mp4'), { status: 200 });
				case 'd.directory':
					return new Response(xmlString('/downloads/completed'), { status: 200 });
				case 'd.base_path':
					return new Response(xmlString(basePath), { status: 200 });
				case 'd.size_bytes':
				case 'd.completed_bytes':
				case 'd.down.rate':
				case 'd.up.rate':
				case 'd.is_active':
				case 'd.state':
				case 'd.complete':
				case 'd.ratio':
				case 'd.creation_date':
					return new Response(xmlI8(0), { status: 200 });
				case 'd.custom1':
					return new Response(xmlString('movies'), { status: 200 });
				default:
					return new Response(xmlInt(0), { status: 200 });
			}
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false
		});

		const download = await client.getDownload(hash);

		expect(download).toBeTruthy();
		expect(download?.contentPath).toBe(basePath);
	});

	it('does not duplicate name when directory already includes torrent name', async () => {
		const hash = 'dddddddddddddddddddddddddddddddddddddddd';
		const name = 'The Lord of the Rings The Fellowship of the Ring EXTENDED (2001)';
		const directory = `/downloads/completed/${name}`;

		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = String(init?.body ?? '');
			const method = body.match(/<methodName>([^<]+)<\/methodName>/)?.[1] ?? '';

			if (method === 'd.multicall2') {
				if (body.includes('<string>main</string>')) {
					return new Response(xmlStringArray([hash]), { status: 200 });
				}
				return new Response(xmlStringArray([]), { status: 200 });
			}

			if (method === 'd.multicall' || method === 'download_list') {
				return new Response(xmlStringArray([]), { status: 200 });
			}

			switch (method) {
				case 'd.name':
					return new Response(xmlString(name), { status: 200 });
				case 'd.directory':
					return new Response(xmlString(directory), { status: 200 });
				case 'd.base_path':
					return new Response(xmlString(''), { status: 200 });
				case 'd.size_bytes':
				case 'd.completed_bytes':
				case 'd.down.rate':
				case 'd.up.rate':
				case 'd.is_active':
				case 'd.state':
				case 'd.complete':
				case 'd.ratio':
				case 'd.creation_date':
					return new Response(xmlI8(0), { status: 200 });
				case 'd.custom1':
					return new Response(xmlString('movies'), { status: 200 });
				default:
					return new Response(xmlInt(0), { status: 200 });
			}
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false
		});

		const download = await client.getDownload(hash);

		expect(download).toBeTruthy();
		expect(download?.contentPath).toBe(directory);
	});

	it('matches directory and name when spacing differs (double spaces)', async () => {
		const hash = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
		const name = 'The Lord of the Rings The Fellowship of the Ring EXTENDED (2001)';
		const directory =
			'/downloads/completed/The Lord of the Rings The Fellowship of the Ring  EXTENDED (2001)';

		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = String(init?.body ?? '');
			const method = body.match(/<methodName>([^<]+)<\/methodName>/)?.[1] ?? '';

			if (method === 'd.multicall2') {
				if (body.includes('<string>main</string>')) {
					return new Response(xmlStringArray([hash]), { status: 200 });
				}
				return new Response(xmlStringArray([]), { status: 200 });
			}

			if (method === 'd.multicall' || method === 'download_list') {
				return new Response(xmlStringArray([]), { status: 200 });
			}

			switch (method) {
				case 'd.name':
					return new Response(xmlString(name), { status: 200 });
				case 'd.directory':
					return new Response(xmlString(directory), { status: 200 });
				case 'd.base_path':
					return new Response(xmlString(''), { status: 200 });
				case 'd.size_bytes':
				case 'd.completed_bytes':
				case 'd.down.rate':
				case 'd.up.rate':
				case 'd.is_active':
				case 'd.state':
				case 'd.complete':
				case 'd.ratio':
				case 'd.creation_date':
					return new Response(xmlI8(0), { status: 200 });
				case 'd.custom1':
					return new Response(xmlString('movies'), { status: 200 });
				default:
					return new Response(xmlInt(0), { status: 200 });
			}
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false
		});

		const download = await client.getDownload(hash);

		expect(download).toBeTruthy();
		expect(download?.contentPath).toBe(directory);
	});

	it('collapses duplicate terminal segment from base_path', async () => {
		const hash = 'ffffffffffffffffffffffffffffffffffffffff';
		const name = 'The Lord of the Rings The Fellowship of the Ring  EXTENDED (2001)';
		const duplicateBasePath = `/downloads/completed/${name}/${name}`;
		const expectedPath = `/downloads/completed/${name}`;

		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = String(init?.body ?? '');
			const method = body.match(/<methodName>([^<]+)<\/methodName>/)?.[1] ?? '';

			if (method === 'd.multicall2') {
				if (body.includes('<string>main</string>')) {
					return new Response(xmlStringArray([hash]), { status: 200 });
				}
				return new Response(xmlStringArray([]), { status: 200 });
			}

			if (method === 'd.multicall' || method === 'download_list') {
				return new Response(xmlStringArray([]), { status: 200 });
			}

			switch (method) {
				case 'd.name':
					return new Response(xmlString(name), { status: 200 });
				case 'd.directory':
					return new Response(xmlString(`/downloads/completed/${name}`), { status: 200 });
				case 'd.base_path':
					return new Response(xmlString(duplicateBasePath), { status: 200 });
				case 'd.size_bytes':
				case 'd.completed_bytes':
				case 'd.down.rate':
				case 'd.up.rate':
				case 'd.is_active':
				case 'd.state':
				case 'd.complete':
				case 'd.ratio':
				case 'd.creation_date':
					return new Response(xmlI8(0), { status: 200 });
				case 'd.custom1':
					return new Response(xmlString('movies'), { status: 200 });
				default:
					return new Response(xmlInt(0), { status: 200 });
			}
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false
		});

		const download = await client.getDownload(hash);

		expect(download).toBeTruthy();
		expect(download?.contentPath).toBe(expectedPath);
	});

	it('sets directory and label atomically at load time for categories', async () => {
		const infoHash = '3bd0fecad68932cb2e320d4dc19b750a36824173';
		const loadBodies: string[] = [];

		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = String(init?.body ?? '');
			const method = body.match(/<methodName>([^<]+)<\/methodName>/)?.[1] ?? '';

			if (method === 'directory.default') {
				return new Response(xmlString('/downloads'), { status: 200 });
			}

			if (method === 'd.multicall2' || method === 'd.multicall' || method === 'download_list') {
				return new Response(xmlStringArray([]), { status: 200 });
			}

			if (method === 'load.start') {
				loadBodies.push(body);
				return new Response(xmlInt(0), { status: 200 });
			}

			return new Response(xmlInt(0), { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false
		});

		const result = await client.addDownload({ infoHash, category: 'movies' });

		expect(result).toBe(infoHash);
		expect(loadBodies).toHaveLength(1);
		expect(loadBodies[0]).toContain('d.directory.set=&quot;/downloads/movies&quot;');
		expect(loadBodies[0]).toContain('d.custom1.set=&quot;movies&quot;');
	});

	it('quotes a category containing rTorrent command metacharacters', async () => {
		// rTorrent's own command parser (not XML) treats `,` as an argument
		// separator and `;` as a command separator within a single string;
		// an unquoted value here can splice in a second command.
		const infoHash = '3bd0fecad68932cb2e320d4dc19b750a36824173';
		const loadBodies: string[] = [];

		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = String(init?.body ?? '');
			const method = body.match(/<methodName>([^<]+)<\/methodName>/)?.[1] ?? '';

			if (method === 'directory.default') {
				return new Response(xmlString('/downloads'), { status: 200 });
			}
			if (method === 'd.multicall2' || method === 'd.multicall' || method === 'download_list') {
				return new Response(xmlStringArray([]), { status: 200 });
			}
			if (method === 'load.start') {
				loadBodies.push(body);
				return new Response(xmlInt(0), { status: 200 });
			}
			return new Response(xmlInt(0), { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false
		});

		await client.addDownload({ infoHash, category: 'movies;d.erase=' });

		expect(loadBodies).toHaveLength(1);
		// The whole value, semicolon included, stays inside one quoted argument.
		expect(loadBodies[0]).toContain('d.custom1.set=&quot;movies;d.erase=&quot;');
		expect(loadBodies[0]).not.toContain('d.custom1.set=movies;d.erase=');
	});

	it('escapes embedded quotes when quoting a category value', async () => {
		const infoHash = '3bd0fecad68932cb2e320d4dc19b750a36824173';
		const loadBodies: string[] = [];

		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = String(init?.body ?? '');
			const method = body.match(/<methodName>([^<]+)<\/methodName>/)?.[1] ?? '';

			if (method === 'directory.default') {
				return new Response(xmlString('/downloads'), { status: 200 });
			}
			if (method === 'd.multicall2' || method === 'd.multicall' || method === 'download_list') {
				return new Response(xmlStringArray([]), { status: 200 });
			}
			if (method === 'load.start') {
				loadBodies.push(body);
				return new Response(xmlInt(0), { status: 200 });
			}
			return new Response(xmlInt(0), { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false
		});

		await client.addDownload({ infoHash, category: 'He said "hi"' });

		expect(loadBodies).toHaveLength(1);
		expect(loadBodies[0]).toContain('d.custom1.set=&quot;He said \\&quot;hi\\&quot;&quot;');
	});

	it('prefers an explicit savePath over the derived category path', async () => {
		const infoHash = '3bd0fecad68932cb2e320d4dc19b750a36824173';
		const loadBodies: string[] = [];
		const methodsCalled: string[] = [];

		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = String(init?.body ?? '');
			const method = body.match(/<methodName>([^<]+)<\/methodName>/)?.[1] ?? '';
			methodsCalled.push(method);

			if (method === 'd.multicall2' || method === 'd.multicall' || method === 'download_list') {
				return new Response(xmlStringArray([]), { status: 200 });
			}

			if (method === 'load.start') {
				loadBodies.push(body);
				return new Response(xmlInt(0), { status: 200 });
			}

			return new Response(xmlInt(0), { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false
		});

		await client.addDownload({ infoHash, category: 'movies', savePath: '/custom/path' });

		expect(methodsCalled).not.toContain('directory.default');
		expect(loadBodies).toHaveLength(1);
		expect(loadBodies[0]).toContain('d.directory.set=&quot;/custom/path&quot;');
	});
});

describe('RTorrentClient canBeRemoved', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const hash = 'cccccccccccccccccccccccccccccccccccccccc';

	function mockTorrentRpc(props: Record<string, number | string>): ReturnType<typeof vi.fn> {
		return vi.fn(async (_url: string, init?: RequestInit) => {
			const body = String(init?.body ?? '');
			const method = body.match(/<methodName>([^<]+)<\/methodName>/)?.[1] ?? '';

			if (method === 'd.multicall2') {
				if (body.includes('<string>main</string>')) {
					return new Response(xmlStringArray([hash]), { status: 200 });
				}
				return new Response(xmlStringArray([]), { status: 200 });
			}
			if (method === 'd.multicall' || method === 'download_list') {
				return new Response(xmlStringArray([]), { status: 200 });
			}

			const value = props[method];
			if (value !== undefined) {
				return typeof value === 'string'
					? new Response(xmlString(value), { status: 200 })
					: new Response(xmlInt(value), { status: 200 });
			}
			if (method === 'd.name') {
				return new Response(xmlString('test'), { status: 200 });
			}
			return new Response(xmlInt(0), { status: 200 });
		});
	}

	it('is not removable while actively seeding', async () => {
		vi.stubGlobal(
			'fetch',
			mockTorrentRpc({
				'd.complete': 1,
				'd.is_active': 1,
				'd.up.rate': 2048,
				'd.down.rate': 0,
				'd.size_bytes': 1000,
				'd.completed_bytes': 1000,
				'd.state': 1
			})
		);

		const client = new RTorrentClient({ host: 'localhost', port: 80, useSsl: false });
		const download = await client.getDownload(hash);

		expect(download?.status).toBe('seeding');
		expect(download?.canBeRemoved).toBe(false);
	});

	it('is removable once finished, idle, and the ratio goal is met', async () => {
		vi.stubGlobal(
			'fetch',
			mockTorrentRpc({
				'd.complete': 1,
				'd.is_active': 0,
				'd.up.rate': 0,
				'd.down.rate': 0,
				'd.size_bytes': 1000,
				'd.completed_bytes': 1000,
				'd.state': 0,
				'd.ratio': 2000
			})
		);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false,
			seedRatioLimit: 1.5
		});
		const download = await client.getDownload(hash);

		expect(download?.status).toBe('completed');
		expect(download?.ratio).toBe(2);
		expect(download?.ratioLimit).toBe(1.5);
		expect(download?.canBeRemoved).toBe(true);
	});

	it('is removable via the seed-time goal using d.timestamp.finished', async () => {
		const finishedThreeHoursAgo = Math.floor(Date.now() / 1000) - 3 * 60 * 60;
		vi.stubGlobal(
			'fetch',
			mockTorrentRpc({
				'd.complete': 1,
				'd.is_active': 0,
				'd.up.rate': 0,
				'd.down.rate': 0,
				'd.size_bytes': 1000,
				'd.completed_bytes': 1000,
				'd.state': 0,
				'd.ratio': 0,
				'd.timestamp.finished': finishedThreeHoursAgo
			})
		);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false,
			seedTimeLimit: 120
		});
		const download = await client.getDownload(hash);

		expect(download?.status).toBe('completed');
		expect(download?.seedingTime).toBeGreaterThanOrEqual(3 * 60 * 60);
		expect(download?.canBeRemoved).toBe(true);
	});

	it('is not removable when the configured goals are not met', async () => {
		vi.stubGlobal(
			'fetch',
			mockTorrentRpc({
				'd.complete': 1,
				'd.is_active': 0,
				'd.up.rate': 0,
				'd.down.rate': 0,
				'd.size_bytes': 1000,
				'd.completed_bytes': 1000,
				'd.state': 0,
				'd.ratio': 500
			})
		);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false,
			seedRatioLimit: 1.5,
			seedTimeLimit: 120
		});
		const download = await client.getDownload(hash);

		expect(download?.status).toBe('completed');
		expect(download?.canBeRemoved).toBe(false);
	});

	it('is not removable when no seed goals are configured', async () => {
		vi.stubGlobal(
			'fetch',
			mockTorrentRpc({
				'd.complete': 1,
				'd.is_active': 0,
				'd.up.rate': 0,
				'd.down.rate': 0,
				'd.size_bytes': 1000,
				'd.completed_bytes': 1000,
				'd.state': 0
			})
		);

		const client = new RTorrentClient({ host: 'localhost', port: 80, useSsl: false });
		const download = await client.getDownload(hash);

		expect(download?.status).toBe('completed');
		expect(download?.canBeRemoved).toBe(false);
	});

	it('is not removable while actively seeding even with the ratio goal met', async () => {
		vi.stubGlobal(
			'fetch',
			mockTorrentRpc({
				'd.complete': 1,
				'd.is_active': 1,
				'd.up.rate': 2048,
				'd.down.rate': 0,
				'd.size_bytes': 1000,
				'd.completed_bytes': 1000,
				'd.state': 1,
				'd.ratio': 5000
			})
		);

		const client = new RTorrentClient({
			host: 'localhost',
			port: 80,
			useSsl: false,
			seedRatioLimit: 1.5
		});
		const download = await client.getDownload(hash);

		expect(download?.status).toBe('seeding');
		expect(download?.canBeRemoved).toBe(false);
	});

	it('is not removable while downloading', async () => {
		vi.stubGlobal(
			'fetch',
			mockTorrentRpc({
				'd.complete': 0,
				'd.is_active': 1,
				'd.up.rate': 0,
				'd.down.rate': 1024,
				'd.size_bytes': 1000,
				'd.completed_bytes': 500,
				'd.state': 1
			})
		);

		const client = new RTorrentClient({ host: 'localhost', port: 80, useSsl: false });
		const download = await client.getDownload(hash);

		expect(download?.status).toBe('downloading');
		expect(download?.canBeRemoved).toBe(false);
	});

	it('is not removable when paused before finishing', async () => {
		vi.stubGlobal(
			'fetch',
			mockTorrentRpc({
				'd.complete': 0,
				'd.is_active': 0,
				'd.up.rate': 0,
				'd.down.rate': 0,
				'd.size_bytes': 1000,
				'd.completed_bytes': 0,
				'd.state': 0
			})
		);

		const client = new RTorrentClient({ host: 'localhost', port: 80, useSsl: false });
		const download = await client.getDownload(hash);

		expect(download?.status).toBe('paused');
		expect(download?.canBeRemoved).toBe(false);
	});
});
