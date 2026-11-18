/**
 * Types for download client and root folder management UI
 */

export type DownloadClientImplementation =
	| 'qbittorrent'
	| 'transmission'
	| 'deluge'
	| 'rtorrent'
	| 'aria2'
	| 'sabnzbd'
	| 'nzbget'
	| 'nntp'
	| 'realdebrid'
	| 'torbox';
export type DownloadClientHealth = 'healthy' | 'warning' | 'failing';
export type DownloadPriority = 'normal' | 'high' | 'force';
export type DownloadInitialState = 'start' | 'pause' | 'force';
export type RootFolderMediaType = 'movie' | 'tv' | 'music';
export type RootFolderMediaSubType = 'standard' | 'anime';
export type DownloadClientMountMode = 'nzbdav' | 'altmount';

/**
 * Download client definition - metadata about each client type
 */
export interface DownloadClientDefinition {
	id: DownloadClientImplementation;
	name: string;
	description: string;
	defaultPort: number;
	protocol: 'torrent' | 'usenet' | 'nntp' | 'debrid';
	supportsCategories: boolean;
	supportsPriority: boolean;
	supportsSeedingLimits: boolean;
	/** True when the implementation is a debrid provider that uses an API token instead of host/port. */
	isDebrid?: boolean;
}

/**
 * Download client configuration from database
 */
export interface DownloadClient {
	id: string;
	name: string;
	implementation: DownloadClientImplementation;
	enabled: boolean;

	// Connection
	host: string;
	port: number;
	useSsl: boolean;
	urlBase?: string | null;
	mountMode?: DownloadClientMountMode | null;
	username?: string | null;
	// Note: password not returned to frontend for security
	hasPassword: boolean;

	// Debrid provider settings
	// Note: apiToken not returned to frontend for security
	hasApiToken: boolean;
	removeAfterImport: boolean;
	/** Content-type restriction: which media types this debrid client may be selected for. */
	allowMovies: boolean;
	allowTv: boolean;

	// Categories
	movieCategory: string;
	tvCategory: string;
	/**
	 * Per-kind categories, e.g. { movie: "Movies", tv: "TV", music: "Music" }.
	 * Video keeps using the two columns above; kinds added later read this map so
	 * a new kind is not another column on every client.
	 */
	categoryMap?: Record<string, string> | null;

	// Priority
	recentPriority: DownloadPriority;
	olderPriority: DownloadPriority;
	initialState: DownloadInitialState;

	// Seeding limits
	seedRatioLimit?: string | null;
	seedTimeLimit?: number | null;
	/** qBittorrent only: request sequential piece downloading for newly added torrents. */
	sequentialDownload?: boolean;

	// Path mapping (completed downloads)
	downloadPathLocal?: string | null;
	downloadPathRemote?: string | null;
	// Path mapping (temp/incomplete downloads - SABnzbd only)
	tempPathLocal?: string | null;
	tempPathRemote?: string | null;

	priority: number;
	status?: {
		health: DownloadClientHealth;
		consecutiveFailures: number;
		lastSuccess?: string;
		lastFailure?: string;
		lastFailureMessage?: string;
		lastCheckedAt?: string;
	};
	createdAt?: string;
	updatedAt?: string;
}

/**
 * Server-only input for creating/updating a download client.
 * Debrid clients accept only name, implementation, enabled, priority,
 * apiToken, removeAfterImport. Non-debrid clients keep the full connection
 * surface. This is intentionally not the UI form shape.
 */
export interface DownloadClientInput {
	name: string;
	implementation: DownloadClientImplementation;
	enabled?: boolean;
	priority?: number;
	apiToken?: string | null;
	removeAfterImport?: boolean;
	allowMovies?: boolean;
	allowTv?: boolean;
	// Non-debrid fields
	host?: string;
	port?: number;
	useSsl?: boolean;
	urlBase?: string | null;
	mountMode?: DownloadClientMountMode | null;
	username?: string | null;
	password?: string | null;
	movieCategory?: string;
	tvCategory?: string;
	recentPriority?: DownloadPriority;
	olderPriority?: DownloadPriority;
	initialState?: DownloadInitialState;
	seedRatioLimit?: string | null;
	seedTimeLimit?: number | null;
	sequentialDownload?: boolean;
	downloadPathLocal?: string | null;
	downloadPathRemote?: string | null;
	tempPathLocal?: string | null;
	tempPathRemote?: string | null;
}

/**
 * Form data for creating/editing download client (UI form shape).
 */
export interface DownloadClientFormData {
	name: string;
	implementation: DownloadClientImplementation;
	enabled: boolean;
	host?: string;
	port?: number;
	useSsl?: boolean;
	urlBase?: string | null;
	mountMode?: DownloadClientMountMode | null;
	username?: string | null;
	password?: string | null;
	movieCategory?: string;
	tvCategory?: string;
	recentPriority?: DownloadPriority;
	olderPriority?: DownloadPriority;
	initialState?: DownloadInitialState;
	seedRatioLimit?: string | null;
	seedTimeLimit?: number | null;
	sequentialDownload?: boolean;
	downloadPathLocal?: string | null;
	downloadPathRemote?: string | null;
	tempPathLocal?: string | null;
	tempPathRemote?: string | null;
	priority: number;
	apiToken?: string;
	removeAfterImport?: boolean;
	allowMovies?: boolean;
	allowTv?: boolean;
}

