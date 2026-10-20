/**
 * Types for unified activity tracking
 * Consolidates download history and monitoring history into a single view
 */

import type { QueueQualityInfo } from './queue';

/**
 * Activity status values
 */
export type ActivityStatus =
	| 'imported' // Successfully imported to library
	| 'streaming' // Streaming source (no download)
	| 'downloading' // Currently downloading
	| 'importing' // Transfer finished; import/post-processing pipeline in progress
	| 'seeding' // Download complete, still seeding
	| 'paused' // Download paused
	| 'failed' // Download or import failed
	| 'search_error' // Automated search failed (indexer error, timeout, etc.)
	| 'rejected' // Release rejected (quality, blocklist, etc.)
	| 'removed' // Removed from queue
	| 'no_results' // Search found no results
	| 'searching'; // Search in progress

/**
 * Where an activity row originated from.
 *
 * 'client' is reserved for live download-client state with no queue row
 * (the Unmatched tab's rows). The feed does not produce it yet — the member
 * exists so the future unified table has an origin slot to branch on, and
 * every existing `===` check keeps compiling unchanged.
 *
 * Bridge contract toward unification (no runtime code yet): a unified
 * unmatched row would map releaseTitle=name, size, protocol='torrent',
 * downloadClientId/Name straight across; downloadProgress=progress*100;
 * timeline=[] (no events yet); media fields, queueItemId and historyId null until
 * linked; client 'error'→'failed'. Deliberately deferred: renaming the
 * unmatched API fields to match (filed contract churn for speculative
 * gain), toolbar-driven server filtering (these rows come from live client
 * polling, not the activity queries), and fabricating full UnifiedActivity
 * rows (would lie about mediaId/timeline). Remaining migration work, in
 * order: table row branch on source, toolbar scope option, feed scope.
 */
export type ActivitySource = 'queue' | 'download_history' | 'monitoring' | 'task' | 'client';

/**
 * Human-readable labels for monitoring task types.
 */
export const TASK_TYPE_LABELS: Record<string, string> = {
	missing: 'Missing Search',
	upgrade: 'Upgrade Search',
	cutoffUnmet: 'Cutoff Search',
	cutoff_unmet: 'Cutoff Search',
	missingSubtitles: 'Subtitle Search',
	subtitleUpgrade: 'Subtitle Upgrade',
	new_episode: 'New Episode Search',
	pendingRelease: 'Pending Release',
	smartListRefresh: 'Smart List Refresh',
	media_move: 'File Move'
};

/**
 * Activity view scope
 */
export type ActivityScope = 'all' | 'active' | 'history';

const ACTIVE_ACTIVITY_STATUSES: ActivityStatus[] = [
	'downloading',
	'importing',
	'seeding',
	'paused',
	'searching'
];

/**
 * Determine whether an activity should be treated as active in UI and API views.
 */
export function isActiveActivity(
	activity: Pick<UnifiedActivity, 'status' | 'queueItemId'>
): boolean {
	if (ACTIVE_ACTIVITY_STATUSES.includes(activity.status)) {
		return true;
	}

	return false;
}

/**
 * Error message patterns that positively identify import-phase failures.
 *
 * These come from ImportService.ts and DownloadMonitorService.markImporting()
 * — we control all of them so the list is exhaustive. Download-client errors
 * (e.g. "Download limit exceeded", "Unpacking failed") will never match,
 * which prevents misclassifying download failures that happen to have a
 * `completedAt` timestamp.
 */
export const IMPORT_ERROR_PATTERNS: readonly string[] = [
	'import', // "Import failed after N attempts", "Failed to import any episodes"
	'root folder', // "Root folder not found", "Cannot import to read-only root folder"
	'not found in library', // "Movie not found in library", "Series not found in library"
	'no video files', // "No video files found in download"
	'no importable files', // "No importable files found in download"
	'download path not available',
	'dangerous files', // "Caution: Found potentially dangerous files: …"
	'failed to transfer', // "Failed to transfer file: …"
	'no linked movie', // "No linked movie or series"
	'no linked series', // "No linked movie or series" (alternate wording)
	'removed from client' // "Download removed from client unexpectedly"
];

/**
 * Check whether a lowercase error reason matches a known import-phase pattern.
 */
export function matchesImportError(reason: string): boolean {
	return IMPORT_ERROR_PATTERNS.some((p) => reason.includes(p));
}

/**
 * Determine whether a failed activity represents an import-phase failure.
 * These failures should retry import instead of re-downloading when possible.
 *
 * Uses positive pattern matching against known ImportService error messages
 * rather than relying on `completedAt`, which can be set for download-phase
 * failures too (e.g. SABnzbd briefly reports "Completed" before post-processing
 * fails with "Download limit exceeded").
 */
