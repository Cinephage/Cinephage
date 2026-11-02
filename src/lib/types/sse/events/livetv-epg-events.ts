/**
 * LiveTV EPG SSE Event Types
 *
 * Shared types for the /api/livetv/epg/stream endpoint
 */

import type { ChannelLineupItemWithDetails, EpgStatus } from '#lib/types/livetv.js';

/**
 * epg:initial event - Full initial state
 */
export interface EpgInitialEvent {
	status: EpgStatus;
	lineup: ChannelLineupItemWithDetails[];
}

/**
 * epg:syncStarted event
 */
export interface EpgSyncStartedEvent {
	accountId?: string;
	status: EpgStatus;
}

/**
 * epg:syncCompleted event
 */
export interface EpgSyncCompletedEvent {
	accountId?: string;
	status: EpgStatus;
	lineup: ChannelLineupItemWithDetails[];
}

/**
 * epg:syncFailed event
 */
export interface EpgSyncFailedEvent {
	accountId?: string;
	status: EpgStatus;
	error: string;
}

/**
 * lineup:updated event
 */
export interface LineupUpdatedEvent {
	lineup: ChannelLineupItemWithDetails[];
}

/**
 * All events for the EPG stream endpoint
 */
export interface EpgStreamEvents {
	'epg:initial': EpgInitialEvent;
	'epg:syncStarted': EpgSyncStartedEvent;
	'epg:syncCompleted': EpgSyncCompletedEvent;
	'epg:syncFailed': EpgSyncFailedEvent;
	'lineup:updated': LineupUpdatedEvent;
}
