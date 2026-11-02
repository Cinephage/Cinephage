import { unmatchedFiles } from '#lib/server/db/schema.js';
import { count } from 'drizzle-orm';
import type { InsightItemResolver } from './types.js';

export const orphanedFilesResolver: InsightItemResolver = async ({ db, page, limit }) => {
	const total = db.select({ count: count() }).from(unmatchedFiles).get()?.count ?? 0;
	if (total === 0) return { items: [], total: 0 };

	const rows = db
		.select({
			id: unmatchedFiles.id,
			path: unmatchedFiles.path,
			mediaType: unmatchedFiles.mediaType,
			size: unmatchedFiles.size,
			parsedTitle: unmatchedFiles.parsedTitle,
			parsedYear: unmatchedFiles.parsedYear,
			parsedSeason: unmatchedFiles.parsedSeason,
			parsedEpisode: unmatchedFiles.parsedEpisode,
			reason: unmatchedFiles.reason
		})
		.from(unmatchedFiles)
		.limit(limit)
		.offset((page - 1) * limit)
		.all();

	return {
		items: rows.map((row) => ({
			id: `of-${row.id}`,
			kind: 'file' as const,
			title: row.parsedTitle ?? row.path.split('/').pop() ?? row.id,
			subtitle: row.path,
			sizeBytes: row.size ?? undefined,
			badges: [
				{ label: row.mediaType, tone: 'info' as const },
				...(row.parsedYear ? [{ label: String(row.parsedYear), tone: 'info' as const }] : [])
			],
			href: '/library/unmatched'
		})),
		total
	};
};
