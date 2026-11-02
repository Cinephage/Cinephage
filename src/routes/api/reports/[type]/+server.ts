import type { RequestHandler } from './$types.js';
import { db } from '#lib/server/db/index.js';
import {
	rejectedReleases,
	importFailures,
	renamingFailures,
	unmatchedFiles,
	downloadClients
} from '#lib/server/db/schema.js';
import { count, desc, asc, eq, ne, and, or, like, gt, inArray } from 'drizzle-orm';
import { logger } from '#lib/logging/index.js';
import { requireAdminLocals } from '#lib/server/auth/authorization.js';

const VALID_TYPES = [
	'rejected-releases',
	'import-failures',
	'renaming-failures',
	'unmatched-imports'
] as const;

type ReportType = (typeof VALID_TYPES)[number];

// This handler serves all four report types through one shared route, so the
// log domain is picked per-request from the type param rather than fixed at
// the module level - matches the domain each type's underlying pipeline
// stage already logs under elsewhere (grab decisions vs. post-download
// import vs. library scan/rename).
function reportTypeDomain(type: ReportType): 'downloads' | 'imports' | 'scans' {
	switch (type) {
		case 'rejected-releases':
			return 'downloads';
		case 'import-failures':
			return 'imports';
		case 'renaming-failures':
		case 'unmatched-imports':
			return 'scans';
	}
}

