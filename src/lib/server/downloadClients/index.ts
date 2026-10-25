/**
 * Download Clients Module
 *
 * Provides services for managing download clients (QBittorrent, etc.)
 * and root folders (media library destinations).
 */

export {
	DownloadClientManager,
	getDownloadClientManager,
	resetDownloadClientManager
} from './DownloadClientManager';
export type { DownloadClientInput } from '#lib/types/downloadClient.js';

export {
	RootFolderService,
	getRootFolderService,
	resetRootFolderService
} from './RootFolderService';
export type { RootFolderInput } from './RootFolderService';

export { QBittorrentClient } from './qbittorrent/QBittorrentClient';
export { TransmissionClient } from './transmission/TransmissionClient';
export { DelugeClient } from './deluge/DelugeClient';
export { RTorrentClient } from './rtorrent/RTorrentClient';
export { Aria2Client } from './aria2/Aria2Client';

export type {
	IDownloadClient,
	DownloadClientConfig,
	AddDownloadOptions,
	DownloadInfo
} from './core/interfaces';
