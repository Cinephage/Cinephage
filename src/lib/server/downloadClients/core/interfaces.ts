/**
 * Common interfaces for download clients.
 * Allows adding different client implementations (Transmission, Deluge, etc.)
 */

import type { ConnectionTestResult } from '#lib/types/downloadClient.js';
export type { ConnectionTestResult };

/**
 * Configuration for connecting to a download client.
 */
export interface DownloadClientConfig {
	host: string;
	port: number;
	useSsl: boolean;
	/** Optional URL base path (e.g., "/sabnzbd") */
	urlBase?: string | null;
	/** Optional mount mode for SAB-compatible streaming clients */
	mountMode?: 'nzbdav' | 'altmount' | null;
	username?: string | null;
	password?: string | null;
	/** Client implementation type (e.g., 'qbittorrent', 'sabnzbd') */
	implementation?: string;
	/** API key for clients that use key-based auth (e.g., SABnzbd) */
	apiKey?: string | null;
	/** Decrypted API token for debrid connection tests. */
	apiToken?: string | null;
	/** Local/remote path mapping for completed downloads. */
	downloadPathLocal?: string | null;
	downloadPathRemote?: string | null;
	tempPathLocal?: string | null;
	tempPathRemote?: string | null;
	/** qBittorrent only: enable sequential downloading when adding a torrent. */
	sequentialDownload?: boolean;
	/**
	 * rTorrent only: client-level seed goals, parsed from the client row and
	 * evaluated app-side (rTorrent has no per-torrent stop-at-ratio command).
	 */
	seedRatioLimit?: number;
	/** rTorrent only: seed time goal in minutes. */
	seedTimeLimit?: number;
}

/**
 * Options for adding a download to a client.
 */
export interface AddDownloadOptions {
	magnetUri?: string;
	torrentFile?: Buffer;
	/** NZB file content for usenet downloads */
	nzbFile?: Buffer;
	downloadUrl?: string;
	infoHash?: string;
	category: string;
	savePath?: string;
	paused?: boolean;
	priority?: 'normal' | 'high' | 'force';
	seedRatioLimit?: number;
	seedTimeLimit?: number;
	/** Title for the download (used by SABnzbd for naming) */
	title?: string;
	/**
	 * Optional file-selection instructions for torrent clients.
	 * Used by episode pointers to fetch only matched files from a pack.
	 */
	fileSelection?: {
		/** Torrent file indexes to keep (all others may be marked unwanted) */
		fileIndices: number[];
		/** Complete torrent file index set for clients that need explicit unwanted lists */
		allFileIndices?: number[];
		/** Relative torrent paths to keep (preferred when client supports path matching) */
		filePaths?: string[];
	};
}

/**
 * Information about a download in progress or completed.
 */
export interface DownloadInfo {
	id: string;
	name: string;
	hash: string;
	progress: number;
	status:
		| 'downloading'
		| 'stalled'
		| 'seeding'
		| 'paused'
		| 'completed'
		| 'postprocessing'
		| 'error'
		| 'queued';
	size: number;
	downloadSpeed: number;
	uploadSpeed: number;
	eta?: number;
	savePath: string;
	/** Full path to the torrent content (folder or file) - use this for imports */
	contentPath: string;
	category?: string;
	ratio?: number;
	addedOn?: Date;
	completedOn?: Date;
	/** Time spent seeding in seconds */
	seedingTime?: number;
	/** Per-torrent ratio limit (-2 = global, -1 = unlimited, >0 = limit) */
	ratioLimit?: number;
	/** Per-torrent seeding time limit in minutes (-2 = global, -1 = unlimited, >0 = limit) */
	seedingTimeLimit?: number;

	/**
	 * Whether files can be moved from the download location.
	 * False for seeding torrents (must use hardlink/copy to preserve source).
	 * True for usenet downloads or completed torrents that aren't seeding.
	 * Follows Radarr's DownloadClientItem.CanMoveFiles pattern.
	 */
	canMoveFiles: boolean;

	/**
	 * Whether the download can be removed from the client.
	 * True when: (usenet AND completed) OR (torrent paused after meeting seed limits)
	 * Follows Radarr's DownloadClientItem.CanBeRemoved pattern.
	 */
	canBeRemoved: boolean;

