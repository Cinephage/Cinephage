import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import { user } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { locales } from '#lib/paraglide/runtime.js';
import { createChildLogger } from '#lib/logging/index.js';
import { parseBody } from '#lib/server/api/validate.js';
import { z } from 'zod';

const logger = createChildLogger({ module: 'UserLanguageApi', logDomain: 'system' });

const userLanguageSchema = z.object({
	language: z.string().min(1, 'Language is required')
});

const VALID_LANGUAGES = new Set<string>(locales);

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const { language } = await parseBody(request, userLanguageSchema);

		if (!VALID_LANGUAGES.has(language)) {
			return Response.json(
				{
					success: false,
					error: 'Invalid language',
					supportedLanguages: Array.from(VALID_LANGUAGES)
				},
				{ status: 400 }
			);
		}

		await db.update(user).set({ language }).where(eq(user.id, locals.user.id));

		logger.info(
			{ userId: locals.user.id, language },
			'[UserLanguage] Updated user language preference'
		);

		return Response.json({ success: true, language });
	} catch (error) {
		logger.error(
			{ err: error, userId: locals.user.id },
			'[UserLanguage] Failed to update user language preference'
		);

		return Response.json(
			{ success: false, error: 'Failed to update language preference' },
			{ status: 500 }
		);
	}
};

export const PUT: RequestHandler = POST;
