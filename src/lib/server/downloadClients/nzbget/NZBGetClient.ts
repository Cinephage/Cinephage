import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'imports' as const });
import type {
	IDownloadClient,
	DownloadClientConfig,
	AddDownloadOptions,
	DownloadInfo,
	ConnectionTestResult,
	NntpServerConfig
} from '#lib/server/downloadClients/core/interfaces.js';
import type { JsonRpcResponse, NzbgetGroup, NzbgetHistory, NzbgetStatus } from './types';

export class NZBGetClient implements IDownloadClient {
	readonly implementation = 'nzbget';
	private config: DownloadClientConfig;

	constructor(config: DownloadClientConfig) {
		this.config = config;
		logger.debug(
			{
				host: config.host,
				port: config.port,
				useSsl: config.useSsl,
				hasAuth: !!(config.username && config.password)
			},
			'[NZBGet] Initialized with config'
		);
	}

	private get baseUrl(): string {
		const protocol = this.config.useSsl ? 'https' : 'http';
		// Sanitize host to ensure no protocol or credentials sneak in
		let host = this.config.host.replace(/^https?:\/\//, '').replace(/\/$/, '');
		// Remove content before @ if present (credentials)
		if (host.includes('@')) {
			host = host.split('@').pop() || host;
		}

		const base = `${protocol}://${host}:${this.config.port}`;
		const urlBase = this.config.urlBase?.trim().replace(/^\/+|\/+$/g, '');
		const baseWithPath = urlBase ? `${base}/${urlBase}` : base;
		return `${baseWithPath}/jsonrpc`;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private async request<T>(method: string, params: any[] = []): Promise<T> {
		try {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json'
			};

			if (this.config.username && this.config.password) {
				const auth = Buffer.from(`${this.config.username}:${this.config.password}`).toString(
					'base64'
				);
				headers['Authorization'] = `Basic ${auth}`;
			}

			logger.debug({ method }, `[NZBGet] Sending request`);

			const response = await fetch(this.baseUrl, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					method,
					params
				})
			});

			if (!response.ok) {
				throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
			}

			const data = (await response.json()) as JsonRpcResponse<T>;

			if (data.error) {
				throw new Error(`NZBGet Error: ${data.error.name} - ${data.error.message}`);
			}