	/** Whether the download has been removed from the client */
	removed?: boolean;

	/** Error message from download client when status is 'error' */
	errorMessage?: string;
}

export interface DownloadFileInfo {
	index: number;
	name: string;
	size: number;
}

/**
 * NNTP server configuration fetched from download clients.
 * Used for NZB streaming to connect directly to Usenet servers.
 */
export interface NntpServerConfig {
	name: string;
	host: string;
	port: number;
	useSsl: boolean;
	username?: string;
	/** Password - may be empty for SABnzbd (user must enter manually) */
	password?: string;
	/** Maximum simultaneous connections */
	maxConnections: number;
	/** Server priority (lower = try first) */
	priority: number;
	/** Whether this server is enabled in the download client */
	enabled: boolean;
}

/**
 * Interface that all download client implementations must implement.
 */
export interface IDownloadClient {
	readonly implementation: string;

	/**
	 * Test connectivity and authentication.
	 */
	test(): Promise<ConnectionTestResult>;

	/**
	 * Add a download (torrent or NZB).
	 * Returns the download ID/hash.
	 */
	addDownload(options: AddDownloadOptions): Promise<string>;

	/**
	 * Get all downloads, optionally filtered by category.
	 */
	getDownloads(category?: string): Promise<DownloadInfo[]>;

	/**
	 * Get a single download by ID/hash.
	 */
	getDownload(id: string): Promise<DownloadInfo | null>;

	/**
	 * Remove a download.
	 */
	removeDownload(id: string, deleteFiles?: boolean): Promise<void>;

	/**
	 * Pause a download.
	 */
	pauseDownload(id: string): Promise<void>;

	/**
	 * Resume a download.
	 */
	resumeDownload(id: string): Promise<void>;

	/**
	 * Get the default save path from client preferences.
	 */
	getDefaultSavePath(): Promise<string>;

	/**
	 * Get available categories.
	 */
	getCategories(): Promise<string[]>;

	/**
	 * Create a category if it doesn't exist.
	 */
	ensureCategory(name: string, savePath?: string): Promise<void>;

	/**
	 * Retry a failed download.
	 * Optional - only implemented by clients that support retry (SABnzbd, NZBGet).
	 * Returns the new download ID if retry creates a new entry.
	 */
	retryDownload?(id: string): Promise<string | undefined>;

	/**
	 * Get configured NNTP servers from the download client.
	 * Optional - only implemented by Usenet clients (SABnzbd, NZBGet).
	 * Used for NZB streaming to fetch server credentials.
	 */
	getNntpServers?(): Promise<NntpServerConfig[]>;

	/**
	 * Get the base download path from client configuration.
	 * Used for path mapping when the client runs on a different machine.
	 * Optional - returns undefined if not available.
	 */
	getBasePath?(): Promise<string | undefined>;

	/**
	 * Mark a download as imported (e.g., move to post-import category).
	 * Optional - only implemented by clients that support post-import categories.
	 * Follows Radarr's DownloadClient.MarkItemAsImported pattern.
	 *
	 * @param id - Download ID/hash
	 * @param importedCategory - Optional category to move the download to
	 */
	markItemAsImported?(id: string, importedCategory?: string): Promise<void>;

	/**
	 * Set seeding configuration for a download.
	 * Optional - only implemented by torrent clients.
	 *
	 * @param id - Download ID/hash
	 * @param config - Seed ratio and time limits
	 */
	setSeedingConfig?(
		id: string,
		config: { ratioLimit?: number; seedingTimeLimit?: number }
	): Promise<void>;

	/**
	 * Get the list of files in a download.
	 * Optional - only implemented by torrent clients that expose file metadata.
	 *
	 * @param id - Download ID/hash
	 */
	getFiles?(id: string): Promise<DownloadFileInfo[]>;

	/**
	 * Exclude specific files (by index) from a download so they are never
	 * downloaded to disk. Optional - only implemented by clients that support
	 * per-file priority. Used to strip bundled dangerous files (e.g. executables)
	 * from a release without discarding the whole download.
	 *
	 * @param id - Download ID/hash
	 * @param indices - File indices to exclude
	 */
	excludeFiles?(id: string, indices: number[]): Promise<void>;
}
