/**
 * Near-black-box debrid operational acceptance.
 *
 * Runs the public configure -> test -> acquisition setting -> grab workflow,
 * then lets the production DebridPollService consume that exact durable queue
 * row through the saved encrypted client and real provider adapter. Only the
 * paid provider HTTP boundary and direct-file origin are faked.
 */
import { createServer, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { api } from '../../test/api-helper';
import { clearTestDb, createTestDb, destroyTestDb, type TestDatabase } from '../../test/db-helper';
import {
	downloadClients,
	downloadHistory,
	downloadQueue,
	episodeFiles,
	episodes,
	movieFiles,
	movies,
	rootFolders,
	scoringProfiles,
	seasons,
	series
} from '#lib/server/db/schema.js';

const testDb: TestDatabase = createTestDb();
const SOURCE_AUTH_SECRET = 'acceptance-source-auth-secret-with-at-least-32-characters';
const BACKUP_PASSPHRASE = 'acceptance-portable-backup-passphrase';
const FILE_BYTES = 'hello world';
const FILE_SIZE = FILE_BYTES.length;

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/config/constants.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/config/constants.js')>();
	return {
		...actual,
		DOWNLOAD: { ...actual.DOWNLOAD, MIN_IMPORT_SIZE_BYTES: 1 }
	};
});

const clientsRoute = await import('./download-clients/+server');
const savedClientTestRoute = await import('./download-clients/[id]/test/+server');
const acquisitionRoute = await import('./settings/acquisition/+server');
const grabRoute = await import('./download/grab/+server');
const activityRoute = await import('./activity/+server');
const backupRoute = await import('./settings/system/backup/+server');
const { resetDownloadClientManager } =
	await import('#lib/server/downloadClients/DownloadClientManager.js');
const { getDebridPollService, resetDebridPollService } =
	await import('#lib/server/downloadClients/debrid/DebridPollService.js');
const { qualityFilter } = await import('#lib/server/quality/QualityFilter.js');
const { decryptBackupPayload } = await import('#lib/server/crypto/backupCrypto.js');
const { decryptCredential } = await import('#lib/server/crypto/credentialsCrypto.js');

type Provider = 'realdebrid' | 'torbox';

interface Scenario {
	provider: Provider;
	clientName: string;
	token: string;
	providerItemId: string;
	infoHash: string;
	removeAfterImport: boolean;
	mediaType: 'movie' | 'tv';
	releaseTitle: string;
	providerFileName: string;
}

interface ProviderState {
	ready: boolean;
	inspectCount: number;
	submissionCount: number;
	linkCount: number;
	deleteCount: number;
	credentialCount: number;
}

const scenarios: Scenario[] = [
	{
		provider: 'realdebrid',
		clientName: 'Acceptance RD',
		token: 'ACCEPTANCE_REAL_DEBRID_TOKEN_000001',
		providerItemId: 'ACCEPTANCE-RD-PROVIDER-1',
		infoHash: '1111111111111111111111111111111111111111',
		removeAfterImport: false,
		mediaType: 'movie',
		releaseTitle: 'Acceptance.Movie.2026.1080p.WEB-DL-GRP',
		providerFileName: 'Acceptance.Movie.2026.1080p.WEB-DL-GRP.mkv'
	},
	{
		provider: 'torbox',
		clientName: 'Acceptance TorBox',
		token: 'ACCEPTANCE_TORBOX_TOKEN_0000000002',
		providerItemId: '7002',
		infoHash: '2222222222222222222222222222222222222222',
		removeAfterImport: true,
		mediaType: 'tv',
		releaseTitle: 'Acceptance.Series.S01E01.1080p.WEB-DL-GRP',
		providerFileName: 'Acceptance.Series.S01E01.1080p.WEB-DL-GRP.mkv'
	}
];

const tempRoots: string[] = [];

async function createLibraryRoot(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	tempRoots.push(path);
	return path;
}

