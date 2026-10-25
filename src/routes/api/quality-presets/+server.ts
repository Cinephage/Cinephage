import type { RequestHandler } from './$types';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'QualityPresetsApi', logDomain: 'system' });

/**
 * @deprecated These endpoints are REMOVED. Use /api/scoring-profiles instead.
 *
 * The quality presets system has been fully replaced by the scoring profiles system.
 * All requests to this endpoint now return a 410 Gone status with migration instructions.
 */

const DEPRECATION_MESSAGE =
	'Quality presets API has been removed. Use /api/scoring-profiles instead.';

function logDeprecation(method: string) {
	logger.warn(
		{
			method,
			message: DEPRECATION_MESSAGE
		},
		'[REMOVED] Quality presets API accessed'
	);
}

/**
 * All methods return 410 Gone with migration instructions
 */
export const GET: RequestHandler = async () => {
	logDeprecation('GET');
	return Response.json(
		{
			success: false,
			error: DEPRECATION_MESSAGE,
			code: 'ENDPOINT_REMOVED',
			migration: {
				newEndpoint: '/api/scoring-profiles',
				documentation:
					'Scoring profiles provide more comprehensive quality control. See /api/scoring-profiles for the new API.'
			}
		},
		{ status: 410 }
	);
};

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	logDeprecation('POST');
	return Response.json(
		{
			success: false,
			error: DEPRECATION_MESSAGE,
			code: 'ENDPOINT_REMOVED',
			migration: {
				newEndpoint: '/api/scoring-profiles',
				documentation: 'Use POST /api/scoring-profiles to create new profiles.'
			}
		},
		{ status: 410 }
	);
};

export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	logDeprecation('PUT');
	return Response.json(
		{
			success: false,
			error: DEPRECATION_MESSAGE,
			code: 'ENDPOINT_REMOVED',
			migration: {
				newEndpoint: '/api/scoring-profiles/[id]',
				documentation: 'Use PUT /api/scoring-profiles/[id] to update profiles.'
			}
		},
		{ status: 410 }
	);
};

export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	logDeprecation('DELETE');
	return Response.json(
		{
			success: false,
			error: DEPRECATION_MESSAGE,
			code: 'ENDPOINT_REMOVED',
			migration: {
				newEndpoint: '/api/scoring-profiles/[id]',
				documentation: 'Use DELETE /api/scoring-profiles/[id] to remove profiles.'
			}
		},
		{ status: 410 }
	);
};
