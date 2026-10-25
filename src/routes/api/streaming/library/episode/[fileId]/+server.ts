/**
 * GET/HEAD /api/streaming/library/episode/[fileId]
 *
 * Stream a local episode file directly from disk with HTTP Range support.
 * Resolves the file by database ID, never by raw path and validates the
 * resolved absolute path is within a configured root folder before opening it.
 *
 * Auth: API key (x-api-key header or ?api_key= query param).
 */

import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { episodeFiles, series, rootFolders } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { isPathInsideManagedRoot } from '#lib/server/filesystem/path-guard.js';
import { getContentType, parseRangeHeader } from '#lib/server/streaming/usenet/types.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({
	logDomain: 'streams' as const,
	component: 'LocalEpisodeStream'
});

async function resolveEpisodeFile(
	fileId: string
): Promise<{ absolutePath: string; size: number; contentType: string } | null> {
	const row = await db
		.select({
			relativePath: episodeFiles.relativePath,
			size: episodeFiles.size,
			seriesPath: series.path,
			rootFolderPath: rootFolders.path
		})
		.from(episodeFiles)
		.innerJoin(series, eq(episodeFiles.seriesId, series.id))
		.innerJoin(rootFolders, eq(series.rootFolderId, rootFolders.id))
		.where(eq(episodeFiles.id, fileId))
		.get();

	if (!row) return null;

	const absolutePath = join(row.rootFolderPath, row.seriesPath, row.relativePath);

	if (!(await isPathInsideManagedRoot(absolutePath))) {
		logger.warn(
			{ fileId, absolutePath },
			'[LocalEpisodeStream] Path outside managed root — rejecting'
		);
		return null;
	}

	// Always stat: verify the file exists, is a regular file, and get its current size.
	// The DB size field can be stale if the file was replaced or deleted after import.
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(absolutePath);
	} catch {
		logger.warn({ fileId, absolutePath }, '[LocalEpisodeStream] File not found on disk');
		return null;
	}
	if (!stats.isFile()) {
		logger.warn({ fileId, absolutePath }, '[LocalEpisodeStream] Path is not a regular file');
		return null;
	}

	return { absolutePath, size: stats.size, contentType: getContentType(row.relativePath) };
}

export const GET: RequestHandler = async (event) => {
	// Accept either a streaming API key (validated by hooks) or an admin session
	if (!event.locals.apiKey && event.locals.user?.role !== 'admin') {
		return new Response('Unauthorized', { status: 401 });
	}

	const { params, request } = event;
	const { fileId } = params;

	const file = await resolveEpisodeFile(fileId);
	if (!file) {
		return new Response('Not found', { status: 404 });
	}

	const rangeHeader = request.headers.get('range');
	const range = parseRangeHeader(rangeHeader, file.size);

	const headers: Record<string, string> = {
		'Content-Type': file.contentType,
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive'
	};

	if (rangeHeader && !range) {
		// Malformed / unsatisfiable range
		headers['Content-Range'] = `bytes */${file.size}`;
		return new Response('Range Not Satisfiable', { status: 416, headers });
	}

	if (range) {
		const startByte = range.start;
		const endByte = range.end === -1 ? file.size - 1 : range.end;
		const contentLength = endByte - startByte + 1;

		headers['Content-Range'] = `bytes ${startByte}-${endByte}/${file.size}`;
		headers['Content-Length'] = String(contentLength);

		logger.debug(
			{ fileId, startByte, endByte, totalSize: file.size },
			'[LocalEpisodeStream] Serving partial content'
		);

		const nodeStream = createReadStream(file.absolutePath, { start: startByte, end: endByte });
		return new Response(Readable.toWeb(nodeStream) as ReadableStream, { status: 206, headers });
	}

	headers['Content-Length'] = String(file.size);

	logger.debug({ fileId, totalSize: file.size }, '[LocalEpisodeStream] Serving full content');

	const nodeStream = createReadStream(file.absolutePath);
	return new Response(Readable.toWeb(nodeStream) as ReadableStream, { status: 200, headers });
};

export const HEAD: RequestHandler = async (event) => {
	if (!event.locals.apiKey && event.locals.user?.role !== 'admin') {
		return new Response(null, { status: 401 });
	}

	const { params } = event;
	const { fileId } = params;

	const file = await resolveEpisodeFile(fileId);
	if (!file) {
		return new Response(null, { status: 404 });
	}

	return new Response(null, {
		status: 200,
		headers: {
			'Content-Type': file.contentType,
			'Content-Length': String(file.size),
			'Accept-Ranges': 'bytes'
		}
	});
};
