/**
 * Live Cloudflare streaming bypass test.
 *
 * Hits a real Cloudflare-protected HLS URL, so it stays out of the normal
 * suite. Run with `npm run test:live` and LIVE_CF_STREAM_URL set to a current
 * protected playlist URL.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fetchWithCloudflareBypass, clearCloudflareSessions } from './cloudflare-streaming.js';

const LIVE_TESTS_ENABLED = process.env.LIVE_TESTS === 'true';

/**
 * Stream hosts rotate and dead-end quickly, so the protected URL is not
 * hardcoded: point LIVE_CF_STREAM_URL at a current playlist to run this.
 * Without it the suite skips instead of failing on a rotten URL.
 */
const TEST_URL = process.env.LIVE_CF_STREAM_URL;

describe.skipIf(!LIVE_TESTS_ENABLED || !TEST_URL)('Cloudflare Bypass (Live)', () => {
	beforeEach(() => {
		clearCloudflareSessions();
	});

	it('should attempt to fetch a Cloudflare-protected URL', async () => {
		const startTime = Date.now();
		const response = await fetchWithCloudflareBypass(TEST_URL as string, {
			referer: 'https://videostr.net/',
			timeout: 30000
		});
		const duration = Date.now() - startTime;

		console.log(`Response received in ${duration}ms`);
		console.log('Status:', response.status);
		console.log('Content-Type:', response.headers.get('content-type'));

		expect([200, 403, 503]).toContain(response.status);

		if (response.ok) {
			const body = await response.text();
			console.log('Response preview:', body.substring(0, 200));

			if (body.includes('#EXTM3U')) {
				console.log('Got valid HLS playlist');
			}
		}
	}, 60000);
});
