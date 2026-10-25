import type { RequestHandler } from './$types';
import { captchaSolverSettingsService } from '#lib/server/captcha/index.js';
import { captchaSolverSettingsUpdateSchema } from '#lib/validation/schemas.js';
import { createChildLogger } from '#lib/logging/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';

const logger = createChildLogger({ module: 'CaptchaSolverApi', logDomain: 'indexers' });

/**
 * GET /api/captcha-solver
 * Returns current captcha solver settings
 */
export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const config = captchaSolverSettingsService.getConfig();

		return Response.json({
			success: true,
			settings: {
				enabled: config.enabled,
				timeoutSeconds: config.timeoutSeconds,
				cacheTtlSeconds: config.cacheTtlSeconds,
				headless: config.headless,
				proxyUrl: config.proxy?.url || '',
				proxyUsername: config.proxy?.username || '',
				proxyPassword: config.proxy?.password ? '********' : '' // Mask password
			}
		});
	} catch (error) {
		logger.error(
			'[API] Failed to get captcha solver settings',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to get captcha solver settings'
			},
			{ status: 500 }
		);
	}
};

/**
 * PUT /api/captcha-solver
 * Update captcha solver settings
 */
export const PUT: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	try {
		const body = await request.json();
		const validation = captchaSolverSettingsUpdateSchema.safeParse(body);

		if (!validation.success) {
			return Response.json(
				{
					success: false,
					error: 'Invalid request body',
					details: validation.error.issues
				},
				{ status: 400 }
			);
		}

		const settings = validation.data;

		// Update settings
		const updatedConfig = captchaSolverSettingsService.updateConfig(settings);

		return Response.json({
			success: true,
			message: 'Captcha solver settings updated',
			settings: {
				enabled: updatedConfig.enabled,
				timeoutSeconds: updatedConfig.timeoutSeconds,
				cacheTtlSeconds: updatedConfig.cacheTtlSeconds,
				headless: updatedConfig.headless,
				proxyUrl: updatedConfig.proxy?.url || '',
				proxyUsername: updatedConfig.proxy?.username || '',
				proxyPassword: updatedConfig.proxy?.password ? '********' : ''
			}
		});
	} catch (error) {
		logger.error(
			'[API] Failed to update captcha solver settings',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to update captcha solver settings'
			},
			{ status: 500 }
		);
	}
};

/**
 * DELETE /api/captcha-solver
 * Reset captcha solver settings to defaults
 */
export const DELETE: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	try {
		const defaultConfig = captchaSolverSettingsService.resetToDefaults();

		return Response.json({
			success: true,
			message: 'Captcha solver settings reset to defaults',
			settings: {
				enabled: defaultConfig.enabled,
				timeoutSeconds: defaultConfig.timeoutSeconds,
				cacheTtlSeconds: defaultConfig.cacheTtlSeconds,
				headless: defaultConfig.headless,
				proxyUrl: '',
				proxyUsername: '',
				proxyPassword: ''
			}
		});
	} catch (error) {
		logger.error(
			'[API] Failed to reset captcha solver settings',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: 'Failed to reset captcha solver settings'
			},
			{ status: 500 }
		);
	}
};
