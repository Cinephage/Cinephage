/**
 * Live TV Channels Stream SSE Endpoint
 *
 * GET /api/livetv/channels/stream - Real-time channel lineup updates
 *
 * Events:
 * - connected: Initial connection established
 * - heartbeat: Keep-alive every 30s
 * - livetv:sync: Current lineup, categories, and EPG now/next data
 * - lineup:updated: Lineup changed (add/remove/reorder)
 * - categories:updated: Categories changed
 * - channels:syncStarted: Channel sync started
 * - channels:syncCompleted: Channel sync completed
 * - channels:syncFailed: Channel sync failed
 * - epg:nowNext: Periodic EPG now/next updates (every 60s)
 */

import { createSSEStream } from '#lib/server/sse.js';
import { liveTvEvents } from '#lib/server/livetv/LiveTvEvents.js';
import { channelLineupService } from '#lib/server/livetv/lineup/index.js';
import { channelCategoryService } from '#lib/server/livetv/categories/index.js';
import { getEpgService } from '#lib/server/livetv/epg/index.js';
import type { RequestHandler } from './$types';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ component: 'LiveTVChannelsStream', logDomain: 'livetv' });

interface NowNextEntry {
	now: unknown;
	next: unknown;
}

async function getInitialData() {
	const lineup = await channelLineupService.getLineup();
	const categories = await channelCategoryService.getCategories();

	const epgService = getEpgService();
	const epgNowNext: Record<string, NowNextEntry> = {};

	if (lineup.length > 0) {
		const epgSourceMap = new Map<string, string>();
		for (const item of lineup) {
			const epgChannelId = item.epgSourceChannelId ?? item.channelId;
			epgSourceMap.set(item.channelId, epgChannelId);
		}
		const epgSourceIds = [...new Set(epgSourceMap.values())];
		const nowNextMap = epgService.getNowAndNext(epgSourceIds);

		for (const item of lineup) {
			const epgChannelId = epgSourceMap.get(item.channelId)!;
			const epgData = nowNextMap.get(epgChannelId);
			epgNowNext[item.channelId] = {
				now: epgData?.now ?? null,
				next: epgData?.next ?? null
			};
		}
	}

	return { lineup, categories, epgNowNext };
}

export const GET: RequestHandler = async () => {
	return createSSEStream((send) => {
		let epgInterval: ReturnType<typeof setInterval> | null = null;

		const sendInitialState = async () => {
			try {
				const data = await getInitialData();
				send('livetv:sync', {
					...data,
					lineupChannelIds: data.lineup.map((item) => item.channelId)
				});
			} catch (error) {
				logger.error({ err: error }, 'Failed to fetch initial LiveTV state');
				send('livetv:error', { message: 'Failed to fetch initial state' });
			}
		};

		const sendEpgNowNext = async () => {
			try {
				const lineup = await channelLineupService.getLineup();
				if (lineup.length === 0) return;

				const epgService = getEpgService();
				const epgSourceMap = new Map<string, string>();
				for (const item of lineup) {
					const epgChannelId = item.epgSourceChannelId ?? item.channelId;
					epgSourceMap.set(item.channelId, epgChannelId);
				}
				const epgSourceIds = [...new Set(epgSourceMap.values())];
				const nowNextMap = epgService.getNowAndNext(epgSourceIds);

				const epgNowNext: Record<string, NowNextEntry> = {};
				for (const item of lineup) {
					const epgChannelId = epgSourceMap.get(item.channelId)!;
					const epgData = nowNextMap.get(epgChannelId);
					epgNowNext[item.channelId] = {
						now: epgData?.now ?? null,
						next: epgData?.next ?? null
					};
				}

				send('epg:nowNext', { channels: epgNowNext });
			} catch (error) {
				logger.error({ err: error }, 'Failed to fetch EPG now/next data');
			}
		};

		sendInitialState();

		epgInterval = setInterval(sendEpgNowNext, 60000);

		const onLineupUpdated = async () => {
			const data = await getInitialData();
			send('lineup:updated', {
				lineup: data.lineup,
				lineupChannelIds: data.lineup.map((item) => item.channelId)
			});
		};

		const onCategoriesUpdated = async () => {
			const data = await getInitialData();
			send('categories:updated', {
				categories: data.categories
			});
		};

		const onChannelsSyncStarted = (event: { accountId: string }) => {
			send('channels:syncStarted', event);
		};

		const onChannelsSyncCompleted = async (event: { accountId: string; result: unknown }) => {
			send('channels:syncCompleted', event);
			sendEpgNowNext();
		};

		const onChannelsSyncFailed = (event: { accountId: string; error: string }) => {
			send('channels:syncFailed', event);
		};

		const onEpgSyncCompleted = () => {
			sendEpgNowNext();
		};

		liveTvEvents.onLineupUpdated(onLineupUpdated);
		liveTvEvents.onCategoriesUpdated(onCategoriesUpdated);
		liveTvEvents.onChannelsSyncStarted(onChannelsSyncStarted);
		liveTvEvents.onChannelsSyncCompleted(onChannelsSyncCompleted);
		liveTvEvents.onChannelsSyncFailed(onChannelsSyncFailed);
		liveTvEvents.onEpgSyncCompleted(onEpgSyncCompleted);

		return () => {
			if (epgInterval) {
				clearInterval(epgInterval);
			}
			liveTvEvents.offLineupUpdated(onLineupUpdated);
			liveTvEvents.offCategoriesUpdated(onCategoriesUpdated);
			liveTvEvents.offChannelsSyncStarted(onChannelsSyncStarted);
			liveTvEvents.offChannelsSyncCompleted(onChannelsSyncCompleted);
			liveTvEvents.offChannelsSyncFailed(onChannelsSyncFailed);
			liveTvEvents.offEpgSyncCompleted(onEpgSyncCompleted);
		};
	});
};
