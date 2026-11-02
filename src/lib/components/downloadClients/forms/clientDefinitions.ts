import type { DownloadClientDefinition } from '#lib/types/downloadClient.js';

/**
 * Available download client definitions.
 */
export const clientDefinitions: DownloadClientDefinition[] = [
	// Torrent clients
	{
		id: 'qbittorrent',
		name: 'qBittorrent',
		description: 'Popular open-source BitTorrent client with web interface',
		defaultPort: 8080,
		protocol: 'torrent',
		supportsCategories: true,
		supportsPriority: true,
		supportsSeedingLimits: true
	},
	{
		id: 'transmission',
		name: 'Transmission',
		description: 'Lightweight, cross-platform BitTorrent client',
		defaultPort: 9091,
		protocol: 'torrent',
		supportsCategories: true,
		supportsPriority: true,
		supportsSeedingLimits: true
	},
	{
		id: 'deluge',
		name: 'Deluge',
		description: 'Feature-rich BitTorrent client with plugin support',
		defaultPort: 8112,
		protocol: 'torrent',
		supportsCategories: true,
		supportsPriority: true,
		supportsSeedingLimits: true
	},
	{
		id: 'rtorrent',
		name: 'rTorrent',
		description: 'Text-based ncurses BitTorrent client (ruTorrent web UI)',
		defaultPort: 8080,
		protocol: 'torrent',
		supportsCategories: true,
		supportsPriority: false,
		supportsSeedingLimits: true
	},
	{
		id: 'aria2',
		name: 'aria2',
		description: 'Lightweight multi-protocol download utility',
		defaultPort: 6800,
		protocol: 'torrent',
		supportsCategories: false,
		supportsPriority: false,
		// aria2 honors seed-time goals at add time (seed-time option).
		supportsSeedingLimits: true
	},
	// Usenet clients
	{
		id: 'sabnzbd',
		name: 'SABnzbd',
		description: 'Popular open-source Usenet downloader with web interface',
		defaultPort: 8080,
		protocol: 'usenet',
		supportsCategories: true,
		supportsPriority: true,
		supportsSeedingLimits: false
	},
	{
		id: 'nzbget',
		name: 'NZBGet',
		description: 'Lightweight, high-performance Usenet downloader',
		defaultPort: 6789,
		protocol: 'usenet',
		supportsCategories: true,
		supportsPriority: true,
		supportsSeedingLimits: false
	},
	// Direct NNTP
	{
		id: 'nntp',
		name: 'NNTP Server',
		description: 'Direct Usenet server connection for NZB streaming',
		defaultPort: 563,
		protocol: 'nntp',
		supportsCategories: false,
		supportsPriority: false,
		supportsSeedingLimits: false
	},
	// Debrid providers
	{
		id: 'realdebrid',
		name: 'Real-Debrid',
		description: 'Real-Debrid torrent acquisition provider',
		defaultPort: 443,
		protocol: 'debrid',
		supportsCategories: false,
		supportsPriority: false,
		supportsSeedingLimits: false,
		isDebrid: true
	},
	{
		id: 'torbox',
		name: 'TorBox',
		description: 'TorBox torrent acquisition provider',
		defaultPort: 443,
		protocol: 'debrid',
		supportsCategories: false,
		supportsPriority: false,
		supportsSeedingLimits: false,
		isDebrid: true
	}
];
