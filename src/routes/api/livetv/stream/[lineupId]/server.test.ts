import { describe, expect, it, vi } from 'vitest';

const handleStreamHeadMock = vi.hoisted(() =>
	vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
);

vi.mock('#lib/server/livetv/streaming/StreamRequestHandler.js', () => ({
	handleStreamHead: handleStreamHeadMock
}));

const { HEAD } = await import('./+server');

describe('Live TV HEAD route', () => {
	it('passes the request signal to stream validation', async () => {
		const controller = new AbortController();
		const request = new Request('http://cinephage.test/api/livetv/stream/lineup-1', {
			signal: controller.signal
		});

		await HEAD({
			params: { lineupId: 'lineup-1' },
			url: new URL(request.url),
			request
		} as Parameters<typeof HEAD>[0]);

		expect(handleStreamHeadMock).toHaveBeenCalledWith(
			'lineup-1',
			new URL(request.url),
			request.signal
		);
	});
});
