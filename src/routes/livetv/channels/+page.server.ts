import type { ServerLoad } from '@sveltejs/kit';
import { getManagedApiKeysForRequest } from '#lib/server/auth/index.js';
import { channelLineupService } from '#lib/server/livetv/lineup/index.js';
import { channelCategoryService } from '#lib/server/livetv/categories/index.js';
import { getEpgService } from '#lib/server/livetv/epg/index.js';
import { logger } from '#lib/logging/index.js';
import { error } from '@sveltejs/kit';

interface NowNextEntry {
	now: unknown;
	next: unknown;
}

async function getLiveTvPageData() {
	const [lineup, categories] = await Promise.all([
		channelLineupService.getLineup(),
		channelCategoryService.getCategories()
	]);

	const lineupChannelIds = lineup.map((item) => item.channelId);
	const epgNowNext: Record<string, NowNextEntry> = {};

	if (lineup.length > 0) {
		const epgService = getEpgService();
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

	return {
		lineup,
		categories,
		lineupChannelIds,
		epgNowNext
	};
}

export const load: ServerLoad = async ({ request, locals }) => {
	// Require authentication
	if (!locals.user) {
		throw error(401, 'Unauthorized');
	}

	try {
		const [{ streamingApiKey }, liveTvData] = await Promise.all([
			getManagedApiKeysForRequest(request.headers),
			getLiveTvPageData()
		]);

		return {
			streamingApiKey: streamingApiKey?.key ?? null,
			...liveTvData
		};
	} catch (err) {
		logger.error(
			{ err, component: 'LiveTvChannelsPage', logDomain: 'livetv' },
			'Error loading streaming API key'
		);
		return {
			streamingApiKey: null,
			lineup: [],
			categories: [],
			lineupChannelIds: [],
			epgNowNext: {},
			error: 'Failed to load streaming API key'
		};
	}
};