/**
 * GET /api/reports/[type]
 * List diagnostic report records for a given type with pagination.
 *
 * Query params:
 * - page: number (default: 1)
 * - limit: number (default: 25, max: 100)
 * - status: filter by status string
 * - order: 'asc' | 'desc' (default: 'desc')
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdminLocals(locals);
	if (authError) return authError;

	const type = params.type as ReportType;

	if (!VALID_TYPES.includes(type)) {
		return Response.json(
			{ success: false, error: `Unknown report type: ${type}` },
			{ status: 400 }
		);
	}

	const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
	const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '25', 10)));
	const offset = (page - 1) * limit;
	const statusFilter = url.searchParams.get('status');
	const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';

	try {
		let records: unknown[];
		let total: number;

		switch (type) {
			case 'rejected-releases': {
				const reasonParam = url.searchParams.get('reason');
				const searchParam = url.searchParams.get('search');
				const sinceParam = url.searchParams.get('since');
				const mediaTypeParam = url.searchParams.get('mediaType');

				const conditions = [];
				// Always exclude resolved records unless an explicit status filter is set
				if (statusFilter) {
					conditions.push(eq(rejectedReleases.status, statusFilter));
				} else {
					conditions.push(ne(rejectedReleases.status, 'resolved'));
				}
				if (reasonParam) conditions.push(eq(rejectedReleases.primaryReason, reasonParam));
				if (mediaTypeParam) conditions.push(eq(rejectedReleases.mediaType, mediaTypeParam));
				if (searchParam && searchParam.trim()) {
					const term = `%${searchParam.trim()}%`;
					conditions.push(
						or(like(rejectedReleases.releaseTitle, term), like(rejectedReleases.mediaTitle, term))
					);
				}
				if (sinceParam) {
					const ms =
						sinceParam === '24h'
							? 86_400_000
							: sinceParam === '7d'
								? 604_800_000
								: sinceParam === '30d'
									? 2_592_000_000
									: null;
					if (ms) {
						conditions.push(
							gt(rejectedReleases.rejectedAt, new Date(Date.now() - ms).toISOString())
						);
					}
				}

				const where = conditions.length > 0 ? and(...conditions) : undefined;
				const q = db.select().from(rejectedReleases);
				const cq = db.select({ count: count() }).from(rejectedReleases);
				if (where) {
					q.where(where);
					cq.where(where);
				}
				const [rows, [cnt]] = await Promise.all([
					q
						.orderBy(
							order === 'desc'
								? desc(rejectedReleases.rejectedAt)
								: asc(rejectedReleases.rejectedAt)
						)
						.limit(limit)
						.offset(offset),
					cq
				]);
				records = rows;
				total = cnt.count;
				break;
			}

			case 'import-failures': {
				const stageParam = url.searchParams.get('stage');
				const searchParam = url.searchParams.get('search');
				const sinceParam = url.searchParams.get('since');

				const conditions = [];
				if (statusFilter) {
					conditions.push(eq(importFailures.status, statusFilter));
				} else {
					conditions.push(ne(importFailures.status, 'resolved'));
				}
				if (stageParam) conditions.push(eq(importFailures.failureStage, stageParam));
				if (searchParam && searchParam.trim()) {
					const term = `%${searchParam.trim()}%`;
					conditions.push(
						or(like(importFailures.releaseTitle, term), like(importFailures.sourcePath, term))
					);
				}
				if (sinceParam) {
					const ms =
						sinceParam === '24h'
							? 86_400_000
							: sinceParam === '7d'
								? 604_800_000
								: sinceParam === '30d'
									? 2_592_000_000
									: null;
					if (ms) {
						conditions.push(gt(importFailures.failedAt, new Date(Date.now() - ms).toISOString()));
					}
				}

				const where = conditions.length > 0 ? and(...conditions) : undefined;
				const q = db
					.select({
						id: importFailures.id,
						correlationId: importFailures.correlationId,
						releaseTitle: importFailures.releaseTitle,
						sourcePath: importFailures.sourcePath,
						destinationPath: importFailures.destinationPath,
						failureStage: importFailures.failureStage,
						reason: importFailures.reason,
						reasonDetail: importFailures.reasonDetail,
						dangerousFiles: importFailures.dangerousFiles,
						attemptCount: importFailures.attemptCount,
						downloadClientId: importFailures.downloadClientId,
						failedAt: importFailures.failedAt,
						status: importFailures.status,
						resolvedAt: importFailures.resolvedAt,
						downloadClientName: downloadClients.name,
						downloadClientImplementation: downloadClients.implementation
					})
					.from(importFailures)
					.leftJoin(downloadClients, eq(importFailures.downloadClientId, downloadClients.id));
				const cq = db.select({ count: count() }).from(importFailures);
				if (where) {
					q.where(where);
					cq.where(where);
				}
				const [rows, [cnt]] = await Promise.all([
					q
						.orderBy(
							order === 'desc' ? desc(importFailures.failedAt) : asc(importFailures.failedAt)
						)
						.limit(limit)
						.offset(offset),
					cq
				]);
				records = rows;
				total = cnt.count;
				break;
			}

			case 'renaming-failures': {
				const reasonParam = url.searchParams.get('reason');
				const searchParam = url.searchParams.get('search');
				const sinceParam = url.searchParams.get('since');
				const fileTypeParam = url.searchParams.get('fileType');
				const conditions = [];
				if (statusFilter) {
					conditions.push(eq(renamingFailures.status, statusFilter));
				} else {
					conditions.push(ne(renamingFailures.status, 'resolved'));
				}
				if (reasonParam) conditions.push(eq(renamingFailures.reason, reasonParam));
				if (fileTypeParam) conditions.push(eq(renamingFailures.fileType, fileTypeParam));
				if (searchParam?.trim()) {
					const term = `%${searchParam.trim()}%`;
					conditions.push(
						or(like(renamingFailures.sourcePath, term), like(renamingFailures.intendedPath, term))
					);
				}
				if (sinceParam) {
					const ms =
						sinceParam === '24h'
							? 86_400_000
							: sinceParam === '7d'
								? 604_800_000
								: sinceParam === '30d'
									? 2_592_000_000
									: null;
					if (ms)
						conditions.push(gt(renamingFailures.failedAt, new Date(Date.now() - ms).toISOString()));
				}
				const rfWhere = conditions.length > 0 ? and(...conditions) : undefined;
				const q = db.select().from(renamingFailures);
				const cq = db.select({ count: count() }).from(renamingFailures);
				if (rfWhere) {
					q.where(rfWhere);
					cq.where(rfWhere);
				}
				const [rows, [cnt]] = await Promise.all([
					q
						.orderBy(
							order === 'desc' ? desc(renamingFailures.failedAt) : asc(renamingFailures.failedAt)
						)
						.limit(limit)
						.offset(offset),
					cq
				]);
				records = rows;
				total = cnt.count;
				break;
			}

			case 'unmatched-imports': {
				const reasonParam = url.searchParams.get('reason');
				const reasonGroupParam = url.searchParams.get('reasonGroup');
				const searchParam = url.searchParams.get('search');
				const sinceParam = url.searchParams.get('since');
				const mediaTypeParam = url.searchParams.get('mediaType');

				const conditions = [];
				if (reasonGroupParam === 'below_threshold') {
					conditions.push(
						inArray(unmatchedFiles.reason, ['low_confidence', 'multiple_matches', 'ambiguous'])
					);
				} else if (reasonParam) {
					conditions.push(eq(unmatchedFiles.reason, reasonParam));
				}
				if (mediaTypeParam) conditions.push(eq(unmatchedFiles.mediaType, mediaTypeParam));
				if (searchParam && searchParam.trim()) {
					const term = `%${searchParam.trim()}%`;
					conditions.push(
						or(like(unmatchedFiles.path, term), like(unmatchedFiles.parsedTitle, term))
					);
				}
				if (sinceParam) {
					const ms =
						sinceParam === '24h'
							? 86_400_000
							: sinceParam === '7d'
								? 604_800_000
								: sinceParam === '30d'
									? 2_592_000_000
									: null;
					if (ms) {
						conditions.push(
							gt(unmatchedFiles.discoveredAt, new Date(Date.now() - ms).toISOString())
						);
					}
				}

				const where = conditions.length > 0 ? and(...conditions) : undefined;
				const q = db.select().from(unmatchedFiles);
				const cq = db.select({ count: count() }).from(unmatchedFiles);
				if (where) {
					q.where(where);
					cq.where(where);
				}
				const [rows, [cnt]] = await Promise.all([
					q
						.orderBy(
							order === 'desc'
								? desc(unmatchedFiles.discoveredAt)
								: asc(unmatchedFiles.discoveredAt)
						)
						.limit(limit)
						.offset(offset),
					cq
				]);
				records = rows;
				total = cnt.count;
				break;
			}
		}

		return Response.json({
			success: true,
			data: {
				records,
				pagination: {
					page,
					limit,
					total,
					totalPages: Math.ceil(total / limit)
				}
			}
		});
	} catch (err) {
		logger.error(
			{ err, type, logDomain: reportTypeDomain(type) },
			'[Reports] Failed to load report records'
		);
		return Response.json(
			{ success: false, error: 'Failed to load report records' },
			{ status: 500 }
		);
	}
};

/**
 * PATCH /api/reports/[type]
 * Bulk-update record status. Body: { ids: string[], status: string }
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	// Defense-in-depth: the hooks viewer gate confines this route; this
	// guard keeps it admin-only even if the gate is ever refactored.
	const authError = requireAdminLocals(locals);
	if (authError) return authError;

	const type = params.type as ReportType;

	if (!VALID_TYPES.includes(type)) {
		return Response.json(
			{ success: false, error: `Unknown report type: ${type}` },
			{ status: 400 }
		);
	}

	let body: { ids?: string[]; status: string; resolveAll?: boolean };
	try {
		body = await request.json();
	} catch {
		return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	if (!body.status) {
		return Response.json({ success: false, error: 'status is required' }, { status: 400 });
	}

	if (!body.resolveAll && (!Array.isArray(body.ids) || body.ids.length === 0)) {
		return Response.json(
			{ success: false, error: 'ids (array) or resolveAll (boolean) is required' },
			{ status: 400 }
		);
	}

	const resolvedAt = new Date().toISOString();

	try {
		let updated = 0;

		if (body.resolveAll) {
			// Resolve every unresolved record for this type — no IDs needed
			switch (type) {
				case 'rejected-releases': {
					const result = await db
						.update(rejectedReleases)
						.set({ status: body.status })
						.where(ne(rejectedReleases.status, body.status));
					updated = result.changes;
					break;
				}
				case 'import-failures': {
					const result = await db
						.update(importFailures)
						.set({
							status: body.status,
							resolvedAt: body.status === 'resolved' ? resolvedAt : null
						})
						.where(ne(importFailures.status, body.status));
					updated = result.changes;
					break;
				}
				case 'renaming-failures': {
					const result = await db
						.update(renamingFailures)
						.set({
							status: body.status,
							resolvedAt: body.status === 'resolved' ? resolvedAt : null
						})
						.where(ne(renamingFailures.status, body.status));
					updated = result.changes;
					break;
				}
				case 'unmatched-imports':
					return Response.json(
						{ success: false, error: 'Unmatched imports are managed via the library page' },
						{ status: 400 }
					);
			}
		} else {
			const ids = body.ids!;
			// SQLite doesn't support inArray with drizzle update easily, so we iterate
			// For small batches (UI use) this is fine; a proper bulk update can be added later
			switch (type) {
				case 'rejected-releases':
					for (const id of ids) {
						await db
							.update(rejectedReleases)
							.set({ status: body.status })
							.where(eq(rejectedReleases.id, id));
					}
					break;
				case 'import-failures':
					for (const id of ids) {
						await db
							.update(importFailures)
							.set({
								status: body.status,
								resolvedAt: body.status === 'resolved' ? resolvedAt : null
							})
							.where(eq(importFailures.id, id));
					}
					break;
				case 'renaming-failures':
					for (const id of ids) {
						await db
							.update(renamingFailures)
							.set({
								status: body.status,
								resolvedAt: body.status === 'resolved' ? resolvedAt : null
							})
							.where(eq(renamingFailures.id, id));
					}
					break;
				case 'unmatched-imports':
					return Response.json(
						{ success: false, error: 'Unmatched imports are managed via the library page' },
						{ status: 400 }
					);
			}
			updated = ids.length;
		}

		return Response.json({ success: true, data: { updated } });
	} catch (err) {
		logger.error(
			{ err, type, logDomain: reportTypeDomain(type) },
			'[Reports] Failed to update record status'
		);
		return Response.json({ success: false, error: 'Failed to update records' }, { status: 500 });
	}
};
