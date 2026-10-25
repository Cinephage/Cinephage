/**
 * QBittorrent WebUI API v2 client implementation.
 *
 * API Documentation: https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-4.1)
 */

import type { ConnectionTestResult } from '#lib/types/downloadClient.js';
import type {
	IDownloadClient,
	DownloadClientConfig,
	AddDownloadOptions,
	DownloadInfo,
	DownloadFileInfo
} from '../core/interfaces';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'imports' as const });

/**
 * QBittorrent preferences from /api/v2/app/preferences
 */
interface QBittorrentPreferences {
	save_path: string;
	max_ratio_enabled: boolean;
	max_ratio: number;
	max_seeding_time_enabled: boolean;
	max_seeding_time: number;
	max_ratio_act: number;
	queueing_enabled: boolean;
	dht: boolean;
}

/**
 * QBittorrent category info
 */
interface QBittorrentCategory {
	name: string;
	savePath: string;
}

/**
 * Response from /api/v2/torrents/add in qBittorrent WebAPI v2.14.0+.
 */
interface QBittorrentAddResponse {
	added_torrent_ids: string[];
	failure_count: number;
	pending_count: number;
	success_count: number;
}

function parseAddResponse(response: string): QBittorrentAddResponse | null {
	try {
		const parsed: unknown = JSON.parse(response);
		if (!parsed || typeof parsed !== 'object') return null;

		const candidate = parsed as Record<string, unknown>;
		if (
			!Array.isArray(candidate.added_torrent_ids) ||
			!candidate.added_torrent_ids.every((id) => typeof id === 'string') ||
			typeof candidate.failure_count !== 'number' ||
			typeof candidate.pending_count !== 'number' ||
			typeof candidate.success_count !== 'number'
		) {
			return null;
		}

		return {
			added_torrent_ids: candidate.added_torrent_ids as string[],
			failure_count: candidate.failure_count,
			pending_count: candidate.pending_count,
			success_count: candidate.success_count
		};
	} catch {
		return null;
	}
}

/**
 * QBittorrent torrent info from /api/v2/torrents/info
 */
interface QBittorrentTorrent {
	hash: string;
	name: string;
	size: number;
	progress: number;
	dlspeed: number;
	upspeed: number;
	priority: number;
	num_seeds: number;
	num_leechs: number;
	ratio: number;
	eta: number;
	state: string;
	category: string;
	save_path: string;
	content_path: string;
	added_on: number;
	completion_on: number;
	/** Per-torrent ratio limit (-2 = global, -1 = unlimited, >0 = limit) */
	ratio_limit?: number;
	/** Per-torrent seeding time limit in minutes (-2 = global, -1 = unlimited, >0 = limit) */
	seeding_time_limit?: number;
	/** Time spent seeding in seconds */
	seeding_time?: number;
}

interface QBittorrentTorrentFile {
	index: number;
	name: string;
	size: number;
	priority: number;
}

/**
 * Map QBittorrent state to our standard status.
 */
function mapTorrentStatus(
	state: string
): 'downloading' | 'stalled' | 'seeding' | 'paused' | 'completed' | 'error' | 'queued' {
	switch (state) {
		case 'downloading':
		case 'forcedDL':
			return 'downloading';

		case 'uploading':
		case 'forcedUP':
		case 'stalledUP':
			return 'seeding';

		case 'pausedDL':
		case 'pausedUP':
		case 'stoppedDL':
		case 'stoppedUP':
			return 'paused';

		case 'queuedDL':
		case 'queuedUP':
		case 'checkingDL':
		case 'checkingUP':
		case 'checkingResumeData':
		case 'moving':
			return 'queued';

		case 'stalledDL':
		case 'metaDL': // Magnet stuck fetching metadata - effectively stalled
		case 'forcedMetaDL':
			return 'stalled';

		case 'error':
		case 'missingFiles':
			return 'error';

		default:
			// If unknown, assume downloading
			return 'downloading';
	}
}

export class QBittorrentClient implements IDownloadClient {
	readonly implementation = 'qbittorrent';

	private config: DownloadClientConfig;
	private sessionCookie: string | null = null;
	private cookieExpiry: number = 0;

	constructor(config: DownloadClientConfig) {
		this.config = config;
	}

