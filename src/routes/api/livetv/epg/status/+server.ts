/**
 * EPG Status API
 *
 * GET /api/livetv/epg/status - Get EPG sync status and statistics
 */

import type { RequestHandler } from './$types';
import { getEpgService, getEpgScheduler } from '#lib/server/livetv/epg/index.js';
import { getEpgSyncState } from '#lib/server/livetv/epg/EpgSyncState.js';
import { db } from '#lib/server/db/index.js';
import { livetvAccounts } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LiveTvEpgStatus', logDomain: 'livetv' });

export const GET: RequestHandler = async () => {
	try {
		const epgService = getEpgService();
		const epgScheduler = getEpgScheduler();
		const epgSyncState = getEpgSyncState();

		// Get scheduler status for sync info
		const schedulerStatus = epgScheduler.getStatus();
		const syncSnapshot = epgSyncState.getSnapshot();

		// Get total program count
		const totalPrograms = epgService.getProgramCount();

		// Get all enabled accounts with EPG tracking columns
		const accounts = db
			.select({
				id: livetvAccounts.id,
				name: livetvAccounts.name,
				providerType: livetvAccounts.providerType,
				lastEpgSyncAt: livetvAccounts.lastEpgSyncAt,
				lastEpgSyncError: livetvAccounts.lastEpgSyncError,
				epgProgramCount: livetvAccounts.epgProgramCount,
				hasEpg: livetvAccounts.hasEpg
			})
			.from(livetvAccounts)
			.where(eq(livetvAccounts.enabled, true))
			.all();

		// Build account status list
		const accountStatuses = accounts.map((account) => ({
			id: account.id,
			name: account.name,
			providerType: account.providerType,
			lastEpgSyncAt: account.lastEpgSyncAt ?? null,
			programCount: account.epgProgramCount ?? 0,
			hasEpg: account.hasEpg ?? null,
			error: account.lastEpgSyncError ?? undefined
		}));

		return Response.json({
			success: true,
			isEnabled: true,
			isSyncing:
				schedulerStatus.isSyncing ||
				syncSnapshot.syncingAll ||
				syncSnapshot.syncingAccountIds.length > 0,
			syncingAccountIds: syncSnapshot.syncingAccountIds,
			cancelRequestedAll: syncSnapshot.cancelRequestedAll,
			cancelRequestedAccountIds: syncSnapshot.cancelRequestedAccountIds,
			syncIntervalHours: schedulerStatus.syncIntervalHours,
			retentionHours: schedulerStatus.retentionHours,
			lastSyncAt: schedulerStatus.lastSyncAt,
			nextSyncAt: schedulerStatus.nextSyncAt,
			totalPrograms,
			accounts: accountStatuses
		});
	} catch (error) {
		logger.error('[API] Failed to get EPG status', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to get EPG status'
			},
			{ status: 500 }
		);
	}
};
