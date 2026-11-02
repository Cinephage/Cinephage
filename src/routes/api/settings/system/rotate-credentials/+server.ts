import type { RequestHandler } from './$types';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { rotateCredentials } from '#lib/server/crypto/credentialRotation.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({
	module: 'SettingsSystemRotateCredentials',
	logDomain: 'system'
});

/**
 * POST /api/settings/system/rotate-credentials
 * Re-encrypt every stored credential under the current master key. Run after
 * changing the master key with the old key(s) set in ENCRYPTION_PREVIOUS_KEYS.
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const result = rotateCredentials();
		return Response.json({
			success: true,
			message:
				result.failed > 0
					? `Rotated ${result.rotated} credential(s); ${result.failed} could not be decrypted with any available key — re-enter those in settings`
					: `Rotated ${result.rotated} credential(s) under the current master key`,
			result
		});
	} catch (error) {
		logger.error(
			{ err: error instanceof Error ? error : undefined },
			'[API] Failed to rotate credentials'
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to rotate credentials',
				message: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};
