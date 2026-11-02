/**
 * Bulk approve/decline (decline requires a reason). Admin only. Individual
 * failures do not abort the batch; per-id outcomes are returned. Approvals
 * run through a small worker pool — a 50-series batch must not hold one
 * HTTP connection for the sum of all orchestrator latencies.
 */

import type { RequestHandler } from './$types.js';
import { parseBody } from '#lib/server/api/validate.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { getRequestService } from '#lib/server/requests/RequestService.js';
import {
	bulkRequestSchema,
	requesterFromLocals,
	toRequestErrorResponse
} from '#lib/server/requests/http.js';
import { RequestError } from '#lib/server/requests/types.js';

const APPROVE_CONCURRENCY = 4;

export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const requester = requesterFromLocals(event.locals);
	if (!requester) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	try {
		const { ids, action, reason } = await parseBody(event.request, bulkRequestSchema);
		if (action === 'decline' && !reason) {
			throw new RequestError('reason_required', 'A reason is required when declining', 400);
		}

		const svc = getRequestService();
		const results: Array<{ id: string; ok: boolean; status?: string; error?: string }> = [];

		const runOne = async (id: string): Promise<void> => {
			try {
				const updated =
					action === 'approve'
						? await svc.approve(id, requester)
						: await svc.decline(id, requester, reason!);
				results.push({ id, ok: true, status: updated.status });
			} catch (error) {
				results.push({
					id,
					ok: false,
					error: error instanceof Error ? error.message : 'Failed'
				});
			}
		};

		if (action === 'approve' && ids.length > 1) {
			let cursor = 0;
			const worker = async (): Promise<void> => {
				while (cursor < ids.length) {
					const id = ids[cursor++];
					await runOne(id);
				}
			};
			await Promise.all(
				Array.from({ length: Math.min(APPROVE_CONCURRENCY, ids.length) }, () => worker())
			);
		} else {
			for (const id of ids) {
				await runOne(id);
			}
		}
		return Response.json({ success: true, results });
	} catch (error) {
		return toRequestErrorResponse(error);
	}
};
