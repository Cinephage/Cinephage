/**
 * GET /api/streaming/usenet/[mountId]/[fileIndex]
 *
 * Stream NZB content with HTTP Range support for seeking.
 * Used by media players (Jellyfin, etc.) via .strm files.
 */

import { Readable } from 'node:stream';
import type { RequestHandler } from './$types';
import { logger } from '#lib/logging/index.js';
import { getUsenetStreamService } from '#lib/server/streaming/usenet/UsenetStreamService.js';

const streamLog = { logDomain: 'streams' as const, component: 'UsenetStreamApi' };

export const GET: RequestHandler = async ({ params, request }) => {
	const { mountId, fileIndex } = params;
	const fileIndexNum = parseInt(fileIndex, 10);

	if (isNaN(fileIndexNum) || fileIndexNum < 0) {
		return new Response('Invalid file index', { status: 400 });
	}

	const streamService = getUsenetStreamService();

	// Check if service is ready
	if (!streamService.isReady()) {
		logger.warn(
			{ mountId, fileIndex: fileIndexNum, ...streamLog },
			'Usenet streaming service is not ready'
		);
		return new Response('Usenet streaming service not available', { status: 503 });
	}

	const rangeHeader = request.headers.get('range');

	try {
		const result = await streamService.createStream(mountId, fileIndexNum, rangeHeader);

		// Convert Node.js Readable to web ReadableStream
		const webStream = Readable.toWeb(result.stream) as ReadableStream;

		// Build response headers
		const headers: Record<string, string> = {
			'Content-Type': result.contentType,
			'Accept-Ranges': 'bytes',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		};

		if (result.isPartial) {
			// 206 Partial Content
			headers['Content-Range'] = `bytes ${result.startByte}-${result.endByte}/${result.totalSize}`;
			headers['Content-Length'] = String(result.contentLength);

			logger.debug(
				{
					mountId,
					fileIndex: fileIndexNum,
					rangeRequest: rangeHeader,
					contentRange: `${result.startByte}-${result.endByte}/${result.totalSize}`,
					contentType: result.contentType,
					...streamLog
				},
				'Serving partial usenet stream response'
			);

			return new Response(webStream, {
				status: 206,
				headers
			});
		}

		// 200 OK for full content
		headers['Content-Length'] = String(result.totalSize);

		logger.debug(
			{
				mountId,
				fileIndex: fileIndexNum,
				rangeRequest: rangeHeader,
				totalSize: result.totalSize,
				contentType: result.contentType,
				...streamLog
			},
			'Serving full usenet stream response'
		);

		return new Response(webStream, {
			status: 200,
			headers
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';

		if (message.includes('not found') || message.includes('not available')) {
			logger.warn(
				{
					mountId,
					fileIndex: fileIndexNum,
					rangeRequest: rangeHeader,
					error: message,
					...streamLog
				},
				'Usenet stream request failed because the mount or file was not found'
			);
			return new Response(message, { status: 404 });
		}

		if (message.includes('not ready')) {
			logger.warn(
				{
					mountId,
					fileIndex: fileIndexNum,
					rangeRequest: rangeHeader,
					error: message,
					...streamLog
				},
				'Usenet stream request failed because the mount is not ready'
			);
			return new Response(message, { status: 503 });
		}

		logger.error(
			{
				mountId,
				fileIndex: fileIndexNum,
				rangeRequest: rangeHeader,
				err: error,
				error: message,
				...streamLog
			},
			'Usenet stream request failed'
		);

		return new Response('Stream error', { status: 500 });
	}
};

export const HEAD: RequestHandler = async ({ params }) => {
	const { mountId, fileIndex } = params;
	const fileIndexNum = parseInt(fileIndex, 10);

	if (isNaN(fileIndexNum) || fileIndexNum < 0) {
		return new Response(null, { status: 400 });
	}

	const streamService = getUsenetStreamService();

	if (!streamService.isReady()) {
		return new Response(null, { status: 503 });
	}

	try {
		// Create stream with no range to get full size info
		const result = await streamService.createStream(mountId, fileIndexNum, null);

		// Destroy the stream immediately since this is just a HEAD request
		result.stream.destroy();

		return new Response(null, {
			status: 200,
			headers: {
				'Content-Type': result.contentType,
				'Content-Length': String(result.totalSize),
				'Accept-Ranges': 'bytes'
			}
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';

		if (message.includes('not found')) {
			return new Response(null, { status: 404 });
		}

		return new Response(null, { status: 500 });
	}
};
