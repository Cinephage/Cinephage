import type { RequestHandler } from './$types';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import { downloadClientImplementationSchema } from '#lib/validation/schemas.js';
import { toFriendlyDownloadClientError } from '#lib/downloadClients/errorMessages.js';
import { z } from 'zod';

const downloadClientTestWithIdSchema = z.object({
	id: z.string().min(1).optional().nullable(),
	implementation: downloadClientImplementationSchema,
	host: z.string().min(1, 'Host is required').optional(),
	port: z.number().int().min(1).max(65535).optional(),
	useSsl: z.boolean().default(false),
	urlBase: z.string().max(200).optional().nullable(),
	mountMode: z.enum(['nzbdav', 'altmount']).optional().nullable(),
	username: z.string().optional().nullable(),
	password: z.string().optional().nullable(),
	apiToken: z.string().optional().nullable()
});

/**
 * POST /api/download-clients/test
 * Test a download client connection before saving.
 */
export const POST: RequestHandler = async ({ request }) => {
	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const result = downloadClientTestWithIdSchema.safeParse(data);

	if (!result.success) {
		const firstIssue = result.error.issues[0];
		return Response.json(
			{
				success: false,
				error: firstIssue?.message ?? 'Please review the required fields and try again.',
				details: result.error.flatten()
			},
			{ status: 400 }
		);
	}

	const validated = result.data;
	const manager = getDownloadClientManager();

	try {
		const isDebridTest =
			validated.implementation === 'realdebrid' || validated.implementation === 'torbox';
		const hasPasswordOverride =
			typeof validated.password === 'string' && validated.password.trim().length > 0;

		const testResult =
			validated.id && !hasPasswordOverride
				? await manager.testClientWithCredentialFallback(validated.id, {
						host: validated.host ?? '',
						port: validated.port ?? 0,
						useSsl: validated.useSsl,
						urlBase: validated.urlBase,
						mountMode: validated.mountMode,
						username: validated.username,
						password: validated.password,
						implementation: validated.implementation,
						apiToken: isDebridTest ? validated.apiToken : undefined
					})
				: await manager.testClient({
						host: validated.host ?? '',
						port: validated.port ?? 0,
						useSsl: validated.useSsl,
						urlBase: validated.urlBase,
						mountMode: validated.mountMode,
						username: validated.username,
						password: validated.password,
						implementation: validated.implementation,
						apiKey: validated.implementation === 'sabnzbd' ? validated.password : undefined,
						apiToken: isDebridTest ? validated.apiToken : undefined
					});

		if (!testResult.success) {
			return Response.json({
				...testResult,
				error: toFriendlyDownloadClientError(testResult.error)
			});
		}

		return Response.json(testResult);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		return Response.json(
			{
				success: false,
				error: toFriendlyDownloadClientError(message)
			},
			{ status: 500 }
		);
	}
};