async function startDirectFileServer(): Promise<{
	url: string;
	requests: () => number;
	close: () => Promise<void>;
}> {
	let requestCount = 0;
	const server = createServer((_request, response: ServerResponse) => {
		requestCount += 1;
		response.writeHead(200, {
			'content-type': 'video/x-matroska',
			'content-length': String(FILE_SIZE)
		});
		response.end(FILE_BYTES);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Direct-file server did not bind');
	return {
		url: `http://127.0.0.1:${address.port}/media`,
		requests: () => requestCount,
		close: () => new Promise<void>((resolve) => server.close(() => resolve()))
	};
}

function resetOperationalState(): void {
	clearTestDb(testDb);
	testDb.sqlite.exec(`
		DELETE FROM download_history;
		DELETE FROM episode_files;
		DELETE FROM movie_files;
		DELETE FROM episodes;
		DELETE FROM seasons;
		DELETE FROM series;
		DELETE FROM movies;
		DELETE FROM root_folders;
		DELETE FROM scoring_profiles;
		DELETE FROM settings;
	`);
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function torBoxEnvelope(data: unknown): unknown {
	return { success: true, error: null, detail: null, data };
}

function createProviderTransport(
	scenario: Scenario,
	state: ProviderState,
	directFileUrl: string
): typeof globalThis.fetch {
	return vi.fn(async (input: RequestInfo | URL) => {
		const rawUrl =
			typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
		const url = new URL(rawUrl);

		if (scenario.provider === 'realdebrid') {
			if (url.pathname.endsWith('/user')) {
				state.credentialCount += 1;
				return jsonResponse({ id: 7001, username: 'acceptance-rd', type: 'premium' });
			}
			if (url.pathname.endsWith('/torrents')) return jsonResponse([]);
			if (url.pathname.endsWith('/torrents/addMagnet')) {
				state.submissionCount += 1;
				return jsonResponse({ id: scenario.providerItemId, uri: 'redacted' }, 201);
			}
			if (url.pathname.includes('/torrents/info/')) {
				state.inspectCount += 1;
				return jsonResponse({
					id: scenario.providerItemId,
					filename: scenario.providerFileName,
					status: state.ready ? 'downloaded' : 'downloading',
					progress: state.ready ? 100 : 50,
					links: state.ready ? ['https://real-debrid.example/signed-intermediate'] : [],
					files: [
						{
							id: 1,
							path: `/${scenario.providerFileName}`,
							bytes: FILE_SIZE,
							selected: 1
						}
					]
				});
			}
			if (url.pathname.endsWith('/unrestrict/link')) {
				state.linkCount += 1;
				return jsonResponse({
					id: 'acceptance-link',
					filename: scenario.providerFileName,
					mimeType: 'video/x-matroska',
					filesize: FILE_SIZE,
					link: 'https://real-debrid.example/signed-intermediate',
					host: 'local',
					download: directFileUrl,
					streamable: 1
				});
			}
			if (url.pathname.includes('/torrents/delete/')) {
				state.deleteCount += 1;
				return new Response(null, { status: 204 });
			}
		} else {
			if (url.pathname.endsWith('/user/me')) {
				state.credentialCount += 1;
				return jsonResponse(torBoxEnvelope({ id: 7002, plan: 2 }));
			}
			if (url.pathname.endsWith('/torrents/mylist') && !url.searchParams.has('id')) {
				return jsonResponse(torBoxEnvelope([]));
			}
			if (url.pathname.endsWith('/torrents/createtorrent')) {
				state.submissionCount += 1;
				return jsonResponse(
					torBoxEnvelope({
						hash: scenario.infoHash,
						torrent_id: Number(scenario.providerItemId),
						auth_id: 'acceptance-auth'
					})
				);
			}
			if (url.pathname.endsWith('/torrents/mylist') && url.searchParams.has('id')) {
				state.inspectCount += 1;
				return jsonResponse(
					torBoxEnvelope({
						id: Number(scenario.providerItemId),
						name: scenario.providerFileName,
						download_state: state.ready ? 'completed' : 'downloading',
						download_finished: state.ready,
						download_present: state.ready,
						progress: state.ready ? 1 : 0.5,
						files: [{ id: 1, name: scenario.providerFileName, size: FILE_SIZE }]
					})
				);
			}
			if (url.pathname.endsWith('/torrents/requestdl')) {
				state.linkCount += 1;
				expect(url.searchParams.get('zip_link')).toBe('false');
				return jsonResponse(torBoxEnvelope(directFileUrl));
			}
			if (url.pathname.endsWith('/torrents/controltorrent')) {
				state.deleteCount += 1;
				return jsonResponse(torBoxEnvelope(null));
			}
		}

		throw new Error(`Unexpected ${scenario.provider} request: ${url.pathname}`);
	}) as unknown as typeof globalThis.fetch;
}

async function seedMedia(scenario: Scenario): Promise<string> {
	const rootPath = await createLibraryRoot(`cinephage-debrid-${scenario.provider}-`);
	testDb.db
		.insert(scoringProfiles)
		.values({
			id: 'acceptance-profile',
			name: 'Debrid operational acceptance',
			isDefault: true,
			minScore: 0,
			formatScores: {},
			allowedProtocols: ['torrent', 'usenet']
		})
		.run();
	testDb.db
		.insert(rootFolders)
		.values({
			id: 'acceptance-root',
			name: 'Debrid acceptance library',
			path: rootPath,
			mediaType: scenario.mediaType === 'movie' ? 'movie' : 'tv',
			isDefault: true
		})
		.run();

	if (scenario.mediaType === 'movie') {
		testDb.db
			.insert(movies)
			.values({
				id: 'acceptance-movie',
				tmdbId: 97001,
				title: 'Acceptance Movie',
				year: 2026,
				path: 'Acceptance Movie (2026)',
				rootFolderId: 'acceptance-root',
				scoringProfileId: 'acceptance-profile',
				hasFile: false,
				wantsSubtitles: false
			})
			.run();
	} else {
		testDb.db
			.insert(series)
			.values({
				id: 'acceptance-series',
				tmdbId: 97002,
				tvdbId: 97003,
				title: 'Acceptance Series',
				year: 2026,
				path: 'Acceptance Series',
				rootFolderId: 'acceptance-root',
				scoringProfileId: 'acceptance-profile',
				seasonFolder: true,
				seriesType: 'standard',
				wantsSubtitles: false
			})
			.run();
		testDb.db
			.insert(seasons)
			.values({ id: 'acceptance-season', seriesId: 'acceptance-series', seasonNumber: 1 })
			.run();
		testDb.db
			.insert(episodes)
			.values({
				id: 'acceptance-episode',
				seriesId: 'acceptance-series',
				seasonId: 'acceptance-season',
				seasonNumber: 1,
				episodeNumber: 1,
				title: 'Pilot',
				hasFile: false
			})
			.run();
	}
	return rootPath;
}

function grabPayload(scenario: Scenario): Record<string, unknown> {
	return {
		title: scenario.releaseTitle,
		magnetUrl: `magnet:?xt=urn:btih:${scenario.infoHash}&dn=${encodeURIComponent(scenario.releaseTitle)}`,
		infoHash: scenario.infoHash,
		protocol: 'torrent',
		mediaType: scenario.mediaType,
		movieId: scenario.mediaType === 'movie' ? 'acceptance-movie' : undefined,
		seriesId: scenario.mediaType === 'tv' ? 'acceptance-series' : undefined,
		episodeIds: scenario.mediaType === 'tv' ? ['acceptance-episode'] : undefined,
		seasonNumber: scenario.mediaType === 'tv' ? 1 : undefined,
		size: FILE_SIZE,
		isAutomatic: scenario.provider === 'torbox',
		acquisitionProtocol: scenario.provider === 'realdebrid' ? 'debrid' : undefined
	};
}

function assertNoSecret(value: unknown, scenario: Scenario): void {
	const serialized = JSON.stringify(value);
	expect(serialized).not.toContain(scenario.token);
	expect(serialized).not.toContain('signed-intermediate');
	expect(serialized).not.toContain('token=');
}

async function publicActivities(scope: 'active' | 'history'): Promise<{
	activities: Array<Record<string, unknown>>;
}> {
	const response = await api.get<{ activities: Array<Record<string, unknown>> }>(
		activityRoute.GET,
		{
			url: `http://localhost/api/activity?scope=${scope}&protocol=debrid`,
			auth: 'admin'
		}
	);
	expect(response.status).toBe(200);
	return response.data;
}

describe('public debrid workflow operational acceptance', () => {
	afterAll(async () => {
		destroyTestDb(testDb);
		await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
	});

	beforeEach(() => {
		process.env.BETTER_AUTH_SECRET = SOURCE_AUTH_SECRET;
		resetOperationalState();
		resetDownloadClientManager();
		resetDebridPollService();
		qualityFilter.clearCache();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		resetDownloadClientManager();
		resetDebridPollService();
		qualityFilter.clearCache();
		process.env.BETTER_AUTH_SECRET = SOURCE_AUTH_SECRET;
	});

	it.each(scenarios)(
		'completes configure -> grab -> $provider import -> restart -> portable restore',
		async (scenario) => {
			const rootPath = await seedMedia(scenario);
			const directFileServer = await startDirectFileServer();
			const state: ProviderState = {
				ready: false,
				inspectCount: 0,
				submissionCount: 0,
				linkCount: 0,
				deleteCount: 0,
				credentialCount: 0
			};
			vi.stubGlobal('fetch', createProviderTransport(scenario, state, directFileServer.url));

			try {
				const created = await api.post<{
					success: boolean;
					client: { id: string; hasApiToken: boolean; implementation: string };
				}>(clientsRoute.POST, {
					name: scenario.clientName,
					implementation: scenario.provider,
					enabled: true,
					priority: 1,
					apiToken: scenario.token,
					removeAfterImport: scenario.removeAfterImport
				});
				expect(created.status).toBe(200);
				expect(created.data.client).toMatchObject({
					hasApiToken: true,
					implementation: scenario.provider
				});
				assertNoSecret(created.data, scenario);

				const rawClient = testDb.sqlite
					.prepare(
						'SELECT api_token AS apiToken, remove_after_import AS removeAfterImport FROM download_clients WHERE id = ?'
					)
					.get(created.data.client.id) as { apiToken: string; removeAfterImport: number };
				expect(rawClient.apiToken).not.toBe(scenario.token);
				// Versioned envelope bound to the client id (post-161 format).
				expect(decryptCredential('debrid-token', created.data.client.id, rawClient.apiToken)).toBe(
					scenario.token
				);
				expect(rawClient.removeAfterImport).toBe(scenario.removeAfterImport ? 1 : 0);

				resetDownloadClientManager();
				const tested = await api.post<{ success: boolean }>(
					savedClientTestRoute.POST,
					{},
					{ params: { id: created.data.client.id } }
				);
				expect(tested).toMatchObject({ status: 200, data: { success: true } });
				expect(state.credentialCount).toBe(1);
				assertNoSecret(tested.data, scenario);

				await api.put(acquisitionRoute.PUT, { defaultAcquisitionProtocol: 'debrid' });
				const payload = grabPayload(scenario);
				const firstGrab = await api.post<Record<string, unknown>>(grabRoute.POST, payload, {
					auth: 'admin'
				});
				const secondGrab = await api.post<Record<string, unknown>>(grabRoute.POST, payload, {
					auth: 'admin'
				});
				expect(firstGrab.status).toBe(200);
				expect([200, 422]).toContain(secondGrab.status);
				expect(state.submissionCount).toBe(1);
				assertNoSecret(firstGrab.data, scenario);
				assertNoSecret(secondGrab.data, scenario);

				const queueBeforePoll = testDb.db.select().from(downloadQueue).all();
				expect(queueBeforePoll).toHaveLength(1);
				expect(queueBeforePoll[0]).toMatchObject({
					downloadClientId: created.data.client.id,
					downloadId: scenario.providerItemId,
					infoHash: scenario.infoHash,
					protocol: 'debrid',
					status: 'queued'
				});
				expect(payload.protocol).toBe('torrent');

				const poller = getDebridPollService();
				await poller.tickOnce();
				expect(testDb.db.select().from(downloadQueue).get()?.status).toBe('downloading');
				const active = await publicActivities('active');
				expect(active.activities).toEqual([
					expect.objectContaining({
						protocol: 'debrid',
						status: 'downloading',
						queueStatus: 'downloading'
					})
				]);

				state.ready = true;
				await poller.tickOnce();
				const importedQueue = testDb.db.select().from(downloadQueue).get();
				expect(importedQueue, importedQueue?.errorMessage ?? 'no queue diagnostic').toMatchObject({
					status: 'imported',
					protocol: 'debrid',
					infoHash: scenario.infoHash
				});
				expect(importedQueue?.importedPath?.startsWith(rootPath)).toBe(true);
				expect(importedQueue?.importedPath && existsSync(importedQueue.importedPath)).toBe(true);
				expect(testDb.db.select().from(downloadHistory).all()).toHaveLength(1);
				expect(
					scenario.mediaType === 'movie'
						? testDb.db.select().from(movieFiles).all()
						: testDb.db.select().from(episodeFiles).all()
				).toHaveLength(1);
				expect(state.linkCount).toBe(1);
				expect(directFileServer.requests()).toBe(1);
				expect(state.deleteCount).toBe(scenario.removeAfterImport ? 1 : 0);

				const history = await publicActivities('history');
				expect(history.activities).toEqual([
					expect.objectContaining({ protocol: 'debrid', status: 'imported' })
				]);
				assertNoSecret(history, scenario);

				await poller.tickOnce();
				resetDebridPollService();
				await getDebridPollService().tickOnce();
				expect(state.submissionCount).toBe(1);
				expect(state.linkCount).toBe(1);
				expect(directFileServer.requests()).toBe(1);
				expect(testDb.db.select().from(downloadQueue).all()).toHaveLength(1);
				expect(testDb.db.select().from(downloadHistory).all()).toHaveLength(1);

				const exported = await api.post<{ backup: Record<string, unknown> }>(backupRoute.POST, {
					passphrase: BACKUP_PASSPHRASE
				});
				expect(exported.status).toBe(200);
				const backup = exported.data.backup as {
					data: Record<string, unknown>;
					secrets: Parameters<typeof decryptBackupPayload>[0];
				};
				expect(JSON.stringify(backup.data)).not.toContain(scenario.token);
				const decryptedSecrets = decryptBackupPayload(backup.secrets, BACKUP_PASSPHRASE);
				expect(JSON.stringify(decryptedSecrets)).toContain(scenario.token);

				const destinationSecret = `${SOURCE_AUTH_SECRET}-${scenario.provider}-destination`;
				process.env.BETTER_AUTH_SECRET = destinationSecret;
				testDb.db
					.update(downloadClients)
					.set({ apiToken: null })
					.where(eq(downloadClients.id, created.data.client.id))
					.run();
				const restored = await api.put(backupRoute.PUT, {
					passphrase: BACKUP_PASSPHRASE,
					sections: ['downloads'],
					mode: 'apply',
					backup: exported.data.backup
				});
				expect(restored.status).toBe(200);
				const restoredCiphertext = testDb.db
					.select({ apiToken: downloadClients.apiToken })
					.from(downloadClients)
					.where(eq(downloadClients.id, created.data.client.id))
					.get()?.apiToken;
				expect(restoredCiphertext).toBeTruthy();
				expect(restoredCiphertext).not.toBe(rawClient.apiToken);
				expect(
					decryptCredential('debrid-token', created.data.client.id, restoredCiphertext as string)
				).toBe(scenario.token);

				assertNoSecret(testDb.db.select().from(downloadQueue).all(), scenario);
				assertNoSecret(testDb.db.select().from(downloadHistory).all(), scenario);
				assertNoSecret(testDb.db.select().from(movieFiles).all(), scenario);
				assertNoSecret(testDb.db.select().from(episodeFiles).all(), scenario);
			} finally {
				await directFileServer.close();
			}
		},
		30_000
	);

	it('keeps a failed debrid mapping visible in durable history', async () => {
		const scenario: Scenario = {
			...scenarios[1],
			providerFileName: 'Acceptance.Series.S01E02.1080p.WEB-DL-GRP.mkv'
		};
		await seedMedia(scenario);
		const state: ProviderState = {
			ready: true,
			inspectCount: 0,
			submissionCount: 0,
			linkCount: 0,
			deleteCount: 0,
			credentialCount: 0
		};
		vi.stubGlobal(
			'fetch',
			createProviderTransport(scenario, state, 'https://unused.invalid/media')
		);

		const created = await api.post<{ client: { id: string } }>(clientsRoute.POST, {
			name: scenario.clientName,
			implementation: scenario.provider,
			enabled: true,
			priority: 1,
			apiToken: scenario.token
		});
		await api.put(acquisitionRoute.PUT, { defaultAcquisitionProtocol: 'debrid' });
		const grabbed = await api.post(grabRoute.POST, grabPayload(scenario), { auth: 'admin' });
		expect(created.status).toBe(200);
		expect(grabbed.status).toBe(200);

		await getDebridPollService().tickOnce();

		const failedQueueItem = testDb.db.select().from(downloadQueue).get();
		expect(failedQueueItem).toMatchObject({
			status: 'failed',
			protocol: 'debrid',
			downloadClientId: created.data.client.id
		});
		expect(testDb.db.select().from(downloadHistory).all()).toEqual([
			expect.objectContaining({
				status: 'failed',
				protocol: 'debrid',
				statusReason: failedQueueItem?.errorMessage
			})
		]);

		const history = await publicActivities('history');
		expect(history.activities).toEqual([
			expect.objectContaining({
				status: 'failed',
				protocol: 'debrid',
				queueItemId: failedQueueItem?.id
			})
		]);

		testDb.db.delete(downloadHistory).run();
		resetDebridPollService();
		await getDebridPollService().tickOnce();
		expect(testDb.db.select().from(downloadHistory).all()).toHaveLength(1);
	});
});
