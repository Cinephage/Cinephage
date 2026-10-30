/**
 * EPG sync trigger helpers
 *
 * Shared by the routes that need to kick off a background EPG sync for one
 * account (after account create, channel sync, or an EPG-relevant account
 * update). Guarded by the same in-process EpgSyncState singleton as the
 * scheduler and the manual endpoints, so triggers never overlap a running
 * sync.
 */

import { getEpgService } from './EpgService.js';
import { getEpgScheduler } from './EpgScheduler.js';
import { getEpgSyncState } from './EpgSyncState.js';
import { liveTvEvents } from '../LiveTvEvents.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LiveTvEpgTrigger', logDomain: 'livetv' });

/**
 * Fire-and-forget EPG sync for one account. Silently skips when a scheduler
 * sync or another sync for the same account is already running.
 */
export function queueAccountEpgSync(accountId: string, reason: string): void {
	const syncState = getEpgSyncState();
	const epgScheduler = getEpgScheduler();

	if (epgScheduler.getStatus().isSyncing) {
		logger.info(
			{ accountId, reason },
			'[EPG] Skipping account EPG sync trigger: scheduler running'
		);
		return;
	}

	if (!syncState.tryStartAccount(accountId)) {
		logger.info({ accountId, reason }, '[EPG] Skipping account EPG sync trigger: already syncing');
		return;
	}

	setImmediate(async () => {
		try {
			const epgService = getEpgService();
			liveTvEvents.emitEpgSyncStarted(accountId);
			const result = await epgService.syncAccount(accountId, {
				shouldCancel: () => syncState.isCancelRequestedForAccount(accountId)
			});

			if (result.success) {
				liveTvEvents.emitEpgSyncCompleted(accountId);
				logger.info({ accountId, reason }, '[EPG] Background account EPG sync complete');
			} else {
				const errorMessage = result.error ?? 'EPG sync failed';
				liveTvEvents.emitEpgSyncFailed(accountId, errorMessage);
				logger.warn(
					{ accountId, reason, error: errorMessage },
					'[EPG] Background account EPG sync failed'
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			liveTvEvents.emitEpgSyncFailed(accountId, message);
			logger.error(
				{ accountId, reason, error: message },
				'[EPG] Background account EPG sync errored'
			);
		} finally {
			syncState.finishAccount(accountId);
		}
	});
}
