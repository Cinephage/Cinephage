import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IndexerHttp } from './IndexerHttp';
import { clearSolvedSessions, rememberSolvedUserAgent } from './browser-session.js';
import {
	getRateLimitRegistry,
	getHostRateLimiter,
	resetHostRateLimiter,
	resetRateLimitRegistry
} from '../ratelimit';

const SOLVED_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0';

describe('IndexerHttp', () => {
	beforeEach(() => {
		resetRateLimitRegistry();
		resetHostRateLimiter();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('aborts while waiting for rate limits before issuing the request', async () => {
		const client = new IndexerHttp({
			indexerId: 'test-indexer',
			indexerName: 'Test Indexer',
			baseUrl: 'https://example.com',
			rateLimit: { requests: 1, periodMs: 1000, burst: 0 },
			defaultTimeout: 1000
		});

		const limiter = getRateLimitRegistry().get('test-indexer');
		limiter.recordRequest();

		getHostRateLimiter().setHostConfig('example.com', {
			requests: 100,
			periodMs: 1000,
			burst: 0
		});

		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const controller = new AbortController();

		const requestPromise = client.get('https://example.com/stream', {
			signal: controller.signal
		});
		const rejection = expect(requestPromise).rejects.toThrow('Aborted');

		controller.abort();
		await vi.runAllTimersAsync();

		await rejection;
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('presents the User-Agent a browser solve used for that host', async () => {
		clearSolvedSessions();
		rememberSolvedUserAgent('solved.example', SOLVED_USER_AGENT);

		const client = new IndexerHttp({
			indexerId: 'ua-indexer',
			indexerName: 'UA Indexer',
			baseUrl: 'https://solved.example',
			rateLimit: { requests: 100, periodMs: 1000, burst: 100 },
			defaultTimeout: 1000
		});

		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('ok', { status: 200 }));

		await client.get('https://solved.example/forum/tracker.php');

		const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
		expect(headers['User-Agent']).toBe(SOLVED_USER_AGENT);

		clearSolvedSessions();
		fetchSpy.mockRestore();
	});
});
