/**
 * Types for download queue and history management
 */

/**
 * Download queue status values
 */
export type QueueStatus =
	| 'queued' // Added to queue, waiting to start
	| 'downloading' // Actively downloading
	| 'stalled' // Download stalled (no seeders/peers available)
	| 'awaiting' // Download vanished from client, auto-retrying in poll loop
	| 'paused' // Download paused
	| 'completed' // Download finished, waiting for import
	| 'postprocessing' // Download finished, post-processing in progress (usenet extraction/repair)
	| 'importing' // Import in progress
	| 'imported' // Successfully imported to library
	| 'failed' // Failed (download or import)
	| 'seeding' // Download complete, still seeding (pre-import)
	| 'seeding-imported' // Imported to library, torrent still seeding
	| 'removed'; // Removed from queue

export const POST_IMPORT_QUEUE_STATUSES = [
	'imported',
	'seeding-imported'
] as const satisfies readonly QueueStatus[];

export const TERMINAL_QUEUE_STATUSES = ['removed'] as const satisfies readonly QueueStatus[];

export const ACTIVE_DOWNLOAD_STATUSES = [
	'queued',
	'downloading',
	'stalled',
	'awaiting',
	'paused',
	'completed',
	'postprocessing',
	'importing',
	'seeding',
	'seeding-imported'
] as const satisfies readonly QueueStatus[];

export function isImportedQueueStatus(
	status: QueueStatus | string | null | undefined
): status is (typeof POST_IMPORT_QUEUE_STATUSES)[number] {
	return status === 'imported' || status === 'seeding-imported';
}

/**
 * Download history status values
 */
export type HistoryStatus = 'imported' | 'streaming' | 'failed' | 'rejected' | 'removed';

/**
 * Quality information parsed from release name
 */
export interface QueueQualityInfo {
	resolution?: string;
	source?: string;
	codec?: string;
	hdr?: string;
	/** Language evidence parsed from the release name (incl. 'multi'/'orig'
	 * pseudo-codes). Grab-history persistence for the audio-language policy. */
	languages?: string[];
	/** Language evidence parsed from the torrent's FILE names (debrid instant
	 * availability or .torrent metadata) - tier 3, stronger than the title. */
	fileLanguages?: string[];
}

/**
 * Download queue item from database
 */
export interface QueueItem {
	id: string;
	downloadClientId: string;
	downloadId: string;
	infoHash?: string | null;
	title: string;
	indexerId?: string | null;
	indexerName?: string | null;
	downloadUrl?: string | null;
	magnetUrl?: string | null;
	protocol: string;

	// Linked media
	movieId?: string | null;
	seriesId?: string | null;
	episodeIds?: string[] | null;
	seasonNumber?: number | null;

	// Status
	status: QueueStatus;
	progress: number; // 0.0 - 1.0
	size?: number | null;
	downloadSpeed: number;
	uploadSpeed: number;
	eta?: number | null;
	ratio: number;

	// Paths
	clientDownloadPath?: string | null;
	outputPath?: string | null;
	importedPath?: string | null;

	// Quality
	quality?: QueueQualityInfo | null;

	// Release group
	releaseGroup?: string | null;

	// Timestamps
	addedAt: string;
	startedAt?: string | null;
	completedAt?: string | null;
	importedAt?: string | null;

	// Error tracking
	errorMessage?: string | null;
	importAttempts: number;
	lastAttemptAt?: string | null;

	// Flags
	isAutomatic: boolean;
	isUpgrade: boolean;
}

/**
 * Extended queue item with related media info for UI display
 */
export interface QueueItemWithMedia extends QueueItem {
	// Resolved media info
	movie?: {
		id: string;
		tmdbId: number;
		title: string;
		year?: number | null;
		posterPath?: string | null;
	} | null;
	series?: {
		id: string;
		tmdbId: number;
		title: string;
		year?: number | null;
		posterPath?: string | null;
	} | null;
	// Download client info
	downloadClient?: {
		id: string;
		name: string;
		implementation: string;
	} | null;
}

/**
 * Download history item from database
 */
export interface HistoryItem {
	id: string;
	downloadClientId?: string | null;
	downloadClientName?: string | null;
	downloadId?: string | null;
	title: string;
	indexerId?: string | null;
	indexerName?: string | null;
	protocol?: string | null;

	// Linked media
	movieId?: string | null;
	seriesId?: string | null;
	episodeIds?: string[] | null;
	seasonNumber?: number | null;

	// Status
	status: HistoryStatus;
	statusReason?: string | null;

	// Stats
	size?: number | null;
	downloadTimeSeconds?: number | null;
	finalRatio?: string | null;

	// Quality
	quality?: QueueQualityInfo | null;

	// Release group
	releaseGroup?: string | null;

	// Paths
	importedPath?: string | null;

	// Created files
	movieFileId?: string | null;
	episodeFileIds?: string[] | null;

