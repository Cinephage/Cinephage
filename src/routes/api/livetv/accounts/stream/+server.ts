/**
 * Live TV Accounts Stream SSE Endpoint
 *
 * GET /api/livetv/accounts/stream - Real-time account updates
 *
 * Events:
 * - connected: Initial connection established
 * - heartbeat: Keep-alive every 30s
 * - accounts:initial: Full accounts list
 * - account:created: New account added
 * - account:updated: Account updated (settings, sync status, test result)
 * - account:deleted: Account removed
 * - channels:syncStarted: Channel sync started
 * - channels:syncCompleted: Channel sync completed
 * - channels:syncFailed: Channel sync failed
 */

import { createSSEStream } from '#lib/server/sse.js';
import { liveTvEvents } from '#lib/server/livetv/LiveTvEvents.js';
import { getLiveTvAccountManager } from '#lib/server/livetv/LiveTvAccountManager.js';
import { redactAccountSecrets } from '#lib/server/livetv/accountRedaction.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import type { RequestHandler } from './$types';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LiveTVAccountsStream' });

export const GET: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	return createSSEStream((send) => {
		const sendInitialState = async () => {
			try {
				const manager = getLiveTvAccountManager();
				const accounts = (await manager.getAccounts()).map(redactAccountSecrets);
				send('accounts:initial', { accounts });
			} catch (error) {
				logger.error(
					{
						error: error instanceof Error ? error.message : 'Unknown error'
					},
					'Failed to fetch initial LiveTV accounts state'
				);
				send('accounts:error', { message: 'Failed to fetch initial state' });
			}
		};

		sendInitialState();

		const onAccountCreated = async (_event: { accountId: string }) => {
			const manager = getLiveTvAccountManager();
			const accounts = (await manager.getAccounts()).map(redactAccountSecrets);
			send('account:created', { accounts });
		};

		const onAccountUpdated = async (_event: { accountId: string }) => {
			const manager = getLiveTvAccountManager();
			const accounts = (await manager.getAccounts()).map(redactAccountSecrets);
			send('account:updated', { accounts });
		};

		const onAccountDeleted = async (_event: { accountId: string }) => {
			const manager = getLiveTvAccountManager();
			const accounts = (await manager.getAccounts()).map(redactAccountSecrets);
			send('account:deleted', { accounts });
		};

		const onChannelsSyncStarted = (event: { accountId: string }) => {
			send('channels:syncStarted', event);
		};

		const onChannelsSyncCompleted = (event: { accountId: string; result: unknown }) => {
			send('channels:syncCompleted', event);
		};

		const onChannelsSyncFailed = (event: { accountId: string; error: string }) => {
			send('channels:syncFailed', event);
		};

		liveTvEvents.onAccountCreated(onAccountCreated);
		liveTvEvents.onAccountUpdated(onAccountUpdated);
		liveTvEvents.onAccountDeleted(onAccountDeleted);
		liveTvEvents.onChannelsSyncStarted(onChannelsSyncStarted);
		liveTvEvents.onChannelsSyncCompleted(onChannelsSyncCompleted);
		liveTvEvents.onChannelsSyncFailed(onChannelsSyncFailed);

		return () => {
			liveTvEvents.offAccountCreated(onAccountCreated);
			liveTvEvents.offAccountUpdated(onAccountUpdated);
			liveTvEvents.offAccountDeleted(onAccountDeleted);
			liveTvEvents.offChannelsSyncStarted(onChannelsSyncStarted);
			liveTvEvents.offChannelsSyncCompleted(onChannelsSyncCompleted);
			liveTvEvents.offChannelsSyncFailed(onChannelsSyncFailed);
		};
	});
};
