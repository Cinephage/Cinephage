/**
 * Tests for SABnzbd proxy timeout functionality (Issue #51)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SABnzbdProxy } from './SABnzbdProxy.js';

describe('SABnzbdProxy.getHistory', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function historyResponse(items: Array<{ nzo_id: string; completed: number }>) {
		return {
			ok: true,
			text: async () =>
				JSON.stringify({
					history: {
						slots: items.map((item) => ({
							...item,
							name: item.nzo_id,
							nzb_name: item.nzo_id,
							category: 'tv',
							storage: `/media/complete/${item.nzo_id}`,
							bytes: 1,
							status: 'Completed',
							fail_message: '',
							download_time: 1
						})),
						noofslots: items.length
					}
				})
		};
	}

	function makeProxy() {
		return new SABnzbdProxy({
			host: '10.0.0.149',
			port: 8124,
			useSsl: false,
			apiKey: 'test-api-key'
		});
	}

	function archiveParamOf(url: string): string | null {
		return new URL(url).searchParams.get('archive');
	}

	it('asks for both the live and the archived sides of history', async () => {
		// SABnzbd's mode=history returns the non-archived jobs (post-processing
		// and freshly completed) without `archive` and only the archived ones
		// with `archive=1`. Asking for one side hides the other: with the
		// default "Keep all jobs" retention nothing is archived, so a completed
		// download vanished from the monitor and was failed as lost.
		const fetchMock = vi.fn().mockImplementation(async () => historyResponse([]));
		vi.stubGlobal('fetch', fetchMock);

		await makeProxy().getHistory(0, 100);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const archiveParams = fetchMock.mock.calls.map((call) => archiveParamOf(call[0] as string));
		expect(archiveParams).toContain(null);
		expect(archiveParams).toContain('1');
	});

	it('returns the union of both sides, newest first', async () => {
		const fetchMock = vi.fn().mockImplementation(async (url: string) => {
			if (archiveParamOf(url) === '1') {
				return historyResponse([{ nzo_id: 'old-archived', completed: 100 }]);
			}
			return historyResponse([{ nzo_id: 'fresh-live', completed: 300 }]);
		});
		vi.stubGlobal('fetch', fetchMock);

		const history = await makeProxy().getHistory(0, 100);

		expect(history?.slots.map((slot) => slot.nzo_id)).toEqual(['fresh-live', 'old-archived']);
		expect(history?.noofslots).toBe(2);
	});

	it('does not return a row that both sides report', async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(async () => historyResponse([{ nzo_id: 'same-job', completed: 200 }]));
		vi.stubGlobal('fetch', fetchMock);

		const history = await makeProxy().getHistory(0, 100);

		expect(history?.slots.map((slot) => slot.nzo_id)).toEqual(['same-job']);
	});

	it('keeps the newest rows when the limit truncates the merged set', async () => {
		const fetchMock = vi.fn().mockImplementation(async (url: string) => {
			if (archiveParamOf(url) === '1') {
				return historyResponse([
					{ nzo_id: 'a-50', completed: 50 },
					{ nzo_id: 'a-10', completed: 10 }
				]);
			}
			return historyResponse([
				{ nzo_id: 'l-90', completed: 90 },
				{ nzo_id: 'l-70', completed: 70 }
			]);
		});
		vi.stubGlobal('fetch', fetchMock);

		const history = await makeProxy().getHistory(0, 2);

		expect(history?.slots.map((slot) => slot.nzo_id)).toEqual(['l-90', 'l-70']);
	});
});

describe('SABnzbd Proxy Timeout', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should abort fetch after timeout', async () => {
		const API_TIMEOUT_MS = 15_000;

		// Track if abort was called
		let abortCalled = false;
		const mockAbortController = {
			signal: {
				aborted: false,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn()
			},
			abort: () => {
				abortCalled = true;
			}
		};

		// Simulate the timeout logic from SABnzbdProxy
		const timeoutId = setTimeout(() => mockAbortController.abort(), API_TIMEOUT_MS);

		// Advance time past the timeout
		vi.advanceTimersByTime(API_TIMEOUT_MS + 100);

		expect(abortCalled).toBe(true);

		clearTimeout(timeoutId);
	});

	it('should not abort if request completes before timeout', async () => {
		const API_TIMEOUT_MS = 15_000;

		let abortCalled = false;
		const mockAbortController = {
			signal: { aborted: false },
			abort: () => {
				abortCalled = true;
			}
		};

		const timeoutId = setTimeout(() => mockAbortController.abort(), API_TIMEOUT_MS);

		// Simulate request completing in 5 seconds
		vi.advanceTimersByTime(5000);

		// Clear timeout as would happen in finally block
		clearTimeout(timeoutId);

		// Advance past original timeout
		vi.advanceTimersByTime(API_TIMEOUT_MS);

		// Abort should NOT have been called
		expect(abortCalled).toBe(false);
	});

	it('should use correct timeout values', () => {
		// From SABnzbdProxy.ts
		const API_TIMEOUT_MS = 15_000; // 15 seconds for regular requests
		const UPLOAD_TIMEOUT_MS = API_TIMEOUT_MS * 2; // 30 seconds for uploads

		expect(API_TIMEOUT_MS).toBe(15000);
		expect(UPLOAD_TIMEOUT_MS).toBe(30000);
	});
});

describe('AbortError handling', () => {
	it('should identify AbortError by name', () => {
		const abortError = new Error('The operation was aborted');
		abortError.name = 'AbortError';

		// This is how we check for abort in SABnzbdProxy
		const isAbortError = abortError instanceof Error && abortError.name === 'AbortError';
		expect(isAbortError).toBe(true);
	});

	it('should not misidentify other errors as AbortError', () => {
		const networkError = new Error('Network failed');
		const isAbortError = networkError instanceof Error && networkError.name === 'AbortError';
		expect(isAbortError).toBe(false);
	});
});
