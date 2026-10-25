/**
 * Channel Sync API Endpoint
 *
 * POST /api/livetv/channels/sync - Trigger channel sync for accounts
 */

import type { RequestHandler } from './$types';
import { getLiveTvChannelService, getLiveTvAccountManager } from '#lib/server/livetv/index.js';
import { liveTvEvents } from '#lib/server/livetv/LiveTvEvents.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'LiveTvChannelsSync', logDomain: 'livetv' });

export const POST: RequestHandler = async ({ request }) => {
	const channelService = getLiveTvChannelService();
	const accountManager = getLiveTvAccountManager();

	try {
		const body = await request.json().catch(() => ({}));
		const { accountIds } = body as { accountIds?: string[] };

		// If no specific accounts, sync all enabled accounts
		if (!accountIds || accountIds.length === 0) {
			const accounts = await accountManager.getAccounts();
			const results: Record<string, unknown> = {};

			for (const account of accounts.filter((a: (typeof accounts)[0]) => a.enabled)) {
				liveTvEvents.emitChannelsSyncStarted(account.id);
				try {
					const result = await channelService.syncChannels(account.id);
					results[account.id] = result;
					liveTvEvents.emitChannelsSyncCompleted(account.id, result);
				} catch (err) {
					liveTvEvents.emitChannelsSyncFailed(
						account.id,
						err instanceof Error ? err.message : 'Unknown error'
					);
					results[account.id] = {
						success: false,
						error: err instanceof Error ? err.message : 'Unknown error'
					};
				}
			}

			return Response.json({
				success: true,
				results
			});
		}

		// Sync specific accounts
		const results: Record<string, unknown> = {};

		for (const accountId of accountIds) {
			// Verify account exists
			const account = await accountManager.getAccount(accountId);
			if (!account) {
				results[accountId] = {
					success: false,
					error: 'Account not found'
				};
				continue;
			}

			liveTvEvents.emitChannelsSyncStarted(accountId);
			try {
				const result = await channelService.syncChannels(accountId);
				results[accountId] = result;
				liveTvEvents.emitChannelsSyncCompleted(accountId, result);
			} catch (err) {
				liveTvEvents.emitChannelsSyncFailed(
					accountId,
					err instanceof Error ? err.message : 'Unknown error'
				);
				results[accountId] = {
					success: false,
					error: err instanceof Error ? err.message : 'Unknown error'
				};
			}
		}

		return Response.json({
			success: true,
			results
		});
	} catch (error) {
		logger.error('[API] Failed to sync channels', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to sync channels'
			},
			{ status: 500 }
		);
	}
};
