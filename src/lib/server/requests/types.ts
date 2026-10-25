/** Request lifecycle states (see the design spec §2). */
export type RequestStatus =
	| 'pending'
	| 'approved'
	| 'awaiting_target'
	| 'failed'
	| 'declined'
	| 'expired'
	| 'cancelled'
	| 'fulfilled';

/** Statuses that block a new duplicate request for the same media. */
export const ACTIVE_REQUEST_STATUSES: readonly RequestStatus[] = [
	'pending',
	'approved',
	'awaiting_target',
	'failed'
] as const;

/** Decided statuses: the row may be removed outright (DELETE verb). */
export const TERMINAL_REQUEST_STATUSES: readonly RequestStatus[] = [
	'declined',
	'expired',
	'cancelled',
	'fulfilled',
	// Failed rows keep their Retry action while they exist, but the owner
	// (or an admin) may also remove them outright — e.g. requests failed by
	// media deletion, where the requester re-requests instead of retrying.
	'failed'
] as const;

/** Statuses that do NOT consume quota (everything else counts). */
export const QUOTA_EXCLUDED_STATUSES: readonly RequestStatus[] = [
	'declined',
	'expired',
	'cancelled'
] as const;

export type RequestMediaType = 'movie' | 'series';

export interface RequestEpisodeEntry {
	seasonNumber: number;
	episodeNumber: number;
}

/** Machine-readable failure codes surfaced to the UI with context. */
export type RequestErrorCode =
	| 'requests_disabled'
	| 'requesting_disabled'
	| 'banned'
	| 'blocked_media'
	| 'already_available'
	| 'already_in_library'
	| 'duplicate_request'
	| 'cooldown'
	| 'movie_quota'
	| 'tv_quota'
	| 'invalid_scope'
	| 'not_found'
	| 'invalid_status'
	| 'reason_required'
	| 'add_failed';

export class RequestError extends Error {
	constructor(
		public readonly code: RequestErrorCode,
		message: string,
		public readonly statusCode: number,
		public readonly context?: Record<string, unknown>
	) {
		super(message);
		this.name = 'RequestError';
	}
}

export interface RequestScope {
	/** Whole-season entries (series only). */
	seasons: number[];
	/** Episode-scope entries (series only). */
	episodes: RequestEpisodeEntry[];
}

export interface QuotaStatus {
	days: number | null;
	limit: number | null;
	used: number;
	remaining: number | null;
	restricted: boolean;
}

export interface RequesterContext {
	id: string;
	role: 'admin' | 'user';
	/** Admin id when the action runs under impersonation. */
	actingUserId?: string | null;
	/**
	 * Re-checked at create: the hooks gate routes banned sessions through
	 * the viewer allowlist, which permits request creation — the service
	 * must fail closed on its own.
	 */
	banned?: boolean;
}
