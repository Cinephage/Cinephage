/**
 * Worker System Types
 * Defines the core types for the task worker infrastructure.
 */

import type { LogDomain } from '#lib/logging/index.js';

/**
 * Types of workers supported by the system.
 */
export type WorkerType =
	'stream' | 'import' | 'scan' | 'monitoring' | 'search' | 'portal-scan' | 'channel-sync';

/**
 * Worker lifecycle status.
 */
export type WorkerStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * A single log entry from a worker.
 */
export interface WorkerLogEntry {
	timestamp: Date;
	level: 'debug' | 'info' | 'warn' | 'error';
	message: string;
	data?: Record<string, unknown>;
}

/**
 * Base worker state exposed via API.
 */
export interface WorkerState {
	id: string;
	type: WorkerType;
	status: WorkerStatus;
	progress: number;
	createdAt: Date;
	startedAt?: Date;
	completedAt?: Date;
	error?: string;
	metadata: Record<string, unknown>;
}

/**
 * Configuration for the worker manager.
 */
export interface WorkerManagerConfig {
	/**
	 * Maximum concurrent workers per type.
	 * Set to 0 for unlimited.
	 */
	maxConcurrent: Record<WorkerType, number>;

	/**
	 * How long to keep completed workers before auto-cleanup (ms).
	 * Set to 0 to never auto-cleanup.
	 */
	cleanupAfterMs: number;

	/**
	 * Maximum log entries to keep in memory per worker.
	 */
	maxLogsPerWorker: number;
}

/**
 * Default worker configuration.
 */
export const DEFAULT_WORKER_CONFIG: WorkerManagerConfig = {
	maxConcurrent: {
		stream: parseInt(process.env.WORKER_MAX_STREAMS || '10', 10) || 10,
		import: parseInt(process.env.WORKER_MAX_IMPORTS || '5', 10) || 5,
		scan: parseInt(process.env.WORKER_MAX_SCANS || '2', 10) || 2,
		monitoring: parseInt(process.env.WORKER_MAX_MONITORING || '5', 10) || 5,
		search: parseInt(process.env.WORKER_MAX_SEARCH || '3', 10) || 3,
		'portal-scan': parseInt(process.env.WORKER_MAX_PORTAL_SCANS || '2', 10) || 2,
		'channel-sync': parseInt(process.env.WORKER_MAX_CHANNEL_SYNCS || '3', 10) || 3
	},
	cleanupAfterMs: parseInt(process.env.WORKER_CLEANUP_MS || '1800000', 10) || 1800000, // 30 minutes
	maxLogsPerWorker: parseInt(process.env.WORKER_MAX_LOGS || '1000', 10) || 1000
};

/**
 * Events emitted by the worker manager.
 */
export type WorkerEvent =
	| { type: 'spawned'; workerId: string; workerType: WorkerType }
	| { type: 'started'; workerId: string }
	| { type: 'progress'; workerId: string; progress: number }
	| { type: 'log'; workerId: string; entry: WorkerLogEntry }
	| { type: 'completed'; workerId: string }
	| { type: 'failed'; workerId: string; error: string }
	| { type: 'cancelled'; workerId: string }
	| { type: 'removed'; workerId: string };

/**
 * Map worker type to log domain.
 */
export function workerTypeToLogCategory(type: WorkerType): LogDomain {
	switch (type) {
		case 'stream':
			return 'streams';
		case 'import':
			return 'imports';
		case 'scan':
			return 'scans';
		case 'monitoring':
			return 'monitoring';
		case 'search':
			return 'indexers';
		case 'portal-scan':
			return 'scans';
		case 'channel-sync':
			return 'livetv';
		default:
			return 'main';
	}
}

/**
 * Stream worker specific metadata.
 */
export interface StreamWorkerMetadata {
	mediaType: 'movie' | 'tv';
	tmdbId: number;
	season?: number;
	episode?: number;
	provider?: string;
	quality?: string;
	bytesProxied: number;
	segmentCount: number;
	sessionId?: string;
	[key: string]: unknown;
}

/**
 * Import worker specific metadata.
 */
export interface ImportWorkerMetadata {
	queueItemId: string;
	mediaType: 'movie' | 'episode';
	title: string;
	sourcePath?: string;
	destinationPath?: string;
	filesProcessed: number;
	totalFiles: number;
	[key: string]: unknown;
}

/**
 * Scan worker specific metadata.
 */
export interface ScanWorkerMetadata {
	folderPath: string;
	filesScanned: number;
	newItems: number;
	updatedItems: number;
	[key: string]: unknown;
}

/**
 * Monitoring worker specific metadata.
 */
export interface MonitoringWorkerMetadata {
	taskType: 'missing' | 'upgrade' | 'newEpisode' | 'cutoffUnmet' | 'pendingRelease';
	itemsProcessed: number;
	itemsFound: number;
	downloadsTriggered: number;
	[key: string]: unknown;
}

/**
 * Search worker specific metadata.
 */
export interface SearchWorkerMetadata {
	mediaType: 'movie' | 'series';
	mediaId: string;
	title: string;
	tmdbId: number;
	itemsSearched: number;
	itemsFound: number;
	itemsGrabbed: number;
	[key: string]: unknown;
}

/**
 * Portal scan worker specific metadata.
 */
export interface PortalScanWorkerMetadata {
	portalId: string;
	portalName: string;
	portalUrl: string;
	scanType: 'random' | 'sequential' | 'import';
	macPrefix?: string;
	macRangeStart?: string;
	macRangeEnd?: string;
	totalMacs: number;
	testedMacs: number;
	foundMacs: number;
	currentMac?: string;
	rateLimit: number;
	historyId?: string;
	[key: string]: unknown;
}

/**
 * Channel sync worker specific metadata.
 */
export interface ChannelSyncWorkerMetadata {
	accountId: string;
	accountName: string;
	providerType: string;
	channelsSynced: number;
	channelsAdded: number;
	channelsUpdated: number;
	channelsRemoved: number;
	categoriesSynced: number;
	error?: string;
	[key: string]: unknown;
}
