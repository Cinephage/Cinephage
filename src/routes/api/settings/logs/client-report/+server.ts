import type { RequestHandler } from './$types';
import { z } from 'zod';
import { logger } from '#lib/logging/index.js';

const clientErrorReportSchema = z.object({
	supportId: z.string().min(1).max(100),
	message: z.string().min(1).max(2000),
	status: z.number().int().min(100).max(599).optional(),
	path: z.string().min(1).max(1000),
	routeId: z.string().max(500).nullable().optional(),
	userAgent: z.string().max(1000).optional(),
	error: z
		.object({
			name: z.string().max(200).optional(),
			message: z.string().max(2000).optional(),
			stack: z.string().max(12000).optional()
		})
		.optional()
});

function isSameOriginRequest(event: Parameters<RequestHandler>[0]): boolean {
	const origin = event.request.headers.get('origin');
	if (!origin) {
		return true;
	}

	return origin === event.url.origin;
}

export const POST: RequestHandler = async (event) => {
	if (!isSameOriginRequest(event)) {
		return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
	}

	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	const parsed = clientErrorReportSchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{
				success: false,
				error: 'Validation failed',
				details: parsed.error.flatten()
			},
			{ status: 400 }
		);
	}

	const payload = parsed.data;

	logger.error(
		{
			logDomain: 'client',
			component: 'client-error-report',
			supportId: payload.supportId,
			status: payload.status,
			path: payload.path,
			data: {
				routeId: payload.routeId ?? null,
				userAgent: payload.userAgent ?? null
			},
			err: payload.error
		},
		payload.message
	);

	return Response.json({ success: true });
};
