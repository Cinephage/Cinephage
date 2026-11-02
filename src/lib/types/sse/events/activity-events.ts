/**
 * Activity SSE Event Types
 *
 * Shared types for the /api/activity/stream endpoint
 */

import type { UnifiedActivity } from '#lib/types/activity.js';

/**
 * activity:new event - New activity item
 */
export type ActivityNewEvent = UnifiedActivity;

/**
 * activity:updated event - Activity item updated
 */
export type ActivityUpdatedEvent = UnifiedActivity;

/**
 * activity:seed event - Batch of active downloads sent on initial SSE connection
 */
export type ActivitySeedEvent = UnifiedActivity[];

/**
 * activity:progress event - Progress update
 */
export interface ActivityProgressEvent {
	id: string;
	progress: number;
	status: string;
}

/**
 * activity:refresh event - Trigger clients to reload activity list after bulk mutations
 */
export interface ActivityRefreshEvent {
	action: 'purge_all' | 'purge_older_than_retention' | 'delete_selected' | 'media_move';
	timestamp: string;
}

/**
 * All events for the activity stream endpoint
 */
export interface ActivityStreamEvents {
	'activity:new': ActivityNewEvent;
	'activity:updated': ActivityUpdatedEvent;
	'activity:seed': ActivitySeedEvent;
	'activity:progress': ActivityProgressEvent;
	'activity:refresh': ActivityRefreshEvent;
}
