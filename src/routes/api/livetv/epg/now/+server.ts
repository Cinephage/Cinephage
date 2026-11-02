/**
 * EPG Now/Next API
 *
 * GET /api/livetv/epg/now - Get current and next program for all lineup channels
 *
 * Supports EPG source overrides - when a channel has epgSourceChannelId set,
 * EPG data is fetched from that channel instead of the primary channel.
 */

import type { RequestHandler } from './$types';
import { getEpgService } from '#lib/server/livetv/epg/index.js';
import { channelLineupService } from '#lib/server/livetv/lineup/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { EpgProgram, EpgProgramWithProgress } from '#lib/types/livetv.js';

const logger = createChildLogger({ module: 'LiveTvEpgNow', logDomain: 'livetv' });

interface NowNextEntry {
	now: EpgProgramWithProgress | null;
	next: EpgProgram | null;
}

export const GET: RequestHandler = async () => {
	try {
		const epgService = getEpgService();

		// Get full lineup to access EPG source overrides
		const lineup = await channelLineupService.getLineup();

		if (lineup.length === 0) {
			return Response.json({
				success: true,
				channels: {}
			});
		}

		// Build mapping: original channel ID -> EPG source channel ID
		// If epgSourceChannelId is set, use that; otherwise use the primary channelId
		const epgSourceMap = new Map<string, string>();
		for (const item of lineup) {
			const epgChannelId = item.epgSourceChannelId ?? item.channelId;
			epgSourceMap.set(item.channelId, epgChannelId);
		}

		// Get unique EPG source channel IDs
		const epgSourceIds = [...new Set(epgSourceMap.values())];

		// Get now/next for all EPG source channels
		const nowNextMap = epgService.getNowAndNext(epgSourceIds);

		// Map results back to original channel IDs
		const channels: Record<string, NowNextEntry> = {};

		for (const item of lineup) {
			const epgChannelId = epgSourceMap.get(item.channelId)!;
			const epgData = nowNextMap.get(epgChannelId);

			channels[item.channelId] = {
				now: epgData?.now ?? null,
				next: epgData?.next ?? null
			};
		}

		return Response.json({
			success: true,
			channels
		});
	} catch (error) {
		logger.error('[API] Failed to get EPG now/next', error instanceof Error ? error : undefined);
		return Response.json(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Failed to get EPG data'
			},
			{ status: 500 }
		);
	}
};
