/**
 * Install key registration
 *
 * POST /api/cinephage/register - register (or rotate) this install's
 * per-install gateway API key. Admin-gated. The plaintext key is returned
 * exactly once, in this response, and then only exists encrypted at rest.
 */

import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getCinephageCore } from '#lib/server/cinephage/core/CinephageCore.js';
import {
	CinephageRegistrationError,
	registrationErrorStatus
} from '#lib/server/cinephage/core/CinephageCore.js';
import { cinephageRegisterSchema } from '#lib/validation/schemas.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'CinephageRegister', logDomain: 'system' });

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const parsed = cinephageRegisterSchema.safeParse(await event.request.json());
	if (!parsed.success) {
		return Response.json(
			{ success: false, error: 'A valid email address is required' },
			{ status: 400 }
		);
	}

	try {
		const result = await getCinephageCore().registerInstallKey(
			parsed.data.email,
			parsed.data.label
		);
		// The one and only time the plaintext key crosses the wire to the UI.
		return Response.json({
			success: true,
			key: result.key,
			keyPrefix: result.keyPrefix,
			rotated: result.rotated,
			installId: result.installId
		});
	} catch (error) {
		if (error instanceof CinephageRegistrationError) {
			const status = registrationErrorStatus(error.code);
			logger.warn({ code: error.code }, 'Cinephage install key registration rejected');
			return Response.json({ success: false, error: error.message, code: error.code }, { status });
		}
		const message = error instanceof Error ? error.message : String(error);
		logger.error({ error: message }, 'Cinephage install key registration failed');
		return Response.json({ success: false, error: message }, { status: 500 });
	}
};
