import type { RequestHandler } from './$types';
import {
	buildTokensResponse,
	TOKEN_CATEGORIES
} from '#lib/server/library/naming/token-reference.js';

/**
 * GET /api/naming/tokens
 * Returns all available naming tokens organized by category
 */
export const GET: RequestHandler = async () => {
	return Response.json({
		tokens: buildTokensResponse(),
		categories: TOKEN_CATEGORIES
	});
};