	// Timestamps
	grabbedAt?: string | null;
	completedAt?: string | null;
	importedAt?: string | null;
	createdAt: string;
}

/**
 * Extended history item with related media info for UI display
 */
export interface HistoryItemWithMedia extends HistoryItem {
	movie?: {
		id: string;
		tmdbId: number;
		title: string;
		year?: number | null;
		posterPath?: string | null;
	} | null;
	series?: {
		id: string;
		tmdbId: number;
		title: string;
		year?: number | null;
		posterPath?: string | null;
	} | null;
}

/**
 * Request payload for grabbing a release
 */
export interface GrabRequest {
	// Release info
	guid?: string;
	downloadUrl?: string;
	magnetUrl?: string;
	infoHash?: string;
	title: string;
	indexerId?: string;
	indexerName?: string;
	/** Protocol: 'torrent' | 'usenet' | 'streaming' */
	protocol?: string;
	/** Release categories from indexer (for content type validation) */
	categories?: number[];
	/** Release size in bytes */
	size?: number;
	/** URL to the release details/comments page (needed by some indexers for download resolution) */
	commentsUrl?: string;

	// Target media (at least one required)
	movieId?: string;
	seriesId?: string;
	episodeIds?: string[];
	seasonNumber?: number;

	// Media type for category selection
	mediaType: 'movie' | 'tv';

	// Quality info (parsed from release)
	quality?: QueueQualityInfo;

	// Flags
	isAutomatic?: boolean;
	isUpgrade?: boolean;
	/** Force grab even if not an upgrade (bypasses upgrade validation) */
	force?: boolean;
	/** Stream NZB directly instead of downloading */
	streamUsenet?: boolean;
}

/**
 * Response from grab endpoint
 */
export interface GrabResponse {
	success: boolean;
	data?: {
		queueId: string;
		hash: string;
		clientId: string;
		clientName: string;
		category: string;
		wasDuplicate?: boolean;
		isUpgrade?: boolean;
		/** Mount ID for NZB streaming */
		mountId?: string;
		/** Streamability info for NZB content */
		streamability?: {
			canStream: boolean;
			archiveType?: 'rar' | '7z' | 'zip' | 'none';
			error?: string;
		};
	};
	error?: string;
	/** Machine-readable error code for UI handling */
	errorCode?: string;
	/** Machine-readable rejection type for UI handling */
	rejectionType?: string;
	/** Full pipeline decision with audit trail */
	decision?: {
		accepted: boolean;
		reason: string;
		rejectionType?: string;
		upgradeStatus: 'new' | 'upgrade' | 'sidegrade' | 'downgrade' | 'blocked' | 'rejected';
		scores: { candidate: number; existing?: number; improvement?: number };
		upgradeStats?: {
			improved: number;
			unchanged: number;
			downgraded: number;
			newEpisodes: number;
		};
		audit: {
			stages: Array<{
				name: string;
				skipped: boolean;
				result?: { accepted: boolean; reason?: string; details?: Record<string, unknown> };
				durationMs: number;
			}>;
			finalResult: { accepted: boolean; reason?: string; details?: Record<string, unknown> };
			totalDurationMs: number;
		};
	};
}

/**
 * Queue summary statistics
 */
export interface QueueStats {
	totalCount: number;
	queuedCount: number;
	downloadingCount: number;
	stalledCount: number;
	awaitingCount: number;
	seedingCount: number;
	pausedCount: number;
	completedCount: number;
	postprocessingCount: number;
	importingCount: number;
	failedCount: number;
	totalSizeBytes: number;
	totalDownloadSpeed: number;
	totalUploadSpeed: number;
}

/**
 * SSE event types for queue updates
 */
export type QueueEventType =
	| 'queue:added'
	| 'queue:updated'
	| 'queue:removed'
	| 'queue:completed'
	| 'queue:imported'
	| 'queue:failed'
	| 'queue:stats';

/**
 * SSE event payload
 */
export interface QueueEvent {
	type: QueueEventType;
	data: QueueItem | QueueStats | { id: string };
	timestamp: string;
}

/**
 * Filter options for queue listing
 */
export interface QueueFilters {
	status?: QueueStatus | 'all';
	mediaType?: 'movie' | 'tv' | 'all';
	downloadClientId?: string;
}

/**
 * Filter options for history listing
 */
export interface HistoryFilters {
	status?: HistoryStatus | 'all';
	mediaType?: 'movie' | 'tv' | 'all';
	movieId?: string;
	seriesId?: string;
	startDate?: string;
	endDate?: string;
}

/**
 * Pagination options
 */
export interface PaginationOptions {
	page?: number;
	limit?: number;
}

/**
 * Paginated response
 */
export interface PaginatedResponse<T> {
	items: T[];
	total: number;
	page: number;
	limit: number;
	totalPages: number;
}
