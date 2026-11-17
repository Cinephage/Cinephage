/**
 * Webhook transport contract: the payload a receiver keys on, the event
 * header, and how a non-2xx answer is reported.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { webhookAgent } from './webhook.js';
import type { RenderedNotification } from '../core/agent.js';

const message: RenderedNotification = {
	event: 'import',
	title: 'Imported: Arrival (2016)',
	body: 'Movie imported into the library',
	color: 0x57f287,
	url: null,
	fields: [{ name: 'Quality', value: '1080p WEB-DL' }],
	timestamp: '2026-01-01T00:00:00.000Z'
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('webhook agent', () => {
	it('posts the documented payload with an event header', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const result = await webhookAgent.send(
			{ url: 'https://example.com/hook', method: 'PUT', authorization: 'Bearer abc' },
			message,
			{
				event: 'import',
				media: { type: 'movie', title: 'Arrival', year: 2016, tmdbId: 329865 },
				quality: '1080p WEB-DL'
			}
		);

		expect(result).toEqual({ ok: true, status: 200 });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://example.com/hook');
		expect(init.method).toBe('PUT');
		expect(init.headers['x-cinephage-event']).toBe('import');
		expect(init.headers.authorization).toBe('Bearer abc');

		const body = JSON.parse(init.body);
		expect(body).toMatchObject({
			event: 'import',
			title: 'Imported: Arrival (2016)',
			message: 'Movie imported into the library',
			media: { type: 'movie', title: 'Arrival', tmdbId: 329865 },
			instance: 'Cinephage'
		});
	});

	it('reports a non-2xx answer as a failed delivery with the status', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));

		const result = await webhookAgent.send({ url: 'https://example.com/hook' }, message, {
			event: 'import'
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe(500);
		expect(result.error).toContain('500');
	});

	it('fails fast when the URL is missing', async () => {
		const result = await webhookAgent.send({}, message, { event: 'import' });
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/URL/);
	});

	it('sends the canned test message from test()', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await webhookAgent.test(
			{ url: 'https://example.com/hook' },
			{
				...message,
				event: 'test',
				title: 'Cinephage test notification'
			}
		);

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.event).toBe('test');
	});
});