	/**
	 * Get the base URL for API requests.
	 */
	private get baseUrl(): string {
		const protocol = this.config.useSsl ? 'https' : 'http';
		const base = `${protocol}://${this.config.host}:${this.config.port}`;
		const urlBase = this.config.urlBase?.trim().replace(/^\/+|\/+$/g, '');
		return urlBase ? `${base}/${urlBase}` : base;
	}

	/**
	 * Make an authenticated request to the QBittorrent API.
	 * For JSON responses, pass a type parameter.
	 * For text responses (POST operations), use requestText() instead.
	 */
	private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
		const text = await this.requestText(endpoint, options);
		if (!text) return {} as T;

		try {
			return JSON.parse(text) as T;
		} catch {
			// qBittorrent API sometimes returns non-JSON responses
			// For operations expecting JSON, this indicates an API issue
			throw new Error(`Expected JSON response but got: ${text.substring(0, 100)}`);
		}
	}

	/**
	 * Make an authenticated request that returns text (e.g., "Ok." for POST operations).
	 */
	private async requestText(endpoint: string, options: RequestInit = {}): Promise<string> {
		// Ensure we're logged in
		await this.ensureAuthenticated();

		const url = `${this.baseUrl}${endpoint}`;
		const headers = new Headers(options.headers);

		if (this.sessionCookie) {
			headers.set('Cookie', this.sessionCookie);
		}

		const response = await fetch(url, {
			...options,
			headers
		});

		if (response.status === 403) {
			// Session expired, try to re-authenticate
			this.sessionCookie = null;
			this.cookieExpiry = 0;
			await this.ensureAuthenticated();

			// Retry the request
			headers.set('Cookie', this.sessionCookie!);
			const retryResponse = await fetch(url, { ...options, headers });

			if (!retryResponse.ok) {
				throw new Error(
					`QBittorrent API error: ${retryResponse.status} ${retryResponse.statusText}`
				);
			}

			return retryResponse.text();
		}

		if (!response.ok) {
			throw new Error(`QBittorrent API error: ${response.status} ${response.statusText}`);
		}

		return response.text();
	}

	/**
	 * Ensure we have a valid session cookie.
	 */
	private async ensureAuthenticated(): Promise<void> {
		// Check if we have a valid session
		if (this.sessionCookie && Date.now() < this.cookieExpiry) {
			return;
		}

		await this.login();
	}

	/**
	 * Authenticate with QBittorrent.
	 */
	private async login(): Promise<void> {
		const url = `${this.baseUrl}/api/v2/auth/login`;

		const formData = new URLSearchParams();
		formData.append('username', this.config.username || '');
		formData.append('password', this.config.password || '');

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: formData.toString()
		});

		if (response.status === 401) {
			throw new Error('QBittorrent authentication failed: Invalid credentials');
		}

		if (!response.ok) {
			throw new Error(`QBittorrent authentication failed: ${response.status}`);
		}

		// qBittorrent <5.2 returns 200 with "Ok.", 5.2+ returns 204 with empty body
		const text = await response.text();
		if (text && text !== 'Ok.') {
			throw new Error('QBittorrent authentication failed: Invalid credentials');
		}

		// Extract session cookie
		// 5.2+ uses QBT_SID_<port>, older versions use SID
		const setCookie = response.headers.get('set-cookie');
		if (setCookie) {
			const match = setCookie.match(/([^=;\s]*SID[^=]*)=([^;]+)/);
			if (match) {
				this.sessionCookie = `${match[1]}=${match[2]}`;
				this.cookieExpiry = Date.now() + 50 * 60 * 1000;
			}
		}
	}

	/**
	 * Test connectivity and get client info.
	 */
	async test(): Promise<ConnectionTestResult> {
		try {
			// Try to login first
			await this.login();

			// Get version info
			const [version, apiVersion, preferences, categories] = await Promise.all([
				this.requestText('/api/v2/app/version'),
				this.requestText('/api/v2/app/webapiVersion'),
				this.request<QBittorrentPreferences>('/api/v2/app/preferences'),
				this.getCategories()
			]);

			// Check if qBittorrent is configured to pause torrents when seeding limits are met
			// max_ratio_act: 0 = Pause, 1 = Remove, 2 = Enable super seeding, 3 = Remove + delete files
			// We want Pause (0) because Cinephage handles removal after import + seeding complete
			const warnings: string[] = [];

			const hasRatioLimit = preferences.max_ratio_enabled && preferences.max_ratio > 0;
			const hasTimeLimit = preferences.max_seeding_time_enabled && preferences.max_seeding_time > 0;

			// If using Remove action, warn that Cinephage prefers to control removal
			if (preferences.max_ratio_act === 1 || preferences.max_ratio_act === 3) {
				warnings.push(
					`qBittorrent is configured to automatically remove torrents when seeding limits are reached. ` +
						`Cinephage works best with "Pause torrent" so it can track and remove torrents after import. ` +
						`Consider setting "When ratio reaches its limit" to "Pause torrent" in qBittorrent's Options → BitTorrent.`
				);
			}

			// If no limits enabled and no per-torrent limits will be set, warn
			if (!hasRatioLimit && !hasTimeLimit) {
				// Check if per-torrent limits from indexers will be used
				// This is informational - indexer settings will set per-torrent limits
				logger.debug(
					'qBittorrent has no global seeding limits, per-torrent limits from indexers will be used'
				);
			}

			return {
				success: true,
				details: {
					version: version.toString(),
					apiVersion: apiVersion.toString(),
					savePath: preferences.save_path,
					categories,
					maxRatioEnabled: preferences.max_ratio_enabled,
					maxRatio: preferences.max_ratio,
					maxSeedingTimeEnabled: preferences.max_seeding_time_enabled,
					maxSeedingTime: preferences.max_seeding_time,
					maxRatioAction: preferences.max_ratio_act
				},
				warnings: warnings.length > 0 ? warnings : undefined
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	/**
	 * Get the default save path.
	 */
	async getDefaultSavePath(): Promise<string> {
		const preferences = await this.request<QBittorrentPreferences>('/api/v2/app/preferences');
		return preferences.save_path;
	}

	/**
	 * Get all categories.
	 */
	async getCategories(): Promise<string[]> {
		const categories = await this.request<Record<string, QBittorrentCategory>>(
			'/api/v2/torrents/categories'
		);
		return Object.keys(categories);
	}

	/**
	 * Create a category if it doesn't exist.
	 */
	async ensureCategory(name: string, savePath?: string): Promise<void> {
		const existingCategories = await this.getCategories();

		if (existingCategories.includes(name)) {
			return;
		}

		const formData = new URLSearchParams();
		formData.append('category', name);
		if (savePath) {
			formData.append('savePath', savePath);
		}

		await this.requestText('/api/v2/torrents/createCategory', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: formData.toString()
		});
	}

	/**
	 * Extract info hash from magnet URI or other sources
	 */
	private extractInfoHash(options: AddDownloadOptions): string | null {
		// Direct infoHash provided
		if (options.infoHash) {
			return options.infoHash.toLowerCase();
		}

		// Extract from magnet URI
		if (options.magnetUri) {
			// Try hex format first (40 chars)
			const hexMatch = options.magnetUri.match(/xt=urn:btih:([a-fA-F0-9]{40})/i);
			if (hexMatch) {
				return hexMatch[1].toLowerCase();
			}

			// Try base32 format (32 chars) and convert to hex
			const base32Match = options.magnetUri.match(/xt=urn:btih:([A-Z2-7]{32})/i);
			if (base32Match) {
				const base32 = base32Match[1].toUpperCase();
				return this.base32ToHex(base32);
			}
		}

		// Extract hash from torrent download URL (many sites include hash in URL)
		if (options.downloadUrl) {
			// Common patterns: /download/HASH, /torrent/HASH, ?hash=HASH, /HASH.torrent
			const urlHashMatch = options.downloadUrl.match(/\/([a-fA-F0-9]{40})(?:[/?.]|$)/i);
			if (urlHashMatch) {
				return urlHashMatch[1].toLowerCase();
			}
		}

		return null;
	}

	/**
	 * Wait for a torrent to be loaded in qBittorrent after adding.
	 * Similar to Radarr's WaitForTorrent pattern.
	 * @returns true if torrent is loaded, false if timeout
	 */
	private async waitForTorrent(hash: string, maxAttempts = 10, delayMs = 100): Promise<boolean> {
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				const torrent = await this.getDownload(hash);
				if (torrent) {
					return true;
				}
			} catch {
				// Ignore errors during polling
			}

			logger.debug(
				`[QBittorrent] Torrent '${hash}' not yet visible, waiting ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`
			);
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}

		logger.warn(
			`[QBittorrent] Failed to confirm torrent '${hash}' loaded within ${maxAttempts * delayMs}ms`
		);
		return false;
	}

	private normalizeTorrentPath(path: string): string {
		return path.replace(/\\/g, '/').trim();
	}

	private async getTorrentFiles(hash: string): Promise<QBittorrentTorrentFile[]> {
		return this.request<QBittorrentTorrentFile[]>(
			`/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`
		);
	}

	private async setFilePriority(hash: string, fileIds: number[], priority: number): Promise<void> {
		if (fileIds.length === 0) {
			return;
		}

		const formData = new URLSearchParams();
		formData.append('hash', hash);
		formData.append('id', fileIds.join('|'));
		formData.append('priority', String(priority));

		await this.requestText('/api/v2/torrents/filePrio', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: formData.toString()
		});
	}

	private async applyFileSelection(
		hash: string,
		selection: NonNullable<AddDownloadOptions['fileSelection']>
	): Promise<void> {
		const files = await this.getTorrentFiles(hash);
		if (files.length === 0) {
			throw new Error('Torrent metadata has no file list yet');
		}

		const includeById = new Set<number>();
		const fileIdsInTorrent = new Set(files.map((file) => file.index));
		for (const index of selection.fileIndices) {
			if (fileIdsInTorrent.has(index)) {
				includeById.add(index);
			}
		}

		if (selection.filePaths && selection.filePaths.length > 0) {
			const idByPath = new Map(
				files.map((file) => [this.normalizeTorrentPath(file.name), file.index] as const)
			);
			for (const path of selection.filePaths) {
				const id = idByPath.get(this.normalizeTorrentPath(path));
				if (id !== undefined) {
					includeById.add(id);
				}
			}
		}

		const includedIds = Array.from(includeById).sort((a, b) => a - b);
		if (includedIds.length === 0) {
			throw new Error('No matched files found in torrent for episode pointer');
		}

		const allIds = files.map((file) => file.index);
		const unwantedIds = allIds.filter((id) => !includeById.has(id));

		await this.setFilePriority(hash, unwantedIds, 0);
		await this.setFilePriority(hash, includedIds, 1);

		logger.info(
			{
				hash,
				keptFiles: includedIds.length,
				totalFiles: files.length
			},
			'[QBittorrent] Applied file selection'
		);
	}

	/**
	 * Add a download.
	 * Includes duplicate detection and graceful error handling.
	 */
	async addDownload(options: AddDownloadOptions): Promise<string> {
		// Extract info hash for duplicate detection
		const infoHash = this.extractInfoHash(options);

		// Check for existing torrent (duplicate detection)
		if (infoHash) {
			try {
				const existingTorrent = await this.getDownload(infoHash);
				if (existingTorrent) {
					logger.info(
						{
							hash: infoHash,
							name: existingTorrent.name,
							status: existingTorrent.status,
							progress: existingTorrent.progress
						},
						'[QBittorrent] Torrent already exists in client'
					);

					// Return the existing hash - caller can decide what to do
					// We throw a specific error so the grab endpoint can handle it
					const error = new Error(
						`Torrent already exists in qBittorrent: ${existingTorrent.name} (${existingTorrent.status}, ${Math.round(existingTorrent.progress * 100)}%)`
					);
					(error as Error & { existingTorrent: DownloadInfo }).existingTorrent = existingTorrent;
					(error as Error & { isDuplicate: boolean }).isDuplicate = true;
					throw error;
				}
			} catch (error) {
				// Re-throw duplicate errors
				if ((error as Error & { isDuplicate?: boolean }).isDuplicate) {
					throw error;
				}
				// Log but don't fail on lookup errors - continue with add attempt
				logger.debug(
					{
						hash: infoHash,
						error: error instanceof Error ? error.message : String(error)
					},
					'[QBittorrent] Could not check for existing torrent'
				);
			}
		}

		const formData = new FormData();

		// Determine what to send to qBittorrent
		// Priority: torrentFile > magnetUri > infoHash > downloadUrl
		// CRITICAL: We always prefer torrent files over magnet links. Torrent files
		// contain the private tracker announce URL which is required for private
		// trackers like nCore to work. Magnet links built from info hashes only
		// include public trackers and will fail for private torrents.
		let urlsValue: string | undefined;
		let sourceType: string;

		if (options.torrentFile) {
			// ALWAYS prefer torrent files - they contain private tracker announce URLs
			// This is critical for private trackers like nCore
			const uint8Array = new Uint8Array(options.torrentFile);
			formData.append('torrents', new Blob([uint8Array]), 'torrent.torrent');
			sourceType = 'torrentFile';
		} else if (options.magnetUri) {
			urlsValue = options.magnetUri;
			sourceType = 'magnetUri';
			formData.append('urls', options.magnetUri);
		} else if (options.infoHash) {
			// Build a magnet URI from the info hash - this bypasses Cloudflare issues
			urlsValue = `magnet:?xt=urn:btih:${options.infoHash}`;
			sourceType = 'infoHash->magnet';
			formData.append('urls', urlsValue);
		} else if (options.downloadUrl) {
			urlsValue = options.downloadUrl;
			sourceType = 'downloadUrl';
			formData.append('urls', options.downloadUrl);
		} else {
			throw new Error('Must provide magnetUri, infoHash, downloadUrl, or torrentFile');
		}

		logger.debug(
			{
				sourceType,
				urlsValue: urlsValue
					? urlsValue.length > 200
						? urlsValue.substring(0, 200) + '...'
						: urlsValue
					: undefined,
				infoHash,
				category: options.category,
				hasInfoHash: !!options.infoHash,
				hasMagnetUri: !!options.magnetUri,
				hasDownloadUrl: !!options.downloadUrl,
				hasTorrentFile: !!options.torrentFile
			},
			'[QBittorrent] Adding download'
		);

		if (options.category) {
			formData.append('category', options.category);
		}

		if (options.savePath) {
			formData.append('savepath', options.savePath);
		}

		if (options.paused) {
			// API v2.0.1+ uses 'stopped', older versions use 'paused'
			formData.append('stopped', 'true');
		}

		if (options.seedRatioLimit !== undefined) {
			formData.append('ratioLimit', options.seedRatioLimit.toString());
		}

		if (options.seedTimeLimit !== undefined) {
			formData.append('seedingTimeLimit', options.seedTimeLimit.toString());
		}

		if (this.config.sequentialDownload) {
			formData.append('sequentialDownload', 'true');
		}

		// Determine initial state based on priority
		const forceStart = options.priority === 'force';

		logger.info(
			{
				sourceType,
				infoHash,
				category: options.category,
				baseUrl: this.baseUrl
			},
			'[QBittorrent] Sending add request to qBittorrent'
		);

		const response = await this.requestText('/api/v2/torrents/add', {
			method: 'POST',
			body: formData
		});

		logger.info(
			{
				response,
				sourceType,
				infoHash
			},
			'[QBittorrent] Add torrent response'
		);

		// WebAPI v2.14.0+ returns structured counters and torrent IDs. Older
		// versions return "Ok." on success, "Fails." on failure, or an empty
		// response on success.
		const addResponse = parseAddResponse(response);
		const responseIndicatesFailure = addResponse
			? addResponse.failure_count > 0 &&
				addResponse.success_count === 0 &&
				addResponse.pending_count === 0
			: response.trim().toLowerCase() === 'fails.';

		if (responseIndicatesFailure) {
			// Check if it's actually a duplicate that wasn't caught before
			// (can happen with torrent files where we don't know hash beforehand)
			if (infoHash) {
				const existingTorrent = await this.getDownload(infoHash);
				if (existingTorrent) {
					logger.info(
						{
							hash: infoHash,
							name: existingTorrent.name
						},
						'[QBittorrent] Add failed but torrent exists - treating as duplicate'
					);
					const error = new Error(
						`Torrent already exists in qBittorrent: ${existingTorrent.name} (${existingTorrent.status}, ${Math.round(existingTorrent.progress * 100)}%)`
					);
					(error as Error & { existingTorrent: DownloadInfo }).existingTorrent = existingTorrent;
					(error as Error & { isDuplicate: boolean }).isDuplicate = true;
					throw error;
				}
			}

			logger.error(
				{
					response,
					sourceType,
					infoHash,
					category: options.category
				},
				'[QBittorrent] Torrent add failed'
			);
			const failDetail = addResponse
				? `${addResponse.failure_count} failed, ${addResponse.success_count} succeeded`
				: response.trim();
			throw new Error(`qBittorrent rejected the torrent: ${failDetail}`);
		}

		// WebAPI v2.14.0+ returns the added hash, which is useful when the source
		// was a URL and Cinephage could not determine the hash before adding it.
		const returnHash = infoHash || addResponse?.added_torrent_ids[0] || '';

		// Apply file selection for episode pointers before force-starting.
		if (returnHash && options.fileSelection && options.fileSelection.fileIndices.length > 0) {
			const loaded = await this.waitForTorrent(returnHash, 60, 250);
			if (!loaded) {
				throw new Error('Unable to apply episode pointer file selection: torrent not available');
			}
			await this.applyFileSelection(returnHash, options.fileSelection);
		}

		// Wait for torrent to be loaded before applying additional settings (Radarr pattern)
		if (returnHash && forceStart) {
			const loaded = await this.waitForTorrent(returnHash);
			if (loaded) {
				try {
					await this.setForceStart(returnHash, true);
				} catch (error) {
					logger.warn(
						{
							hash: returnHash,
							error: error instanceof Error ? error.message : String(error)
						},
						'[QBittorrent] Failed to set force start'
					);
				}
			}
		}

		return returnHash;
	}

	/**
	 * Set force start for a torrent
	 */
	async setForceStart(hash: string, force: boolean): Promise<void> {
		const formData = new URLSearchParams();
		formData.append('hashes', hash);
		formData.append('value', force.toString());

		await this.requestText('/api/v2/torrents/setForceStart', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: formData.toString()
		});
	}

	/**
	 * Convert base32 to hex (for magnet link hash conversion)
	 */
	private base32ToHex(base32: string): string {
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
		let bits = '';

		for (const char of base32) {
			const val = alphabet.indexOf(char.toUpperCase());
			if (val === -1) continue;
			bits += val.toString(2).padStart(5, '0');
		}

		let hex = '';
		for (let i = 0; i < bits.length - 3; i += 4) {
			hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
		}

		return hex.toLowerCase();
	}

	/**
	 * Check if a torrent has reached its seeding limits.
	 * Follows Radarr's HasReachedSeedLimit pattern.
	 */
	private hasReachedSeedLimit(
		torrent: QBittorrentTorrent,
		globalPrefs: QBittorrentPreferences
	): boolean {
		// Check per-torrent ratio limit
		if (torrent.ratio_limit !== undefined && torrent.ratio_limit > 0) {
			// Per-torrent limit set
			if (torrent.ratio >= torrent.ratio_limit - 0.001) {
				return true;
			}
		} else if (torrent.ratio_limit === -2 && globalPrefs.max_ratio_enabled) {
			// Use global limit
			if (torrent.ratio >= globalPrefs.max_ratio - 0.001) {
				return true;
			}
		}

		// Check per-torrent seeding time limit
		if (torrent.seeding_time_limit !== undefined && torrent.seeding_time_limit > 0) {
			// Per-torrent limit set (limit is in minutes, seeding_time is in seconds)
			const limitSeconds = torrent.seeding_time_limit * 60;
			if ((torrent.seeding_time || 0) >= limitSeconds) {
				return true;
			}
		} else if (torrent.seeding_time_limit === -2 && globalPrefs.max_seeding_time_enabled) {
			// Use global limit (global is also in minutes)
			const limitSeconds = globalPrefs.max_seeding_time * 60;
			if ((torrent.seeding_time || 0) >= limitSeconds) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Check if torrent state indicates it's paused after seeding (eligible for removal)
	 */
	private isPausedAfterSeeding(state: string): boolean {
		return state === 'pausedUP' || state === 'stoppedUP';
	}

	/**
	 * Check if torrent state indicates it's actively seeding
	 * When seeding, files cannot be moved (must use hardlink/copy)
	 */
	private isSeeding(state: string): boolean {
		return (
			state === 'uploading' || state === 'forcedUP' || state === 'stalledUP' || state === 'queuedUP'
		);
	}

	/**
	 * Check if torrent is completed (downloading finished)
	 */
	private isCompleted(state: string, progress: number): boolean {
		return (
			progress >= 1 ||
			state === 'uploading' ||
			state === 'forcedUP' ||
			state === 'stalledUP' ||
			state === 'queuedUP' ||
			state === 'pausedUP' ||
			state === 'stoppedUP'
		);
	}

	/**
	 * Map a QBittorrent torrent to DownloadInfo, calculating canMoveFiles and canBeRemoved
	 *
	 * Follows Radarr's pattern:
	 * - canMoveFiles: false when seeding (source must be preserved), true when paused/stopped
	 * - canBeRemoved: true when paused AND seeding limits met
	 */
	private mapTorrentToDownloadInfo(
		t: QBittorrentTorrent,
		globalPrefs: QBittorrentPreferences
	): DownloadInfo {
		const isPaused = this.isPausedAfterSeeding(t.state);
		const isSeeding = this.isSeeding(t.state);
		const hasReachedSeedLimit = this.hasReachedSeedLimit(t, globalPrefs);

		// canMoveFiles: false for seeding torrents (must hardlink/copy to preserve source)
		// true for paused torrents or those not yet completed
		// Follows Radarr's DownloadClientItem.CanMoveFiles pattern
		const canMoveFiles = isPaused && !isSeeding;

		// canBeRemoved: torrent is paused AND has reached seeding limits
		// Follows Radarr's QBittorrent.cs logic
		const canBeRemoved = isPaused && hasReachedSeedLimit;

		return {
			id: t.hash,
			name: t.name,
			hash: t.hash,
			progress: t.progress,
			status: mapTorrentStatus(t.state),
			size: t.size,
			downloadSpeed: t.dlspeed,
			uploadSpeed: t.upspeed,
			eta: t.eta > 0 ? t.eta : undefined,
			savePath: t.save_path,
			contentPath: t.content_path,
			category: t.category || undefined,
			ratio: t.ratio,
			addedOn: t.added_on ? new Date(t.added_on * 1000) : undefined,
			completedOn: t.completion_on > 0 ? new Date(t.completion_on * 1000) : undefined,
			seedingTime: t.seeding_time,
			ratioLimit: t.ratio_limit,
			seedingTimeLimit: t.seeding_time_limit,
			canMoveFiles,
			canBeRemoved,
			removed: false
		};
	}

	// Cache for global preferences (refresh every 5 minutes)
	private preferencesCache: { prefs: QBittorrentPreferences; expiry: number } | null = null;
	private readonly PREFS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

	/**
	 * Get global preferences, with caching
	 */
	private async getGlobalPreferences(): Promise<QBittorrentPreferences> {
		if (this.preferencesCache && Date.now() < this.preferencesCache.expiry) {
			return this.preferencesCache.prefs;
		}

		const prefs = await this.request<QBittorrentPreferences>('/api/v2/app/preferences');
		this.preferencesCache = {
			prefs,
			expiry: Date.now() + this.PREFS_CACHE_TTL
		};
		return prefs;
	}

	/**
	 * Get all downloads, optionally filtered by category.
	 */
	async getDownloads(category?: string): Promise<DownloadInfo[]> {
		let endpoint = '/api/v2/torrents/info';
		if (category) {
			endpoint += `?category=${encodeURIComponent(category)}`;
		}

		const [torrents, globalPrefs] = await Promise.all([
			this.request<QBittorrentTorrent[]>(endpoint),
			this.getGlobalPreferences()
		]);

		return torrents.map((t) => this.mapTorrentToDownloadInfo(t, globalPrefs));
	}

	/**
	 * Get a single download by hash.
	 */
	async getDownload(hash: string): Promise<DownloadInfo | null> {
		const [torrents, globalPrefs] = await Promise.all([
			this.request<QBittorrentTorrent[]>(`/api/v2/torrents/info?hashes=${hash}`),
			this.getGlobalPreferences()
		]);

		if (torrents.length === 0) {
			return null;
		}

		return this.mapTorrentToDownloadInfo(torrents[0], globalPrefs);
	}

	/**
	 * Remove a download.
	 */
	async removeDownload(hash: string, deleteFiles = false): Promise<void> {
		const formData = new URLSearchParams();
		formData.append('hashes', hash);
		formData.append('deleteFiles', deleteFiles.toString());

		await this.requestText('/api/v2/torrents/delete', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: formData.toString()
		});
	}

	/**
	 * Pause a download.
	 */
	async pauseDownload(hash: string): Promise<void> {
		const formData = new URLSearchParams();
		formData.append('hashes', hash);

		// API v2.0.2+ uses 'stop', older uses 'pause'
		await this.requestText('/api/v2/torrents/stop', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: formData.toString()
		}).catch(() => {
			// Fallback to older API
			return this.requestText('/api/v2/torrents/pause', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: formData.toString()
			});
		});
	}

	/**
	 * Resume a download.
	 */
	async resumeDownload(hash: string): Promise<void> {
		const formData = new URLSearchParams();
		formData.append('hashes', hash);

		// API v2.0.2+ uses 'start', older uses 'resume'
		await this.requestText('/api/v2/torrents/start', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: formData.toString()
		}).catch(() => {
			// Fallback to older API
			return this.requestText('/api/v2/torrents/resume', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: formData.toString()
			});
		});
	}

	/**
	 * Mark a torrent as imported by moving it to a post-import category.
	 * Follows Radarr's QBittorrent.MarkItemAsImported pattern.
	 *
	 * @param hash - Torrent hash
	 * @param importedCategory - Category to move the torrent to (e.g., "cinephage-imported")
	 */
	async markItemAsImported(hash: string, importedCategory?: string): Promise<void> {
		if (!importedCategory) {
			logger.debug(
				{
					hash
				},
				'[QBittorrent] No imported category configured, skipping category change'
			);
			return;
		}

		try {
			// Ensure the category exists
			await this.ensureCategory(importedCategory);

			// Set the category
			const formData = new URLSearchParams();
			formData.append('hashes', hash);
			formData.append('category', importedCategory);

			await this.requestText('/api/v2/torrents/setCategory', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: formData.toString()
			});

			logger.info(
				{
					hash,
					category: importedCategory
				},
				'[QBittorrent] Moved torrent to imported category'
			);
		} catch (error) {
			logger.warn(
				{
					hash,
					category: importedCategory,
					error: error instanceof Error ? error.message : String(error)
				},
				'[QBittorrent] Failed to set post-import category'
			);
			// Don't throw - this is a non-critical operation
		}
	}

	/**
	 * Set seeding configuration for a torrent.
	 * Follows Radarr's QBittorrent.SetTorrentSeedingConfiguration pattern.
	 *
	 * @param hash - Torrent hash
	 * @param config - Seed ratio and time limits
	 */
	async setSeedingConfig(
		hash: string,
		config: { ratioLimit?: number; seedingTimeLimit?: number }
	): Promise<void> {
		try {
			const formData = new URLSearchParams();
			formData.append('hashes', hash);

			if (config.ratioLimit !== undefined) {
				// -2 = use global, -1 = unlimited, >0 = specific limit
				formData.append('ratioLimit', config.ratioLimit.toString());
			}

			if (config.seedingTimeLimit !== undefined) {
				// -2 = use global, -1 = unlimited, >0 = limit in minutes
				formData.append('seedingTimeLimit', config.seedingTimeLimit.toString());
			}

			await this.requestText('/api/v2/torrents/setShareLimits', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: formData.toString()
			});

			logger.info(
				{
					hash,
					ratioLimit: config.ratioLimit,
					seedingTimeLimit: config.seedingTimeLimit
				},
				'[QBittorrent] Set seeding configuration'
			);
		} catch (error) {
			logger.warn(
				{
					hash,
					error: error instanceof Error ? error.message : String(error)
				},
				'[QBittorrent] Failed to set seeding configuration'
			);
			throw error;
		}
	}

	async getFiles(hash: string): Promise<DownloadFileInfo[]> {
		const files = await this.getTorrentFiles(hash);
		return files.map((f) => ({
			index: f.index,
			name: f.name,
			size: f.size
		}));
	}

	/**
	 * Exclude files from being downloaded by setting their priority to 0.
	 * Excluded files never reach disk; the torrent keeps downloading the rest.
	 */
	async excludeFiles(hash: string, indices: number[]): Promise<void> {
		if (indices.length === 0) {
			return;
		}
		await this.setFilePriority(hash, indices, 0);
	}
}
