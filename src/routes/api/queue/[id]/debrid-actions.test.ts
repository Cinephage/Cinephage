import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	selectResults: [] as unknown[],
	updates: [] as Array<Record<string, unknown>>,
	pauseDownload: vi.fn(),
	resumeDownload: vi.fn(),
	getClientInstance: vi.fn(),
	debridRetry: vi.fn(),
	genericAddDownload: vi.fn(),
	getContentPath: vi.fn(),
	buildTorrentRecoveryPath: vi.fn()
}));

vi.mock('#lib/server/db/index.js', () => ({
	db: {
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => ({
					get: vi.fn(async () => mocks.selectResults.shift())
				}))
			}))
		})),
		update: vi.fn(() => ({
			set: vi.fn((values: Record<string, unknown>) => {
				mocks.updates.push(values);
				return { where: vi.fn(async () => ({ changes: 1 })) };
			})
		}))
	}
}));

vi.mock('#lib/server/downloadClients/monitoring/index.js', () => ({
	downloadMonitor: {
		pauseDownload: mocks.pauseDownload,
		resumeDownload: mocks.resumeDownload
	},
	getContentPath: mocks.getContentPath,
	buildTorrentRecoveryPath: mocks.buildTorrentRecoveryPath
}));

vi.mock('#lib/server/downloadClients/DownloadClientManager.js', () => ({
	getDownloadClientManager: () => ({
		getClientInstance: mocks.getClientInstance,
		getClient: vi.fn()
	})
}));

vi.mock('#lib/server/downloads/handlers/DebridHandler.js', () => ({
	DebridHandler: class {
		retry = mocks.debridRetry;
	}
}));

vi.mock('#lib/server/downloadClients/import/index.js', () => ({
	getImportService: vi.fn()
}));

vi.mock('#lib/logging/index.js', () => ({
	createChildLogger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn()
	}),
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn()
	}
}));

function debridQueueItem(overrides: Record<string, unknown> = {}) {
	return {
		id: 'queue-debrid-1',
		downloadClientId: 'client-rd-1',
		downloadId: 'provider-old-1',
		infoHash: '0123456789abcdef0123456789abcdef01234567',
		title: 'Movie.2026.1080p',
		protocol: 'debrid',
		status: 'failed',
		progress: '0.25',
		magnetUrl: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Movie.2026.1080p',
		downloadUrl: null,
		movieId: 'movie-1',
		seriesId: null,
		episodeIds: null,
		seasonNumber: null,
		outputPath: null,
		clientDownloadPath: null,
		completedAt: null,
		errorMessage: 'Provider rejected the previous submission.',
		importAttempts: 0,
		...overrides
	};
}

async function captureRouteError(run: () => unknown | Promise<unknown>): Promise<unknown> {
	try {
		await run();
		return undefined;
	} catch (error) {
		return error;
	}
}

describe('debrid queue actions', () => {
	beforeEach(() => {
		mocks.selectResults.length = 0;
		mocks.updates.length = 0;
		mocks.pauseDownload.mockReset().mockResolvedValue(undefined);
		mocks.resumeDownload.mockReset().mockResolvedValue(undefined);
		mocks.genericAddDownload.mockReset().mockResolvedValue('generic-provider-id');
		mocks.getContentPath.mockReset();
		mocks.buildTorrentRecoveryPath.mockReset();
		mocks.getClientInstance.mockReset().mockResolvedValue({
			addDownload: mocks.genericAddDownload
		});
		mocks.debridRetry.mockReset().mockResolvedValue({
			success: true,
			queueId: 'queue-debrid-1',
			hash: '0123456789abcdef0123456789abcdef01234567',
			clientId: 'client-rd-1',
			clientName: 'Real-Debrid',
			wasDuplicate: false
		});
	});

	it.each([
		['pause', 'Pause', mocks.pauseDownload],
		['resume', 'Resume', mocks.resumeDownload]
	] as const)(
		'rejects %s as an HTTP 400 unsupported action before generic monitor dispatch',
		async (action, actionLabel, monitorMethod) => {
			mocks.selectResults.push(debridQueueItem({ status: 'downloading' }));
			const { PATCH } = await import('./+server');

			const routeError = await captureRouteError(() =>
				PATCH({
					params: { id: 'queue-debrid-1' },
					request: new Request('http://localhost/api/queue/queue-debrid-1', {
						method: 'PATCH',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ action })
					}),
					locals: { user: { id: 'admin-1', role: 'admin' } }
				} as never)
			);

			expect(routeError).toMatchObject({
				status: 400,
				body: { message: `${actionLabel} is not supported for debrid downloads` }
			});
			expect(monitorMethod).not.toHaveBeenCalled();
			expect(mocks.getClientInstance).not.toHaveBeenCalled();
		}
	);

	it('retries through the shared DebridHandler boundary, updates only the provider ID, and preserves source infoHash', async () => {
		const original = debridQueueItem();
		mocks.selectResults.push(original, {
			...original,
			downloadId: 'provider-new-2',
			status: 'queued',
			errorMessage: null
		});
		const { POST } = await import('./retry/+server');

		const response = await POST({
			params: { id: original.id },
			locals: { user: { id: 'admin-1', role: 'admin' } }
		} as never);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.debridRetry).toHaveBeenCalledWith(original);
		expect(mocks.getClientInstance).not.toHaveBeenCalled();
		expect(mocks.genericAddDownload).not.toHaveBeenCalled();
		expect(mocks.getContentPath).not.toHaveBeenCalled();
		expect(mocks.buildTorrentRecoveryPath).not.toHaveBeenCalled();
		expect(body).toMatchObject({
			success: true,
			retryMode: 'debrid',
			queueItem: {
				status: 'queued',
				downloadId: 'provider-new-2',
				infoHash: original.infoHash
			}
		});
	});

	it('returns a clear 400 for a missing stored token before generic client lookup', async () => {
		const original = debridQueueItem();
		mocks.selectResults.push(original);
		mocks.debridRetry.mockResolvedValueOnce({
			success: false,
			error: 'Stored API token is unavailable. Re-enter the token and try again.'
		});
		const { POST } = await import('./retry/+server');

		const response = await POST({
			params: { id: original.id },
			locals: { user: { id: 'admin-1', role: 'admin' } }
		} as never);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body).toMatchObject({
			success: false,
			error: expect.stringMatching(/API token is unavailable/i)
		});
		expect(mocks.getClientInstance).not.toHaveBeenCalled();
		expect(mocks.genericAddDownload).not.toHaveBeenCalled();
	});

	it('refuses to blindly retry an ambiguous provider submission', async () => {
		const original = debridQueueItem({
			errorMessage:
				'[ambiguous_submission] Provider submission outcome is unknown; the item may already exist.'
		});
		mocks.selectResults.push(original);
		mocks.debridRetry.mockResolvedValueOnce({
			success: false,
			error: '[ambiguous_submission] Submission outcome is unknown; refusing blind resubmission'
		});
		const { POST } = await import('./retry/+server');

		const response = await POST({
			params: { id: original.id },
			locals: { user: { id: 'admin-1', role: 'admin' } }
		} as never);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({
			success: false,
			error: expect.stringMatching(/outcome is unknown|may already exist|cannot safely retry/i)
		});
		expect(mocks.debridRetry).toHaveBeenCalledWith(original);
		expect(mocks.getClientInstance).not.toHaveBeenCalled();
		expect(mocks.genericAddDownload).not.toHaveBeenCalled();
	});
});
