/**
 * LiveTV Accounts SSE Event Types
 *
 * Shared types for the /api/livetv/accounts/stream endpoint
 */

import type { LiveTvAccount } from '#lib/types/livetv.js';

/**
 * accounts:initial event - Full accounts list
 */
export interface AccountsInitialEvent {
	accounts: LiveTvAccount[];
}

/**
 * account:created event - New account added
 */
export interface AccountCreatedEvent {
	accounts: LiveTvAccount[];
}

/**
 * account:updated event - Account updated
 */
export interface AccountUpdatedEvent {
	accounts: LiveTvAccount[];
}

/**
 * account:deleted event - Account removed
 */
export interface AccountDeletedEvent {
	accounts: LiveTvAccount[];
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
 * All events for the accounts stream endpoint
 */
export interface AccountStreamEvents {
	'accounts:initial': AccountsInitialEvent;
	'account:created': AccountCreatedEvent;
	'account:updated': AccountUpdatedEvent;
	'account:deleted': AccountDeletedEvent;
	'channels:syncStarted': ChannelsSyncStartedEvent;
	'channels:syncCompleted': ChannelsSyncCompletedEvent;
	'channels:syncFailed': ChannelsSyncFailedEvent;
}
