/**
 * SABnzbd reports its completed folder relative by default (Docker), but the
 * storage path of a finished job is absolute. These drive the real client against
 * a real filesystem, because "is this importable" is a fact about the disk, not
 * about a string.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SABnzbdClient } from './SABnzbdClient.js';
import type { SabnzbdConfig } from './types.js';

let root = '';

function makeClient(localRoot?: string): SABnzbdClient {
	return new SABnzbdClient({
		host: '127.0.0.1',
		port: 8080,
		useSsl: false,
		apiKey: 'test-api-key',
		downloadPathLocal: localRoot,
		misc: {}
	} as unknown as SabnzbdConfig);
}

function stubSabnzbd(opts: { completeDir: string; storage: string }) {
	const item = {
		completed: 1_700_000_000,
		name: 'The.Show.S01.1080p',
		nzb_name: 'The.Show.S01.1080p.nzb',
		category: 'tv',
		storage: opts.storage,
		path: opts.storage,
		bytes: 1024,
		status: 'Completed',
		fail_message: '',
		download_time: 10
	};

	const fetchMock = vi.fn().mockImplementation(async (url: string) => {
		const params = new URL(url).searchParams;
		const mode = params.get('mode');
		const archived = params.get('archive') === '1';

		let body: unknown;
		switch (mode) {
			case 'get_config':
				body = {
					config: {
						misc: { complete_dir: opts.completeDir, download_dir: 'Downloads/incomplete' },
						categories: []
					}
				};
				break;
			case 'history':
				body = {
					history: { slots: archived ? [] : [item], noofslots: archived ? 0 : 1 }
				};
				break;
			case 'queue':
				body = { queue: { slots: [], noofslots: 0 } };
				break;
			default:
				body = {};
		}
		return { ok: true, text: async () => JSON.stringify(body) };
	});

	vi.stubGlobal('fetch', fetchMock);
}

async function completedFolder(): Promise<string> {
	const folder = join(root, 'config', 'Downloads', 'complete', `Show.${randomUUID().slice(0, 6)}`);
	await mkdir(folder, { recursive: true });
	await writeFile(join(folder, 'episode.mkv'), 'x');
	return folder;
}

beforeAll(async () => {
	root = join(tmpdir(), `sab-complete-${randomUUID().slice(0, 8)}`);
	await mkdir(root, { recursive: true });
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true }).catch(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('SABnzbd completion detection against the real filesystem', () => {
	it('imports a finished job when SABnzbd reports the completed folder relatively (Docker default)', async () => {
		// storage is absolute in SABnzbd's namespace, complete_dir is relative: the
		// two cannot be prefix-compared until the base is anchored in the storage path.
		const folder = await completedFolder();
		stubSabnzbd({ completeDir: 'Downloads/complete', storage: folder });

		const downloads = await makeClient().getDownloads();

		expect(downloads).toHaveLength(1);
		expect(downloads[0].status).toBe('completed');
		expect(downloads[0].contentPath).toBe(folder);
		expect(downloads[0].errorMessage).toBeUndefined();
	});

	it('refuses to import when this host cannot read the finished path, and says why', async () => {
		const missing = join(root, 'config', 'Downloads', 'complete', 'Gone.Externally');
		stubSabnzbd({ completeDir: 'Downloads/complete', storage: missing });

		const downloads = await makeClient().getDownloads();

		expect(downloads).toHaveLength(1);
		expect(downloads[0].status).toBe('postprocessing');
		expect(downloads[0].errorMessage).toContain('which this host cannot read');
	});

	it('keeps a job outside the completed folder blocked, with the reason', async () => {
		// An absolute category folder lands the job somewhere the completed folder
		// does not contain; that must not be guessed at.
		const outside = join(root, 'media', 'tv', `Show.${randomUUID().slice(0, 6)}`);
		await mkdir(outside, { recursive: true });
		stubSabnzbd({ completeDir: join(root, 'config', 'Downloads', 'complete'), storage: outside });

		const downloads = await makeClient().getDownloads();

		expect(downloads[0].status).toBe('postprocessing');
		expect(downloads[0].errorMessage).toContain('outside its completed folder');
	});
});