			return data.result;
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : 'Unknown error'
				},
				`[NZBGet] Request failed: ${method}`
			);
			throw error;
		}
	}

	async test(): Promise<ConnectionTestResult> {
		try {
			const _status = await this.request<NzbgetStatus>('status');
			const version = await this.request<string>('version');

			// Try to get MainDir from config
			let savePath = '';
			try {
				const configMap = await this.request<Record<string, string>>('config');
				savePath = configMap['MainDir'] || '';
			} catch {
				// Ignore config fetch error, not critical
			}

			return {
				success: true,
				details: {
					version,
					savePath
				}
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}

	async addDownload(options: AddDownloadOptions): Promise<string> {
		const name = options.title || 'download.nzb';
		const category = options.category || '';
		const priority = this.mapPriority(options.priority);
		const paused = options.paused ?? false;
		const dupeKey = options.infoHash || '';
		const dupeScore = 0;
		const dupeMode = 'SCORE';
		const pparams = [{ Name: 'x-category', Value: category }];

		logger.info(
			{
				name,
				category,
				priority,
				hasNzbFile: !!options.nzbFile,
				hasUrl: !!options.downloadUrl
			},
			'[NZBGet] Adding download'
		);

		let nzbId: number;

		if (options.nzbFile) {
			const content = options.nzbFile.toString('base64');
			nzbId = await this.request<number>('append', [
				name,
				content,
				category,
				priority,
				false, // addToTop
				paused,
				dupeKey,
				dupeScore,
				dupeMode,
				pparams
			]);
		} else if (options.downloadUrl) {
			nzbId = await this.request<number>('appendurl', [
				name,
				options.downloadUrl,
				category,
				priority,
				false, // addToTop
				paused,
				dupeKey,
				dupeScore,
				dupeMode,
				pparams
			]);
		} else {
			throw new Error('Must provide either NZB file or download URL');
		}

		if (nzbId > 0) {
			logger.info({ nzbId }, '[NZBGet] Download added successfully');
			return nzbId.toString();
		} else {
			throw new Error('NZBGet failed to add download');
		}
	}

	async getDownloads(category?: string): Promise<DownloadInfo[]> {
		const [groups, history] = await Promise.all([
			this.request<NzbgetGroup[]>('listgroups', [0, 1000]), // 0 = unlimited, but limit to sane number
			this.request<NzbgetHistory[]>('history', [false, 0, 100]) // false = exclude hidden
		]);

		const results: DownloadInfo[] = [];

		logger.debug(
			{
				categoryFilter: category
			},
			`[NZBGet] Fetched ${groups.length} groups and ${history.length} history items`
		);

		// Map active downloads (groups)
		for (const item of groups) {
			logger.debug(
				{
					NZBID: item.NZBID,
					NZBName: item.NZBName,
					Category: item.Category
				},
				`[NZBGet] Group item`
			);

			if (category && item.Category && item.Category.toLowerCase() !== category.toLowerCase())
				continue;

			results.push({
				id: item.NZBID.toString(),
				name: item.NZBName,
				hash: item.NZBID.toString(),
				progress:
					(item.DownloadedSizeHi * 4294967296 + item.DownloadedSizeLo) /
					(item.FileSizeHi * 4294967296 + item.FileSizeLo || 1),
				status: this.mapStatus(item.Status),
				size: item.FileSizeHi * 4294967296 + item.FileSizeLo,
				downloadSpeed: 0,
				uploadSpeed: 0,
				eta: 0,
				category: item.Category,
				savePath: item.DestDir,
				contentPath: item.DestDir,
				canMoveFiles: true,
				// Can be removed when no longer actively downloading
				canBeRemoved: false,
				removed: false
			});
		}

		// Map history
		for (const item of history) {
			logger.debug(
				{
					ID: item.ID,
					Name: item.Name,
					Category: item.Category
				},
				`[NZBGet] History item`
			);

			if (category && item.Category && item.Category.toLowerCase() !== category.toLowerCase())
				continue;

			results.push({
				id: item.ID.toString(),
				name: item.Name,
				hash: item.ID.toString(),
				progress: item.Status === 'SUCCESS' ? 1 : 0, // Normalized to 0-1 range
				status: item.Status === 'SUCCESS' ? 'completed' : 'error',
				size: item.FileSizeHi * 4294967296 + item.FileSizeLo,
				downloadSpeed: 0,
				uploadSpeed: 0,
				category: item.Category,
				savePath: item.DestDir,
				contentPath: item.DestDir,
				completedOn: new Date((item.UnixTimeHi * 4294967296 + item.UnixTimeLo) * 1000),
				// Usenet downloads can always be moved (no seeding)
				canMoveFiles: true,
				// Usenet can be removed once completed
				canBeRemoved: item.Status === 'SUCCESS',
				removed: false
			});
		}

		return results;
	}

	async getDownload(id: string): Promise<DownloadInfo | null> {
		// NZBGet doesn't have a direct "get one" for groups, so we scan
		const downloads = await this.getDownloads();
		return downloads.find((d) => d.id === id) || null;
	}

	async removeDownload(id: string, _deleteFiles: boolean = false): Promise<void> {
		// Remove from history
		const historySuccess = await this.request<boolean>('editqueue', [
			'HistoryDelete',
			0,
			'',
			[parseInt(id)]
		]);

		if (!historySuccess) {
			// Try removing from group (active)
			await this.request<boolean>('editqueue', ['GroupDelete', 0, '', [parseInt(id)]]);
		}
	}

	async pauseDownload(id: string): Promise<void> {
		await this.request<boolean>('editqueue', ['GroupPause', 0, '', [parseInt(id)]]);
	}

	async resumeDownload(id: string): Promise<void> {
		await this.request<boolean>('editqueue', ['GroupResume', 0, '', [parseInt(id)]]);
	}

	async getDefaultSavePath(): Promise<string> {
		try {
			const configMap = await this.request<Record<string, string>>('config');
			return configMap['MainDir'] || '';
		} catch {
			return '';
		}
	}

	async getCategories(): Promise<string[]> {
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const _configMap = await this.request<any[]>('config');
			// Categories are defined as Category1.Name, Category2.Name etc
			const _categories: string[] = [];
			// This is complex to parse from the flat config list, simple fallback for now:
			return [];
		} catch {
			return [];
		}
	}

	async ensureCategory(_name: string, _savePath?: string): Promise<void> {
		// NZBGet config is complex to update via API, strict implementation skipped for MVP
		return;
	}

	/**
	 * Get NNTP server configurations from NZBGet.
	 * NZBGet stores servers as Server1.Host, Server1.Port, Server1.Username, etc.
	 */
	async getNntpServers(): Promise<NntpServerConfig[]> {
		try {
			const configMap = await this.request<Record<string, string>>('config');
			const servers: NntpServerConfig[] = [];

			// Find all unique server indices (Server1, Server2, etc.)
			const serverIndices = new Set<number>();
			for (const key of Object.keys(configMap)) {
				const match = key.match(/^Server(\d+)\./);
				if (match) {
					serverIndices.add(parseInt(match[1], 10));
				}
			}

			// Parse each server's configuration
			for (const idx of Array.from(serverIndices).sort((a, b) => a - b)) {
				const prefix = `Server${idx}`;
				const host = configMap[`${prefix}.Host`];

				// Skip if no host configured
				if (!host) continue;

				// Parse encryption setting (0=none, 1=TLS, 2=TLS forced)
				const encryption = parseInt(configMap[`${prefix}.Encryption`] || '0', 10);

				servers.push({
					name: configMap[`${prefix}.Name`] || `Server ${idx}`,
					host,
					port: parseInt(configMap[`${prefix}.Port`] || '563', 10),
					useSsl: encryption > 0,
					username: configMap[`${prefix}.Username`] || undefined,
					password: configMap[`${prefix}.Password`] || undefined,
					maxConnections: parseInt(configMap[`${prefix}.Connections`] || '8', 10),
					// Level is priority (0 = main, higher = backup)
					priority: parseInt(configMap[`${prefix}.Level`] || '0', 10),
					enabled: configMap[`${prefix}.Active`] === 'yes'
				});
			}

			logger.info({ count: servers.length }, '[NZBGet] Fetched NNTP servers');
			return servers;
		} catch (error) {
			logger.error(
				{
					error: error instanceof Error ? error.message : 'Unknown error'
				},
				'[NZBGet] Failed to fetch NNTP servers'
			);
			return [];
		}
	}

	private mapPriority(priority?: 'normal' | 'high' | 'force'): number {
		switch (priority) {
			case 'force':
				return 100; // Force
			case 'high':
				return 50; // High
			case 'normal':
			default:
				return 0; // Normal
		}
	}

	private mapStatus(status: string): DownloadInfo['status'] {
		switch (status) {
			case 'DOWNLOADING':
				return 'downloading';
			case 'PAUSED':
				return 'paused';
			case 'QUEUED':
				return 'queued';
			case 'SUCCESS':
				return 'completed';
			case 'FAILURE':
			case 'DELETED':
				return 'error';
			default:
				return 'downloading';
		}
	}
}
