/**
 * Transmission RPC client implementation.
 *
 * API reference:
 * https://github.com/transmission/transmission/blob/main/docs/rpc-spec.md
 */

import type { ConnectionTestResult } from '#lib/types/downloadClient.js';
import type {
	AddDownloadOptions,
	DownloadClientConfig,
	DownloadFileInfo,
	DownloadInfo,
	IDownloadClient
} from '../core/interfaces';
import { getBasicAuthHeader, joinCategoryPath } from '../core/client-utils.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'imports' as const });

interface TransmissionRpcResponse<T> {
	result: string;
	arguments?: T;
}

interface TransmissionSessionInfo {
	version?: string;
	'rpc-version'?: number;
	'download-dir'?: string;
	'idle-seeding-limit-enabled': boolean;
	'idle-seeding-limit': number;
	'seed-ratio-limited': boolean;
	'seed-ratio-limit': number;
}

interface TransmissionTorrent {
	id: number;
	name: string;
	hashString: string;
	percentDone: number;
	status: number;
	isFinished: boolean;
	totalSize: number;
	rateDownload: number;
	rateUpload: number;
	eta: number;
	downloadDir: string;
	labels?: string[];
	addedDate?: number;
	doneDate?: number;
	secondsSeeding?: number;
	uploadRatio?: number;
	seedRatioLimit?: number;
	seedRatioMode?: TransmissionRatioMode;
	seedIdleLimit?: number;
	seedIdleMode?: TransmissionIdleMode;
	error?: number;
	errorString?: string;
}

interface TransmissionTorrentGetResponse {
	torrents: TransmissionTorrent[];
}

interface TransmissionTorrentAddResult {
	id: number;
	name: string;
	hashString: string;
}

interface TransmissionTorrentAddResponse {
	'torrent-added'?: TransmissionTorrentAddResult;
	'torrent-duplicate'?: TransmissionTorrentAddResult;
}

type TransmissionTorrentStatus = DownloadInfo['status'];
type TransmissionId = number | string;

enum TransmissionRatioMode {
	/* follow the global settings */
	GLOBAL = 0,
	/* override the global settings, seeding until a certain ratio */
	SINGLE = 1,
	/* override the global settings, seeding regardless of ratio */
	UNLIMITED = 2
}

enum TransmissionIdleMode {
	/* follow the global settings */
	GLOBAL = 0,
	/* override the global settings, seeding until a idle time */
	SINGLE = 1,
	/* override the global settings, seeding regardless of activity */
	UNLIMITED = 2
}

const TORRENT_FIELDS = [
	'id',
	'name',
	'hashString',
	'percentDone',
	'status',
	'isFinished',
	'totalSize',
	'rateDownload',
	'rateUpload',
	'eta',
	'downloadDir',
	'labels',
	'addedDate',
	'doneDate',
	'secondsSeeding',
	'uploadRatio',
	'seedRatioLimit',
	'seedRatioMode',
	'seedIdleLimit',
	'seedIdleMode',
	'error',
	'errorString'
];

const SESSION_FIELDS = [
	'version',
	'rpc-version',
	'download-dir',
	'idle-seeding-limit-enabled',
	'idle-seeding-limit',
	'seed-ratio-limited',
	'seed-ratio-limit'
];

function mapTransmissionStatus(
	status: number,
	progress: number,
	errorCode?: number
): TransmissionTorrentStatus {
	// Transmission error codes:
	//   1 = tracker warning (transient, e.g. can't reach tracker)
	//   2 = tracker error  (transient, e.g. HTTP 520, "not registered")
	//   3 = local error    (persistent, e.g. missing files, bad permissions)
	// Only code 3 represents a genuinely broken torrent. Tracker errors are
	// transient and should not override the actual download state — the torrent
	// may still be downloading from peers (DHT/PEX) or simply paused by the user.
	if (errorCode === 3) {
		return 'error';
	}

	switch (status) {
		case 4:
			return 'downloading';
		case 6:
			return 'seeding';
		case 0:
			return progress >= 1 ? 'completed' : 'paused';
		case 1:
		case 2:
		case 3:
		case 5:
			return 'queued';
		default:
			return progress >= 1 ? 'completed' : 'downloading';
	}
}

