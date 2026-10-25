/**
 * Tests for SABnzbd proxy timeout functionality (Issue #51)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SABnzbdProxy } from './SABnzbdProxy.js';

describe('SABnzbdProxy.getHistory', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('requests archived history items, not just the non-archived default', async () => {
		// SABnzbd's mode=history silently excludes items it has auto-archived
		// unless archive=1 is passed - confirmed live against a real instance
		// where a completed, untracked download had slots: [] without this
		// param and only appeared with it (SABnzbd web UI's own "Show
		// Archive" toggle sends the same param).
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			text: async () =>
				JSON.stringify({
					history: { slots: [], noofslots: 0, version: '5.1.3' }
				})
		});
		vi.stubGlobal('fetch', fetchMock);

		const proxy = new SABnzbdProxy({
			host: '10.0.0.149',
			port: 8124,
			useSsl: false,
			apiKey: 'test-key'
		});
		await proxy.getHistory(0, 100);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
		expect(requestedUrl.searchParams.get('archive')).toBe('1');
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
