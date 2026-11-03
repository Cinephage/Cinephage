/**
 * Install key revocation
 *
 * POST /api/cinephage/revoke - retire this install's gateway API key at the
 * gateway and drop the stored copy (the installId is kept, so registering
 * again later just works). Admin-gated.
 */

import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getCinephageCore } from '#lib/server/cinephage/core/CinephageCore.js';
import { CinephageRegistrationError } from '#lib/server/cinephage/core/CinephageCore.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'CinephageRevoke', logDomain: 'system' });

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const result = await getCinephageCore().revokeInstallKey();
		return Response.json({ success: true, ...result });
	} catch (error) {
		if (error instanceof CinephageRegistrationError) {
			const status = error.code === 'rate_limited' ? 429 : 502;
			logger.warn({ code: error.code }, 'Cinephage install key revoke rejected');
			return Response.json({ success: false, error: error.message, code: error.code }, { status });
		}
		const message = error instanceof Error ? error.message : String(error);
		logger.error({ error: message }, 'Cinephage install key revoke failed');
		return Response.json({ success: false, error: message }, { status: 500 });
	}
};
