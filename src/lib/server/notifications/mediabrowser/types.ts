/**
 * Media server notification integration types.
 */

import type { MediaBrowserPathMapping, MediaBrowserServerRecord } from '#lib/server/db/schema.js';

export type { MediaBrowserPathMapping, MediaBrowserServerRecord };

export type MediaBrowserServerType = 'jellyfin' | 'emby' | 'plex';

/**
 * Configuration for creating/updating a MediaBrowser server
 */
export interface MediaBrowserServerInput {
	name: string;
	serverType: MediaBrowserServerType;
	host: string;
	apiKey: string;
	enabled?: boolean;
	onImport?: boolean;
	onUpgrade?: boolean;
	onRename?: boolean;
	onDelete?: boolean;
	pathMappings?: MediaBrowserPathMapping[];
}

/**
 * Configuration for testing a MediaBrowser server connection
 */
export interface MediaBrowserTestConfig {
	host: string;
	apiKey: string;
	serverType?: MediaBrowserServerType;
}

/**
 * Result from testing a MediaBrowser server connection
 */
export interface MediaBrowserTestResult {
	success: boolean;
	error?: string;
	serverInfo?: {
		serverName: string;
		version: string;
		id: string;
		/** Product detected from the running server (never guessed from version). */
		detectedType?: MediaBrowserServerType;
		/** Raw product name reported by the server (e.g. "Jellyfin Server"). */
		productName?: string;
	};
}

/**
 * Public view of a MediaBrowser server (excludes API key)
 */
export interface MediaBrowserServerPublic {
	id: string;
	name: string;
	serverType: MediaBrowserServerType;
	host: string;
	enabled: boolean | null;
	onImport: boolean | null;
	onUpgrade: boolean | null;
	onRename: boolean | null;
	onDelete: boolean | null;
	pathMappings: MediaBrowserPathMapping[] | null;
	serverName: string | null;
	serverVersion: string | null;
	serverId: string | null;
	lastTestedAt: string | null;
	testResult: string | null;
	testError: string | null;
	createdAt: string | null;
	updatedAt: string | null;
}

/**
 * Update type for library notifications
 */
export type LibraryUpdateType = 'Created' | 'Modified' | 'Deleted';

/**
 * The library-changing operation that caused an update. Used to enforce the
 * per-server event toggles (onImport/onUpgrade/onRename/onDelete).
 */
export type MediaEventKind = 'import' | 'upgrade' | 'rename' | 'delete';

/**
 * Which media_browser_servers toggle column governs each event kind.
 * Toggles are nullable; null is treated as enabled (schema default).
 */
export const MEDIA_EVENT_KIND_TOGGLE: Record<
	MediaEventKind,
	'onImport' | 'onUpgrade' | 'onRename' | 'onDelete'
> = {
	import: 'onImport',
	upgrade: 'onUpgrade',
	rename: 'onRename',
	delete: 'onDelete'
};

/**
 * Single library update entry
 */
export interface LibraryUpdateEntry {
	Path: string;
	UpdateType: LibraryUpdateType;
}

/**
 * Payload for library update API call
 */
export interface LibraryUpdatePayload {
	Updates: LibraryUpdateEntry[];
}

/**
 * Response from Jellyfin/Emby System Info endpoint
 */
export interface MediaBrowserSystemInfo {
	ServerName: string;
	Version: string;
	Id: string;
	/** Present on Jellyfin ("Jellyfin Server") and Emby ("Emby Server"). */
	ProductName?: string;
	LocalAddress?: string;
	WanAddress?: string;
	OperatingSystem?: string;
	OperatingSystemDisplayName?: string;
}

/**
 * Minimal Plex identity response
 */
export interface PlexIdentityInfo {
	friendlyName?: string;
	version?: string;
	machineIdentifier?: string;
}

/**
 * Plex library section location
 */
export interface PlexLibraryLocation {
	id: string;
	path: string;
}

/**
 * Pending update in the notifier queue
 */
export interface PendingUpdate {
	path: string;
	updateType: LibraryUpdateType;
	addedAt: number;
	/** Event kind for per-server toggle enforcement. Undefined = legacy update,
	 *  delivered to every enabled server (backward compatibility). */
	eventKind?: MediaEventKind;
}
