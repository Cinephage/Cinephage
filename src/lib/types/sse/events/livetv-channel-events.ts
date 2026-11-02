/**
 * LiveTV Channels SSE Event Types
 *
 * Shared types for the /api/livetv/channels/stream endpoint
 */

import type {
	ChannelLineupItemWithDetails,
	ChannelCategory,
	EpgProgram,
	EpgProgramWithProgress
} from '#lib/types/livetv.js';

/**
 * EPG Now/Next entry for a channel
 */
export interface NowNextEntry {
	now: EpgProgramWithProgress | null;
	next: EpgProgram | null;
}

/**
 * livetv:sync event - Full state snapshot used to resync the page
 */
export interface LivetvInitialEvent {
	lineup: ChannelLineupItemWithDetails[];
	categories: ChannelCategory[];
	lineupChannelIds: string[];
	epgNowNext: Record<string, NowNextEntry>;
}

/**
 * lineup:updated event - Lineup changed
 */
export interface LineupUpdatedEvent {
	lineup: ChannelLineupItemWithDetails[];
	lineupChannelIds: string[];
}

/**
 * categories:updated event - Categories changed
 */
export interface CategoriesUpdatedEvent {
	categories: ChannelCategory[];
}

/**
 * epg:nowNext event - Periodic EPG now/next updates
 */
export interface EpgNowNextEvent {
	channels: Record<string, NowNextEntry>;
}

/**
 * channels:syncStarted event
 */
export interface ChannelsSyncStartedEvent {
	accountId: string;
}

/**
 * channels:syncCompleted event
 */
export interface ChannelsSyncCompletedEvent {
	accountId: string;
	result: {
		lineupCount?: number;
		newChannels?: number;
		removedChannels?: number;
	};
}

/**
 * channels:syncFailed event
 */
export interface ChannelsSyncFailedEvent {
	accountId: string;
	error: string;
}

/**
 * All events for the channels stream endpoint
 */
export interface ChannelStreamEvents {
	'livetv:sync': LivetvInitialEvent;
	'lineup:updated': LineupUpdatedEvent;
	'categories:updated': CategoriesUpdatedEvent;
	'epg:nowNext': EpgNowNextEvent;
	'channels:syncStarted': ChannelsSyncStartedEvent;
	'channels:syncCompleted': ChannelsSyncCompletedEvent;
	'channels:syncFailed': ChannelsSyncFailedEvent;
}
