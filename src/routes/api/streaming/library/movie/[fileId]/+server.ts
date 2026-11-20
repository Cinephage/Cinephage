/**
 * GET/HEAD /api/streaming/library/movie/[fileId]
 *
 * Stream a local movie file directly from disk with HTTP Range support.
 * Resolves the file by database ID, never by raw path and validates the
 * resolved absolute path is within a configured root folder before opening it.
 *
 * Auth: API key (x-api-key header or ?api_key= query param).
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import { movieFiles, movies, rootFolders } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { isPathInsideManagedRoot } from '#lib/server/filesystem/path-guard.js';
import { getContentType } from '#lib/server/streaming/usenet/types.js';
import { serveLocalFile } from '#lib/server/streaming/local-file.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'streams' as const, component: 'LocalMovieStream' });

async function resolveMovieFile(
	fileId: string
): Promise<{ absolutePath: string; size: number; contentType: string } | null> {
	const row = await db
		.select({
			relativePath: movieFiles.relativePath,
			size: movieFiles.size,
			moviePath: movies.path,
			rootFolderPath: rootFolders.path
		})
		.from(movieFiles)
		.innerJoin(movies, eq(movieFiles.movieId, movies.id))
		.innerJoin(rootFolders, eq(movies.rootFolderId, rootFolders.id))
		.where(eq(movieFiles.id, fileId))
		.get();

	if (!row) return null;

	const absolutePath = join(row.rootFolderPath, row.moviePath, row.relativePath);

	if (!(await isPathInsideManagedRoot(absolutePath))) {
		logger.warn(
			{ fileId, absolutePath },
			'[LocalMovieStream] Path outside managed root - rejecting'
		);
		return null;
	}

	// Always stat: verify the file exists, is a regular file, and get its current size.
	// The DB size field can be stale if the file was replaced or deleted after import.
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(absolutePath);
	} catch {
		logger.warn({ fileId, absolutePath }, '[LocalMovieStream] File not found on disk');
		return null;
	}
	if (!stats.isFile()) {
		logger.warn({ fileId, absolutePath }, '[LocalMovieStream] Path is not a regular file');
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

	const file = await resolveMovieFile(fileId);
	if (!file) {
		return new Response('Not found', { status: 404 });
	}

	return serveLocalFile(request, file);
};

export const HEAD: RequestHandler = async (event) => {
	if (!event.locals.apiKey && event.locals.user?.role !== 'admin') {
		return new Response(null, { status: 401 });
	}

	const { params } = event;
	const { fileId } = params;

	const file = await resolveMovieFile(fileId);
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
