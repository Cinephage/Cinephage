import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getCinephageCore } from '#lib/server/cinephage/core/CinephageCore.js';

/**
 * POST /api/cinephage/test
 * Connectivity test against the api.cinephage.net /api/v1/health endpoint.
 * Admin-gated. Used by the settings panel's "Test connection" button.
 *
 * Returns { success: boolean, error?: string }.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const core = getCinephageCore();
	const identity = await core.getIdentity();
	if (!identity.isConfigured) {
		return Response.json({
			success: false,
			error:
				'Cinephage subsystem identity is not configured. Set APP_VERSION/APP_COMMIT env vars or configure overrides in Cinephage settings.'
		});
	}

	try {
		const baseUrl = await core.getBaseUrl();
		const response = await core.getHttpClient().get(`${baseUrl}/api/v1/health`, {
			headers: { Accept: 'application/json', ...(await core.getAuthHeaders()) }
		});

		if (response.status >= 200 && response.status < 300) {
			return Response.json({ success: true });
		}
		return Response.json({
			success: false,
			error: `Cinephage API returned HTTP ${response.status}`
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return Response.json({ success: false, error: message });
	}
};
