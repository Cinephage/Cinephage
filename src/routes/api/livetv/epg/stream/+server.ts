/**
 * Live TV EPG Stream SSE Endpoint
 *
 * GET /api/livetv/epg/stream - Real-time EPG status updates
 *
 * Events:
 * - connected: Initial connection established
 * - heartbeat: Keep-alive every 30s
 * - epg:initial: Full EPG status and lineup
 * - epg:syncStarted: EPG sync started
 * - epg:syncCompleted: EPG sync completed
 * - epg:syncFailed: EPG sync failed
 */

import { createSSEStream } from '#lib/server/sse.js';
import { liveTvEvents } from '#lib/server/livetv/LiveTvEvents.js';
import { channelLineupService } from '#lib/server/livetv/lineup/index.js';
import { getEpgService, getEpgScheduler } from '#lib/server/livetv/epg/index.js';
import { getEpgSyncState } from '#lib/server/livetv/epg/EpgSyncState.js';
import { db } from '#lib/server/db/index.js';
import { livetvAccounts } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LiveTVEPGStream' });

interface EpgStatusData {
	success: boolean;
	isEnabled: boolean;
	isSyncing: boolean;
	syncingAccountIds: string[];
	cancelRequestedAll: boolean;
	cancelRequestedAccountIds: string[];
	syncIntervalHours: number;
	retentionHours: number;
	lastSyncAt: string | null;
	nextSyncAt: string | null;
	totalPrograms: number;
	accounts: Array<{
		id: string;
		name: string;
		providerType: string;
		lastEpgSyncAt: string | null;
		programCount: number;
		hasEpg: boolean | null;
		error?: string;
	}>;
}

async function getEpgStatus(): Promise<EpgStatusData> {
	const epgService = getEpgService();
	const epgScheduler = getEpgScheduler();
	const epgSyncState = getEpgSyncState();

	const schedulerStatus = epgScheduler.getStatus();
	const syncSnapshot = epgSyncState.getSnapshot();
	const totalPrograms = epgService.getProgramCount();

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

	const accountStatuses = accounts.map((account) => ({
		id: account.id,
		name: account.name,
		providerType: account.providerType,
		lastEpgSyncAt: account.lastEpgSyncAt ?? null,
		programCount: account.epgProgramCount ?? 0,
		hasEpg: account.hasEpg ?? null,
		error: account.lastEpgSyncError ?? undefined
	}));

	return {
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
	};
}

export const GET: RequestHandler = async () => {
	return createSSEStream((send) => {
		const sendInitialState = async () => {
			try {
				const status = await getEpgStatus();
				const lineup = await channelLineupService.getLineup();
				send('epg:initial', { status, lineup });
			} catch (error) {
				logger.error(
					{
						error: error instanceof Error ? error.message : 'Unknown error'
					},
					'Failed to fetch initial EPG state'
				);
				send('epg:error', { message: 'Failed to fetch initial state' });
			}
		};

		sendInitialState();

		const onEpgSyncStarted = async (event: { accountId?: string }) => {
			const status = await getEpgStatus();
			send('epg:syncStarted', { ...event, status });
		};

		const onEpgSyncCompleted = async (event: { accountId?: string }) => {
			const status = await getEpgStatus();
			const lineup = await channelLineupService.getLineup();
			send('epg:syncCompleted', { ...event, status, lineup });
		};

		const onEpgSyncFailed = async (event: { accountId?: string; error: string }) => {
			const status = await getEpgStatus();
			send('epg:syncFailed', { ...event, status });
		};

		const onLineupUpdated = async () => {
			const lineup = await channelLineupService.getLineup();
			send('lineup:updated', { lineup });
		};

		liveTvEvents.onEpgSyncStarted(onEpgSyncStarted);
		liveTvEvents.onEpgSyncCompleted(onEpgSyncCompleted);
		liveTvEvents.onEpgSyncFailed(onEpgSyncFailed);
		liveTvEvents.onLineupUpdated(onLineupUpdated);

		return () => {
			liveTvEvents.offEpgSyncStarted(onEpgSyncStarted);
			liveTvEvents.offEpgSyncCompleted(onEpgSyncCompleted);
			liveTvEvents.offEpgSyncFailed(onEpgSyncFailed);
			liveTvEvents.offLineupUpdated(onLineupUpdated);
		};
	});
};
