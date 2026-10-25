import type { RequestHandler } from './$types';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createChildLogger } from '#lib/logging/index.js';

import { LOGOS_DIR } from '#lib/server/logos/constants.js';

const logger = createChildLogger({ module: 'LogosFileApi', logDomain: 'system' });

/**
 * GET /api/logos/file/[country]/[filename]
 * Serve a logo file
 */
export const GET: RequestHandler = async ({
	params
}: {
	params: { country: string; filename: string };
}) => {
	try {
		const { country, filename } = params;

		// Validate path to prevent directory traversal
		if (!country || !filename || country.includes('..') || filename.includes('..')) {
			return new Response('Invalid path', { status: 400 });
		}

		const filePath = join(LOGOS_DIR, country, filename);

		// Read and serve the file
		const buffer = await readFile(filePath);

		// Determine content type
		const ext = filename.toLowerCase().split('.').pop();
		const contentType =
			ext === 'png'
				? 'image/png'
				: ext === 'jpg' || ext === 'jpeg'
					? 'image/jpeg'
					: 'application/octet-stream';

		return new Response(buffer, {
			headers: {
				'Content-Type': contentType,
				'Cache-Control': 'public, max-age=86400' // Cache for 1 day
			}
		});
	} catch (error) {
		logger.error('[LogoFileAPI] Failed to serve logo', error);
		return new Response('Logo not found', { status: 404 });
	}
};