export function isImportFailedActivity(
	activity: Pick<UnifiedActivity, 'status' | 'completedAt' | 'statusReason'>
): boolean {
	if (activity.status !== 'failed') return false;

	const reason = activity.statusReason?.toLowerCase() ?? '';
	return matchesImportError(reason);
}

/**
 * Activity event types for timeline
 */
export type ActivityEventType =
	| 'searched' // Search initiated
	| 'found' // Releases found
	| 'grabbed' // Release grabbed/sent to client
	| 'downloading' // Download started
	| 'completed' // Download completed
	| 'postprocessing' // Post-processing (usenet extraction)
	| 'importing' // Import started
	| 'imported' // Import completed
	| 'failed' // Operation failed
	| 'rejected' // Release rejected
	| 'removed' // Removed from queue
	| 'blocklisted'; // Release added to the blocklist

/**
 * Timeline event within an activity
 */
export interface ActivityEvent {
	type: ActivityEventType;
	timestamp: string;
	details?: string; // e.g., "15 releases found", "Import failed: corrupted"
}

/**
 * Unified activity item combining download and monitoring history
 */
export interface UnifiedActivity {
	id: string;

	// Activity origin
	activitySource: ActivitySource;
	taskType?: string; // monitoring task type (e.g., 'missing', 'upgrade')

	// Media info
	mediaType: 'movie' | 'episode';
	mediaId: string;
	mediaTitle: string;
	mediaYear: number | null;
	seriesId?: string; // for episodes
	seriesTitle?: string; // for episodes
	seasonNumber?: number;
	episodeNumber?: number;
	episodeIds?: string[]; // for multi-episode packs

	// Release info
	releaseTitle: string | null;
	quality: QueueQualityInfo | null;
	releaseGroup: string | null;
	size: number | null;

	// Source info
	indexerId: string | null;
	indexerName: string | null;
	protocol: 'torrent' | 'usenet' | 'streaming' | 'debrid' | null;
	downloadClientId?: string | null;
	downloadClientName?: string | null;

	// Status
	status: ActivityStatus;
	/** Raw queue lifecycle status retained for protocol-specific presentation. */
	queueStatus?: string;
	statusReason?: string;
	downloadProgress?: number; // 0-100 for in-progress

	// Upgrade info
	isUpgrade: boolean;
	oldScore?: number;
	newScore?: number;

	// Timeline events
	timeline: ActivityEvent[];

	// Timestamps
	startedAt: string;
	completedAt: string | null;
	lastAttemptAt?: string | null; // Updated on each retry attempt

	// Links
	queueItemId?: string; // Link to current queue item if downloading
	downloadHistoryId?: string; // Link to download history record
	/** Whether this release currently has an active blocklist entry. */
	isBlocklisted?: boolean;
	monitoringHistoryId?: string; // Link to monitoring history record
	importedPath?: string; // Path where file was imported
	/** How the file reached importedPath (hardlink/copy/move/symlink). */
	transferMode?: 'hardlink' | 'copy' | 'move' | 'symlink';
}

/**
 * Filter options for activity listing
 */
export interface ActivityFilters {
	status?: ActivityStatus | 'success' | 'all';
	mediaType?: 'movie' | 'tv' | 'all';
	search?: string;
	startDate?: string;
	endDate?: string;
	protocol?: 'torrent' | 'usenet' | 'streaming' | 'debrid' | 'all';
	indexer?: string;
	releaseGroup?: string;
	resolution?: string;
	isUpgrade?: boolean;
	downloadClientId?: string;
	includeNoResults?: boolean;
}

/**
 * Available filter options for dropdowns
 */
export interface FilterOptions {
	indexers: Array<{ id: string; name: string }>;
	downloadClients: Array<{ id: string; name: string }>;
	releaseGroups: string[];
	resolutions: string[];
}

/**
 * Sort options for activity listing
 */
export interface ActivitySortOptions {
	field: 'time' | 'media' | 'size' | 'status';
	direction: 'asc' | 'desc';
}

/**
 * Summary metadata returned alongside activity results.
 * Counts reflect the full filtered result universe, not just the current page.
 */
export interface ActivitySummary {
	totalCount: number;
	downloadingCount: number;
	importingCount: number;
	seedingCount: number;
	pausedCount: number;
	failedCount: number;
}

/**
 * SSE event types for activity updates
 */
export type ActivityEventStreamType =
	| 'activity:new' // New activity added
	| 'activity:updated' // Activity status changed
	| 'activity:progress'; // Download progress update

/**
 * SSE event payload for activity stream
 */
export interface ActivityStreamEvent {
	type: ActivityEventStreamType;
	data: UnifiedActivity | { id: string; progress: number };
	timestamp: string;
}

/**
 * Response from activity API
 */
export interface ActivityResponse {
	success: boolean;
	activities: UnifiedActivity[];
	total: number;
	hasMore: boolean;
	summary: ActivitySummary | null;
}
