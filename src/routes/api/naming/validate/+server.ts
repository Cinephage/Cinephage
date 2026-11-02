import type { RequestHandler } from './$types';
import { tokenRegistry } from '#lib/server/library/naming/tokens/index.js';
import { TemplateEngine } from '#lib/server/library/naming/template/index.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'NamingValidateApi', logDomain: 'scans' });

const templateEngine = new TemplateEngine(tokenRegistry);

/**
 * POST /api/naming/validate
 * Validates naming format strings and returns errors/warnings
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	try {
		const body = await request.json();
		const { formats } = body as { formats: Record<string, string> };

		if (!formats || typeof formats !== 'object') {
			return Response.json({ error: 'formats object is required' }, { status: 400 });
		}

		const results: Record<
			string,
			{
				valid: boolean;
				errors: Array<{ position: number; message: string; token?: string }>;
				warnings: Array<{ position: number; message: string; suggestion?: string }>;
				tokens: string[];
			}
		> = {};

		for (const [key, format] of Object.entries(formats)) {
			if (typeof format !== 'string') continue;

			const parseResult = templateEngine.parse(format);
			results[key] = {
				valid: parseResult.valid,
				errors: parseResult.errors.map((e) => ({
					position: e.position,
					message: e.message,
					token: e.token
				})),
				warnings: parseResult.warnings.map((w) => ({
					position: w.position,
					message: w.message,
					suggestion: w.suggestion
				})),
				tokens: templateEngine.getUsedTokens(format)
			};
		}

		return Response.json({ results });
	} catch (err) {
		logger.error({ err, component: 'NamingValidateApi' }, 'Error validating naming formats');
		return Response.json({ error: 'Failed to validate formats' }, { status: 500 });
	}
};
