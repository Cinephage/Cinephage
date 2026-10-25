/**
 * EPG Sync API
 *
 * POST /api/livetv/epg/sync - Trigger EPG sync for all accounts (non-blocking)
 * POST /api/livetv/epg/sync?accountId=xxx - Trigger EPG sync for specific account (non-blocking)
 * DELETE /api/livetv/epg/sync - Cancel currently running sync for all accounts
 * DELETE /api/livetv/epg/sync?accountId=xxx - Cancel currently running sync for one account
 *
 * Returns immediately while sync runs in background.
 * Use GET /api/livetv/epg/status to check sync progress.
 */

import type { RequestHandler } from './$types';
import { getEpgService, getEpgScheduler } from '#lib/server/livetv/epg/index.js';
import { EPG_SYNC_CANCELLED_MESSAGE } from '#lib/server/livetv/epg/EpgService.js';
import { getEpgSyncState } from '#lib/server/livetv/epg/EpgSyncState.js';
import { liveTvEvents } from '#lib/server/livetv/LiveTvEvents.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LiveTvEpgSync', logDomain: 'livetv' });

export const POST: RequestHandler = async ({ url }) => {
	const accountId = url.searchParams.get('accountId');
	const syncState = getEpgSyncState();
	const epgScheduler = getEpgScheduler();
	const schedulerStatus = epgScheduler.getStatus();

	if (schedulerStatus.isSyncing) {
		return Response.json(
			{
				success: true,
				started: false,
				alreadyRunning: true,
				message: 'EPG scheduler sync already running'
			},
			{ status: 202 }
		);
	}

	if (accountId) {
		if (!syncState.tryStartAccount(accountId)) {
			return Response.json(
				{
					success: true,
					started: false,
					alreadyRunning: true,
					message: `EPG sync already running for account ${accountId}`
				},
				{ status: 202 }
			);
		}
	} else if (!syncState.tryStartAll()) {
		return Response.json(
			{
				success: true,
				started: false,
				alreadyRunning: true,
				message: 'EPG sync already running'
			},
			{ status: 202 }
		);
	}

	// Fire-and-forget: start sync in background, return immediately
	setImmediate(async () => {
		try {
			const epgService = getEpgService();

			if (accountId) {
				logger.info({ accountId }, '[EPG] Starting background sync for account');
				liveTvEvents.emitEpgSyncStarted(accountId);
				try {
					const result = await epgService.syncAccount(accountId, {
						shouldCancel: () => syncState.isCancelRequestedForAccount(accountId)
					});
					if (result.success) {
						liveTvEvents.emitEpgSyncCompleted(accountId);
						logger.info({ accountId }, '[EPG] Background sync complete for account');
					} else {
						const errorMessage = result.error ?? 'EPG sync failed';
						liveTvEvents.emitEpgSyncFailed(accountId, errorMessage);
						logger.warn(
							{
								accountId,
								error: errorMessage
							},
							'[EPG] Background sync finished with failure for account'
						);
					}
				} catch (err) {
					liveTvEvents.emitEpgSyncFailed(
						accountId,
						err instanceof Error ? err.message : 'Unknown error'
					);
					throw err;
				}
			} else {
				logger.info('[EPG] Starting background sync for all accounts');
				liveTvEvents.emitEpgSyncStarted();
				try {
					const results = await epgService.syncAll({
						shouldCancelAll: () => syncState.isCancelRequestedAll(),
						shouldCancelAccount: (id) => syncState.isCancelRequestedForAccount(id)
					});
					liveTvEvents.emitEpgSyncCompleted();
					const successful = results.filter((r) => r.success).length;
					const totalAdded = results.reduce((sum, r) => sum + r.programsAdded, 0);
					logger.info(
						{
							accounts: results.length,
							successful,
							totalAdded
						},
						'[EPG] Background sync complete'
					);
				} catch (err) {
					liveTvEvents.emitEpgSyncFailed(
						undefined,
						err instanceof Error ? err.message : 'Unknown error'
					);
					throw err;
				}
			}
		} catch (error) {
			logger.error(
				{
					accountId,
					error: error instanceof Error ? error.message : 'Unknown error'
				},
				'[EPG] Background sync failed'
			);
		} finally {
			if (accountId) {
				syncState.finishAccount(accountId);
			} else {
				syncState.finishAll();
			}
		}
	});

	return Response.json({
		success: true,
		started: true,
		alreadyRunning: false,
		message: accountId
			? `EPG sync started for account ${accountId}`
			: 'EPG sync started for all accounts'
	});
};

export const DELETE: RequestHandler = async ({ url }) => {
	const accountId = url.searchParams.get('accountId');
	const syncState = getEpgSyncState();

	const cancelRequested = accountId
		? syncState.requestCancelAccount(accountId)
		: syncState.requestCancelAll();

	if (!cancelRequested) {
		return Response.json(
			{
				success: true,
				cancelRequested: false,
				message: accountId
					? `No running EPG sync found for account ${accountId}`
					: 'No running EPG sync found'
			},
			{ status: 202 }
		);
	}

	logger.info(
		{ accountId: accountId ?? 'all' },
		accountId
			? '[EPG] Cancel requested for account sync'
			: '[EPG] Cancel requested for running sync'
	);

	liveTvEvents.emitEpgSyncFailed(accountId ?? undefined, EPG_SYNC_CANCELLED_MESSAGE);

	return Response.json(
		{
			success: true,
			cancelRequested: true,
			message: accountId
				? `Cancellation requested for account ${accountId}`
				: 'Cancellation requested for running EPG sync'
		},
		{ status: 202 }
	);
};
