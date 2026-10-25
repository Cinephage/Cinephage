/**
 * Channels with EPG API
 *
 * GET /api/livetv/channels/with-epg - Get channels that have EPG data available
 *
 * Used for the EPG source picker to allow users to select an alternative
 * channel's EPG data for channels that don't have their own EPG.
 */

import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.js';
import {
	livetvChannels,
	livetvAccounts,
	livetvCategories,
	epgPrograms
} from '#lib/server/db/schema.js';
import { eq, like, sql, and, gt } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LiveTvChannelsWithEpg', logDomain: 'livetv' });

interface ChannelWithEpgInfo {
	id: string;
	accountId: string;
	name: string;
	number: string | null;
	logo: string | null;
	categoryTitle: string | null;
	accountName: string;
	programCount: number;
}

export const GET: RequestHandler = async ({ url }) => {
	try {
		const search = url.searchParams.get('search') || '';
		const page = parseInt(url.searchParams.get('page') || '1');
		const pageSize = Math.min(parseInt(url.searchParams.get('pageSize') || '50'), 100);
		const offset = (page - 1) * pageSize;

		// Query channels that have at least one EPG program
		// Use a subquery to count programs per channel
		const programCountSubquery = db
			.select({
				channelId: epgPrograms.channelId,
				count: sql<number>`count(*)`.as('program_count')
			})
			.from(epgPrograms)
			.groupBy(epgPrograms.channelId)
			.as('program_counts');

		// Build the query
		let query = db
			.select({
				id: livetvChannels.id,
				accountId: livetvChannels.accountId,
				providerType: livetvChannels.providerType,
				name: livetvChannels.name,
				number: livetvChannels.number,
				logo: livetvChannels.logo,
				categoryTitle: livetvCategories.title,
				accountName: livetvAccounts.name,
				programCount: programCountSubquery.count
			})
			.from(livetvChannels)
			.innerJoin(programCountSubquery, eq(livetvChannels.id, programCountSubquery.channelId))
			.innerJoin(livetvAccounts, eq(livetvChannels.accountId, livetvAccounts.id))
			.leftJoin(livetvCategories, eq(livetvChannels.categoryId, livetvCategories.id))
			.where(gt(programCountSubquery.count, 0))
			.orderBy(livetvChannels.name)
			.limit(pageSize)
			.offset(offset);

		// Add search filter if provided
		if (search) {
			query = db
				.select({
					id: livetvChannels.id,
					accountId: livetvChannels.accountId,
					providerType: livetvChannels.providerType,
					name: livetvChannels.name,
					number: livetvChannels.number,
					logo: livetvChannels.logo,
					categoryTitle: livetvCategories.title,
					accountName: livetvAccounts.name,
					programCount: programCountSubquery.count
				})
				.from(livetvChannels)
				.innerJoin(programCountSubquery, eq(livetvChannels.id, programCountSubquery.channelId))
				.innerJoin(livetvAccounts, eq(livetvChannels.accountId, livetvAccounts.id))
				.leftJoin(livetvCategories, eq(livetvChannels.categoryId, livetvCategories.id))
				.where(and(gt(programCountSubquery.count, 0), like(livetvChannels.name, `%${search}%`)))
				.orderBy(livetvChannels.name)
				.limit(pageSize)
				.offset(offset);
		}

		const items = await query;

		// Get total count for pagination
		const countQuery = search
			? db
					.select({ count: sql<number>`count(distinct ${livetvChannels.id})` })
					.from(livetvChannels)
					.innerJoin(epgPrograms, eq(livetvChannels.id, epgPrograms.channelId))
					.where(like(livetvChannels.name, `%${search}%`))
			: db
					.select({ count: sql<number>`count(distinct ${livetvChannels.id})` })
					.from(livetvChannels)
					.innerJoin(epgPrograms, eq(livetvChannels.id, epgPrograms.channelId));

		const [countResult] = await countQuery;
		const total = countResult?.count || 0;

		const response: ChannelWithEpgInfo[] = items.map((row) => ({
			id: row.id,
			accountId: row.accountId,
			name: row.name,
			number: row.number,
			logo: row.logo,
			categoryTitle: row.categoryTitle || null,
			accountName: row.accountName || 'Unknown Account',
			programCount: row.programCount || 0
		}));

		return Response.json({
			success: true,
			items: response,
			total,
			page,
			pageSize,
			totalPages: Math.ceil(total / pageSize)
		});
	} catch (error) {
		logger.error(
			'[API] Failed to get channels with EPG',
			error instanceof Error ? error : undefined
		);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to get channels with EPG'
			},
			{ status: 500 }
		);
	}
};