/**
 * Root folder configuration from database
 */
export interface RootFolder {
	id: string;
	name: string;
	path: string;
	mediaType: RootFolderMediaType;
	mediaSubType: RootFolderMediaSubType;
	isDefault: boolean;
	readOnly: boolean;
	preserveSymlinks: boolean;
	defaultMonitored: boolean;
	/** Folder names to skip during disk scan (case-insensitive exact match) */
	skipFolderPatterns: string[];
	/** Video file extensions to exclude from scan (e.g. ".webm") */
	blockedVideoExtensions: string[];
	freeSpaceBytes?: number | null;
	totalSpaceBytes?: number | null;
	freeSpaceFormatted?: string;
	accessible: boolean;
	lastCheckedAt?: string | null;
	createdAt?: string;
}

export type RootFolderWithSpace = Omit<
	Pick<RootFolder, 'id' | 'name' | 'path' | 'mediaType' | 'mediaSubType' | 'freeSpaceBytes'>,
	'mediaType' | 'mediaSubType'
> & {
	mediaType: string;
	mediaSubType?: string | null;
};

export type RootFolderWithSpaceAndDefault = Omit<
	Pick<
		RootFolder,
		| 'id'
		| 'name'
		| 'path'
		| 'mediaType'
		| 'mediaSubType'
		| 'isDefault'
		| 'defaultMonitored'
		| 'readOnly'
		| 'freeSpaceBytes'
	>,
	'mediaType' | 'mediaSubType'
> & {
	mediaType: string;
	mediaSubType?: string | null;
	readOnly?: boolean;
};

export type RootFolderBasic = Omit<Pick<RootFolder, 'id' | 'path' | 'mediaType'>, 'mediaType'> & {
	mediaType: string;
	readOnly?: boolean | null;
};

/**
 * Form data for creating/editing root folder
 */
export interface RootFolderFormData {
	name: string;
	path: string;
	mediaType: RootFolderMediaType;
	mediaSubType: RootFolderMediaSubType;
	isDefault: boolean;
	readOnly?: boolean;
	preserveSymlinks?: boolean;
	defaultMonitored?: boolean;
	skipFolderPatterns?: string[];
	blockedVideoExtensions?: string[];
}

/**
 * Connection test result with details
 */
export interface ConnectionTestResult {
	success: boolean;
	error?: string;
	warnings?: string[];
	/** Minimal redacted provider identity returned by credential tests. */
	accountId?: string;
	accountLabel?: string;
	// NNTP server greeting (for NNTP connections)
	greeting?: string;
	details?: {
		version?: string;
		apiVersion?: string;
		savePath?: string;
		categories?: string[];
		// qBittorrent-specific settings
		maxRatioEnabled?: boolean;
		maxRatio?: number;
		maxSeedingTimeEnabled?: boolean;
		maxSeedingTime?: number;
		maxRatioAction?: number;
		// SABnzbd disk space info
		diskSpace1?: string;
		diskSpace2?: string;
		diskSpaceTotal1?: string;
		diskSpaceTotal2?: string;
	};
}

/**
 * Path validation result
 */
export interface PathValidationResult {
	valid: boolean;
	exists: boolean;
	writable: boolean;
	error?: string;
	freeSpaceBytes?: number;
	freeSpaceFormatted?: string;
}

/**
 * Download client status (runtime info)
 */
export interface DownloadClientStatus {
	health: DownloadClientHealth;
	consecutiveFailures: number;
	lastSuccess?: string;
	lastFailure?: string;
	lastFailureMessage?: string;
	lastCheckedAt?: string;
}

/**
 * Filter state for download client table
 */
export interface DownloadClientFilters {
	implementation: DownloadClientImplementation | 'all';
	status: 'all' | 'enabled' | 'disabled';
	search: string;
}

/**
 * Sort state for download client table
 */
export interface DownloadClientSort {
	column: 'name' | 'priority' | 'implementation' | 'enabled';
	direction: 'asc' | 'desc';
}

/**
 * Unified client item that can represent either a download client or NNTP server.
 * Used in the settings UI where both types are displayed together.
 */
export interface UnifiedClientItem {
	id: string;
	name: string;
	type: 'download-client' | 'nntp-server';
	implementation: DownloadClientImplementation;
	host: string;
	port: number;
	useSsl: boolean | null;
	urlBase?: string | null;
	mountMode?: DownloadClientMountMode | null;
	enabled: boolean | null;
	username?: string | null;
	hasPassword?: boolean;
	// Download client fields
	movieCategory?: string;
	tvCategory?: string;
	allowMovies?: boolean;
	allowTv?: boolean;
	recentPriority?: string;
	olderPriority?: string;
	initialState?: string;
	downloadPathLocal?: string | null;
	downloadPathRemote?: string | null;
	tempPathLocal?: string | null;
	tempPathRemote?: string | null;
	// NNTP server fields
	maxConnections?: number | null;
	priority?: number | null;
	testResult?: string | null;
	lastTestedAt?: string | null;
	status?: {
		health: DownloadClientHealth;
		consecutiveFailures: number;
		lastSuccess?: string;
		lastFailure?: string;
		lastFailureMessage?: string;
		lastCheckedAt?: string;
	};
}