function normalizeProgress(value: number | undefined): number {
	if (typeof value !== 'number' || Number.isNaN(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

function normalizeTimestamp(value: number | undefined): Date | undefined {
	if (!value || value <= 0) return undefined;
	return new Date(value * 1000);
}

export class TransmissionClient implements IDownloadClient {
	readonly implementation = 'transmission';

	private config: DownloadClientConfig;
	private sessionId: string | null = null;

	// Cache for session info (refresh every 5 minutes)
	private sessionInfoCache: { prefs: TransmissionSessionInfo; expiry: number } | null = null;
	private readonly SESSION_INFO_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

	constructor(config: DownloadClientConfig) {
		this.config = config;
	}

	/**
	 * Get session info with caching
	 */
	private async getSessionInfo(forceUpdate: boolean = false): Promise<TransmissionSessionInfo> {
		if (!forceUpdate && this.sessionInfoCache && Date.now() < this.sessionInfoCache.expiry) {
			return this.sessionInfoCache.prefs;
		}

		const prefs = await this.rpcRequest<TransmissionSessionInfo>('session-get', {
			fields: SESSION_FIELDS
		});
		this.sessionInfoCache = {
			prefs,
			expiry: Date.now() + this.SESSION_INFO_CACHE_TTL
		};
		return prefs;
	}

	private get rpcUrl(): string {
		const protocol = this.config.useSsl ? 'https' : 'http';
		const base = `${protocol}://${this.config.host}:${this.config.port}`;
		const urlBase = this.config.urlBase?.trim().replace(/^\/+|\/+$/g, '');

		if (!urlBase) {
			return `${base}/transmission/rpc`;
		}

		if (/\/rpc$/i.test(urlBase)) {
			return `${base}/${urlBase}`;
		}

		if (/transmission$/i.test(urlBase)) {
			return `${base}/${urlBase}/rpc`;
		}

		return `${base}/${urlBase}/transmission/rpc`;
	}

	private getAuthHeader(): string | null {
		return getBasicAuthHeader(this.config.username, this.config.password);
	}

	private toTransmissionId(id: string): TransmissionId {
		if (/^\d+$/.test(id)) {
			return Number(id);
		}
		return id;
	}

	private buildContentPath(downloadDir: string, name: string): string {
		const normalized = downloadDir.replace(/\/+$/, '');
		if (!normalized) return name;
		return `${normalized}/${name}`;
	}

	private mapTorrent(torrent: TransmissionTorrent, session: TransmissionSessionInfo): DownloadInfo {
		const progress = normalizeProgress(torrent.percentDone);
		const status = mapTransmissionStatus(torrent.status, progress, torrent.error);
		const category = torrent.labels?.[0];
		const eta = typeof torrent.eta === 'number' && torrent.eta >= 0 ? torrent.eta : undefined;
		const errorMessage =
			typeof torrent.error === 'number' && torrent.error > 0
				? torrent.errorString || 'Unknown error'
				: undefined;

		return {
			id: String(torrent.id),
			name: torrent.name || torrent.hashString,
			hash: torrent.hashString || String(torrent.id),
			progress,
			status,
			size: torrent.totalSize || 0,
			downloadSpeed: torrent.rateDownload || 0,
			uploadSpeed: torrent.rateUpload || 0,
			eta,
			savePath: torrent.downloadDir || '',
			contentPath: this.buildContentPath(torrent.downloadDir || '', torrent.name || ''),
			category,
			ratio: torrent.uploadRatio,
			addedOn: normalizeTimestamp(torrent.addedDate),
			completedOn: normalizeTimestamp(torrent.doneDate),
			seedingTime: torrent.secondsSeeding,
			ratioLimit: torrent.seedRatioLimit,
			// Transmission doesn't support seeding time limits, only idle time limits.
			// We map seedIdleLimit here for informational purposes, but it's not a true seeding time limit.
			seedingTimeLimit: torrent.seedIdleLimit,
			canMoveFiles: status !== 'downloading' && status !== 'seeding' && status !== 'queued',
			// A torrent is only removable once Transmission has stopped it (status
			// maps to 'completed') AND its seed limits are verifiably met. While it
			// is still seeding (status 'seeding') it is never removable — isFinished
			// alone stays true for the entire seeding phase and must not gate removal.
			canBeRemoved: status === 'completed' && this.hasReachedSeedLimit(torrent, session),
			errorMessage
		};
	}

	private hasReachedSeedLimit(
		torrent: TransmissionTorrent,
		session: TransmissionSessionInfo
	): boolean {
		const ratioLimit = this.resolveRatioLimit(torrent, session);
		if (ratioLimit !== null && (torrent.uploadRatio ?? 0) >= ratioLimit) {
			return true;
		}

		const idleLimit = this.resolveIdleLimit(torrent, session);
		if (idleLimit !== null && (torrent.secondsSeeding ?? 0) >= idleLimit) {
			return true;
		}

		return false;
	}

	private resolveRatioLimit(
		torrent: TransmissionTorrent,
		session: TransmissionSessionInfo
	): number | null {
		const mode = torrent.seedRatioMode ?? TransmissionRatioMode.GLOBAL;
		if (mode === TransmissionRatioMode.SINGLE) {
			return typeof torrent.seedRatioLimit === 'number' ? torrent.seedRatioLimit : null;
		}
		if (mode === TransmissionRatioMode.UNLIMITED) {
			return null;
		}
		return session['seed-ratio-limited'] ? session['seed-ratio-limit'] : null;
	}

	private resolveIdleLimit(
		torrent: TransmissionTorrent,
		session: TransmissionSessionInfo
	): number | null {
		const mode = torrent.seedIdleMode ?? TransmissionIdleMode.GLOBAL;
		if (mode === TransmissionIdleMode.SINGLE) {
			return typeof torrent.seedIdleLimit === 'number' ? torrent.seedIdleLimit : null;
		}
		if (mode === TransmissionIdleMode.UNLIMITED) {
			return null;
		}
		return session['idle-seeding-limit-enabled'] ? session['idle-seeding-limit'] : null;
	}

	private async rpcRequest<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
		const body = JSON.stringify({
			method,
			arguments: args
		});

		for (let attempt = 0; attempt < 2; attempt++) {
			const headers = new Headers({
				'Content-Type': 'application/json'
			});

			if (this.sessionId) {
				headers.set('X-Transmission-Session-Id', this.sessionId);
			}

			const auth = this.getAuthHeader();
			if (auth) {
				headers.set('Authorization', auth);
			}

			const response = await fetch(this.rpcUrl, {
				method: 'POST',
				headers,
				body
			});

			if (response.status === 409) {
				const nextSessionId = response.headers.get('X-Transmission-Session-Id');
				if (!nextSessionId) {
					throw new Error('Transmission session negotiation failed');
				}
				this.sessionId = nextSessionId;
				continue;
			}

			if (response.status === 401 || response.status === 403) {
				throw new Error('Transmission authentication failed: Invalid credentials');
			}

			if (!response.ok) {
				throw new Error(`Transmission API error: ${response.status} ${response.statusText}`);
			}

			let payload: TransmissionRpcResponse<T>;
			try {
				payload = (await response.json()) as TransmissionRpcResponse<T>;
			} catch {
				throw new Error('Transmission API returned invalid JSON response');
			}

			if (payload.result !== 'success') {
				throw new Error(`Transmission RPC error: ${payload.result}`);
			}

			return payload.arguments ?? ({} as T);
		}

		throw new Error('Transmission session negotiation failed');
	}

	async test(): Promise<ConnectionTestResult> {
		try {
			const [session, torrents] = await Promise.all([
				this.getSessionInfo(true),
				this.rpcRequest<{ torrents: Array<{ labels?: string[] }> }>('torrent-get', {
					fields: ['labels'],
					ids: 'recently-active'
				})
			]);

			const categories = Array.from(
				new Set(
					(torrents.torrents || [])
						.flatMap((torrent) => torrent.labels || [])
						.map((label) => label.trim())
						.filter((label) => label.length > 0)
				)
			).sort((a, b) => a.localeCompare(b));

			return {
				success: true,
				details: {
					version: session.version,
					apiVersion:
						typeof session['rpc-version'] === 'number' ? String(session['rpc-version']) : undefined,
					savePath: session['download-dir'],
					categories
				}
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	async addDownload(options: AddDownloadOptions): Promise<string> {
		const args: Record<string, unknown> = {};
		const selectedFileIndices = (options.fileSelection?.fileIndices || []).filter(
			(index) => Number.isInteger(index) && index >= 0
		);
		const allFileIndices = (options.fileSelection?.allFileIndices || []).filter(
			(index) => Number.isInteger(index) && index >= 0
		);
		if (
			options.fileSelection &&
			(selectedFileIndices.length === 0 || allFileIndices.length === 0)
		) {
			throw new Error('Transmission file selection requires valid file indices');
		}

		if (options.torrentFile) {
			args.metainfo = options.torrentFile.toString('base64');
		} else if (options.magnetUri) {
			args.filename = options.magnetUri;
		} else if (options.downloadUrl) {
			args.filename = options.downloadUrl;
		} else {
			throw new Error('Transmission requires magnet URI, torrent file, or download URL');
		}

		if (typeof options.paused === 'boolean') {
			args.paused = options.paused;
		}

		if (options.savePath) {
			args['download-dir'] = options.savePath;
		} else if (options.category?.trim()) {
			try {
				const derived = joinCategoryPath(await this.getDefaultSavePath(), options.category);
				if (derived) {
					args['download-dir'] = derived;
				}
			} catch (error) {
				// download-dir stays unset; the torrent lands in the client root
				// while recovery still assumes <base>/<category>/<name>, so this
				// degrades recovery silently unless logged.
				logger.warn(
					{ err: error, category: options.category },
					'[Transmission] Failed to resolve default save path; falling back to labels-only'
				);
			}
		}

		if (options.category?.trim()) {
			args.labels = [options.category.trim()];
		}

		if (options.priority === 'high' || options.priority === 'force') {
			args.bandwidthPriority = 1;
		}

		if (selectedFileIndices.length > 0) {
			args['files-wanted'] = selectedFileIndices;
			const keepSet = new Set(selectedFileIndices);
			const unwanted = allFileIndices.filter((index) => !keepSet.has(index));
			if (unwanted.length > 0) {
				args['files-unwanted'] = unwanted;
			}
		}

		const response = await this.rpcRequest<TransmissionTorrentAddResponse>('torrent-add', args);
		const added = response['torrent-added'];
		const duplicate = response['torrent-duplicate'];

		if (duplicate?.hashString) {
			const existingTorrent = await this.getDownload(duplicate.hashString);
			const error = new Error(
				`Torrent already exists in Transmission: ${duplicate.name || duplicate.hashString}`
			);
			(error as Error & { isDuplicate: boolean }).isDuplicate = true;
			if (existingTorrent) {
				(error as Error & { existingTorrent: DownloadInfo }).existingTorrent = existingTorrent;
			}
			throw error;
		}

		if (!added) {
			throw new Error('Transmission did not return torrent add result');
		}

		const torrentId = added.hashString || String(added.id);
		await this.setSeedingConfig(torrentId, {
			ratioLimit: options.seedRatioLimit,
			seedingTimeLimit: options.seedTimeLimit
		});

		return torrentId;
	}

	async getDownloads(category?: string): Promise<DownloadInfo[]> {
		const [response, session] = await Promise.all([
			this.rpcRequest<TransmissionTorrentGetResponse>('torrent-get', {
				fields: TORRENT_FIELDS
			}),
			this.getSessionInfo()
		]);

		let downloads = (response.torrents || []).map((torrent) => this.mapTorrent(torrent, session));
		if (category?.trim()) {
			const needle = category.trim().toLowerCase();
			downloads = downloads.filter((download) => download.category?.toLowerCase() === needle);
		}

		return downloads;
	}

	async getDownload(id: string): Promise<DownloadInfo | null> {
		const [response, session] = await Promise.all([
			this.rpcRequest<TransmissionTorrentGetResponse>('torrent-get', {
				fields: TORRENT_FIELDS,
				ids: [this.toTransmissionId(id)]
			}),
			this.getSessionInfo()
		]);

		const torrent = response.torrents?.[0];
		return torrent ? this.mapTorrent(torrent, session) : null;
	}

	async removeDownload(id: string, deleteFiles: boolean = false): Promise<void> {
		await this.rpcRequest<Record<string, unknown>>('torrent-remove', {
			ids: [this.toTransmissionId(id)],
			'delete-local-data': deleteFiles
		});
	}

	async pauseDownload(id: string): Promise<void> {
		await this.rpcRequest<Record<string, unknown>>('torrent-stop', {
			ids: [this.toTransmissionId(id)]
		});
	}

	async resumeDownload(id: string): Promise<void> {
		await this.rpcRequest<Record<string, unknown>>('torrent-start', {
			ids: [this.toTransmissionId(id)]
		});
	}

	async getDefaultSavePath(): Promise<string> {
		const session = await this.getSessionInfo();
		return session['download-dir'] || '';
	}

	async getCategories(): Promise<string[]> {
		const response = await this.rpcRequest<{ torrents: Array<{ labels?: string[] }> }>(
			'torrent-get',
			{
				fields: ['labels']
			}
		);

		return Array.from(
			new Set(
				(response.torrents || [])
					.flatMap((torrent) => torrent.labels || [])
					.map((label) => label.trim())
					.filter((label) => label.length > 0)
			)
		).sort((a, b) => a.localeCompare(b));
	}

	async ensureCategory(_name: string, _savePath?: string): Promise<void> {
		// Transmission does not support explicit category creation.
		// Labels are applied when adding/updating torrents.
	}

	async markItemAsImported(id: string, importedCategory?: string): Promise<void> {
		if (!importedCategory?.trim()) {
			return;
		}

		await this.rpcRequest<Record<string, unknown>>('torrent-set', {
			ids: [this.toTransmissionId(id)],
			labels: [importedCategory.trim()]
		});
	}

	async setSeedingConfig(
		id: string,
		config: { ratioLimit?: number; seedingTimeLimit?: number }
	): Promise<void> {
		const args: Record<string, unknown> = {
			ids: [this.toTransmissionId(id)]
		};

		if (typeof config.ratioLimit === 'number') {
			if (config.ratioLimit < 0) {
				args.seedRatioMode = TransmissionRatioMode.UNLIMITED;
			} else {
				args.seedRatioMode = TransmissionRatioMode.SINGLE;
				args.seedRatioLimit = config.ratioLimit;
			}
		}

		if (typeof config.seedingTimeLimit === 'number') {
			if (config.seedingTimeLimit < 0) {
				args.seedIdleMode = TransmissionIdleMode.UNLIMITED;
			} else {
				args.seedIdleMode = TransmissionIdleMode.SINGLE;
				args.seedIdleLimit = Math.max(0, Math.round(config.seedingTimeLimit));
			}
		}

		if (Object.keys(args).length === 1) {
			return;
		}

		await this.rpcRequest<Record<string, unknown>>('torrent-set', args);
	}

	async getBasePath(): Promise<string | undefined> {
		const savePath = await this.getDefaultSavePath();
		return savePath || undefined;
	}

	async getFiles(id: string): Promise<DownloadFileInfo[]> {
		const response = await this.rpcRequest<{
			torrents: Array<{ files?: Array<{ name: string; length: number }> }>;
		}>('torrent-get', {
			fields: ['files'],
			ids: [this.toTransmissionId(id)]
		});

		const torrent = response.torrents?.[0];
		if (!torrent?.files) return [];

		return torrent.files.map((f, index) => ({
			index,
			name: f.name,
			size: f.length
		}));
	}
}
