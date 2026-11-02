/**
 * Aria2 JSON-RPC client implementation.
 *
 * API reference:
 * https://aria2.github.io/manual/en/html/aria2c.html#rpc-interface
 */

import type { ConnectionTestResult } from '#lib/types/downloadClient.js';
import type {
	AddDownloadOptions,
	DownloadClientConfig,
	DownloadInfo,
	IDownloadClient
} from '../core/interfaces';
import { getBasicAuthHeader } from '../core/client-utils.js';
import {
	buildMagnetFromInfoHash,
	extractInfoHashFromMagnet,
	parseTorrentFile
} from '../utils/torrentParser';

interface Aria2VersionResult {
	version?: string;
	enabledFeatures?: string[];
}

interface Aria2RpcError {
	code: number;
	message: string;
}

interface Aria2RpcResponse<T> {
	id?: string;
	jsonrpc?: string;
	result?: T;
	error?: Aria2RpcError;
}

interface Aria2File {
	path?: string;
}

interface Aria2BittorrentInfo {
	name?: string;
}

interface Aria2BittorrentMeta {
	info?: Aria2BittorrentInfo;
	infoHash?: string;
}

interface Aria2DownloadStatus {
	gid: string;
	status: string;
	totalLength?: string;
	completedLength?: string;
	downloadSpeed?: string;
	uploadSpeed?: string;
	uploadLength?: string;
	eta?: string;
	dir?: string;
	files?: Aria2File[];
	bittorrent?: Aria2BittorrentMeta;
	errorMessage?: string;
}

type Aria2Status = DownloadInfo['status'];

const ARIA2_FIELDS = [
	'gid',
	'status',
	'totalLength',
	'completedLength',
	'downloadSpeed',
	'uploadSpeed',
	'uploadLength',
	'eta',
	'dir',
	'files',
	'bittorrent',
	'errorMessage'
];

function toNumber(value: string | number | undefined): number {
	if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
	if (!value) return 0;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function toDate(value: number | undefined): Date | undefined {
	if (!value || value <= 0) return undefined;
	return new Date(value * 1000);
}

function fileBaseName(pathValue: string): string {
	if (!pathValue) return '';
	const normalized = pathValue.replace(/\/+$/, '');
	const parts = normalized.split('/');
	return parts[parts.length - 1] || normalized;
}

function mapAria2Status(status: string, progress: number, uploadSpeed: number): Aria2Status {
	switch (status) {
		case 'active':
			if (progress >= 1 && uploadSpeed > 0) {
				return 'seeding';
			}
			return 'downloading';
		case 'waiting':
			return 'queued';
		case 'paused':
			return 'paused';
		case 'error':
			return 'error';
		case 'complete':
			return 'completed';
		case 'removed':
			return 'completed';
		default:
			return progress >= 1 ? 'completed' : 'downloading';
	}
}

export class Aria2Client implements IDownloadClient {
	readonly implementation = 'aria2';

	private config: DownloadClientConfig;
	private requestId = 1;

	constructor(config: DownloadClientConfig) {
		this.config = config;
	}

	private get rpcUrl(): string {
		const protocol = this.config.useSsl ? 'https' : 'http';
		const base = `${protocol}://${this.config.host}:${this.config.port}`;
		const urlBase = this.config.urlBase?.trim().replace(/^\/+|\/+$/g, '');

		if (!urlBase) {
			return `${base}/jsonrpc`;
		}

		if (/jsonrpc$/i.test(urlBase)) {
			return `${base}/${urlBase}`;
		}

		return `${base}/${urlBase}/jsonrpc`;
	}

	private getAuthHeader(): string | null {
		return getBasicAuthHeader(this.config.username, this.config.password);
	}

	private buildRpcParams(params: unknown[]): unknown[] {
		const token = !this.config.username ? this.config.password?.trim() : undefined;
		if (token) {
			return [`token:${token}`, ...params];
		}
		return params;
	}

	private async rpcRequest<T>(method: string, params: unknown[] = []): Promise<T> {
		const headers = new Headers({
			'Content-Type': 'application/json'
		});

		const authHeader = this.getAuthHeader();
		if (authHeader) {
			headers.set('Authorization', authHeader);
		}

		const payload = {
			jsonrpc: '2.0',
			id: String(this.requestId++),
			method,
			params: this.buildRpcParams(params)
		};

		const response = await fetch(this.rpcUrl, {
			method: 'POST',
			headers,
			body: JSON.stringify(payload)
		});

		if (response.status === 401 || response.status === 403) {
			throw new Error('Aria2 authentication failed: Invalid credentials or RPC secret');
		}

		if (!response.ok) {
			throw new Error(`Aria2 API error: ${response.status} ${response.statusText}`);
		}

		let json: Aria2RpcResponse<T>;
		try {
			json = (await response.json()) as Aria2RpcResponse<T>;
		} catch {
			throw new Error('Aria2 API returned an invalid JSON response');
		}

		if (json.error) {
			throw new Error(`Aria2 RPC error (${json.error.code}): ${json.error.message}`);
		}

		return json.result as T;
	}

	private mapDownload(item: Aria2DownloadStatus): DownloadInfo {
		const totalLength = toNumber(item.totalLength);
		const completedLength = toNumber(item.completedLength);
		const progress = totalLength > 0 ? Math.max(0, Math.min(1, completedLength / totalLength)) : 0;
		const downloadSpeed = toNumber(item.downloadSpeed);
		const uploadSpeed = toNumber(item.uploadSpeed);
		const uploadLength = toNumber(item.uploadLength);
		const etaRaw = toNumber(item.eta);
		const eta = etaRaw >= 0 ? etaRaw : undefined;
		const torrentName = item.bittorrent?.info?.name;
		const firstPath = item.files?.[0]?.path;
		const fallbackName = firstPath ? fileBaseName(firstPath) : item.gid;
		const name = torrentName || fallbackName;
		const savePath = item.dir || '';
		const contentPath = firstPath || (savePath ? `${savePath.replace(/\/+$/, '')}/${name}` : name);
		const hash = item.bittorrent?.infoHash?.toLowerCase() || item.gid;
		const status = mapAria2Status(item.status, progress, uploadSpeed);
		const ratio = totalLength > 0 ? uploadLength / totalLength : undefined;

		return {
			id: item.gid,
			name,
			hash,
			progress,
			status,
			size: totalLength,
			downloadSpeed,
			uploadSpeed,
			eta,
			savePath,
			contentPath,
			ratio,
			addedOn: toDate(undefined),
			completedOn: undefined,
			canMoveFiles: status !== 'downloading' && status !== 'seeding' && status !== 'queued',
			// aria2 keeps finished torrents in 'active' (seeding) until their seed
			// limits are met, then moves them to 'complete'. Only then are they
			// safe to remove from the client.
			canBeRemoved: status === 'completed',
			errorMessage: item.errorMessage
		};
	}

	private async listAllDownloads(): Promise<Aria2DownloadStatus[]> {
		const [active, waiting, stopped] = await Promise.all([
			this.rpcRequest<Aria2DownloadStatus[]>('aria2.tellActive', [ARIA2_FIELDS]),
			this.rpcRequest<Aria2DownloadStatus[]>('aria2.tellWaiting', [0, 1000, ARIA2_FIELDS]),
			this.rpcRequest<Aria2DownloadStatus[]>('aria2.tellStopped', [0, 1000, ARIA2_FIELDS])
		]);

		return [...(active || []), ...(waiting || []), ...(stopped || [])];
	}

	private async extractInfoHash(options: AddDownloadOptions): Promise<string | null> {
		if (options.infoHash?.trim()) {
			return options.infoHash.trim().toLowerCase();
		}

		if (options.magnetUri) {
			return (await extractInfoHashFromMagnet(options.magnetUri)) ?? null;
		}

		if (options.torrentFile) {
			const parsed = await parseTorrentFile(options.torrentFile);
			if (parsed.success && parsed.infoHash) {
				return parsed.infoHash.toLowerCase();
			}
		}

		if (options.downloadUrl) {
			const hashMatch = options.downloadUrl.match(/\/([a-fA-F0-9]{40})(?:[/?.]|$)/i);
			if (hashMatch) {
				return hashMatch[1].toLowerCase();
			}
		}

		return null;
	}

	private async findDownloadByHash(infoHash: string): Promise<DownloadInfo | null> {
		const all = await this.listAllDownloads();
		const normalized = infoHash.toLowerCase();
		const found = all.find((item) => item.bittorrent?.infoHash?.toLowerCase() === normalized);
		return found ? this.mapDownload(found) : null;
	}

	async test(): Promise<ConnectionTestResult> {
		try {
			const [version, globalOptions] = await Promise.all([
				this.rpcRequest<Aria2VersionResult>('aria2.getVersion'),
				this.rpcRequest<Record<string, string>>('aria2.getGlobalOption')
			]);

			return {
				success: true,
				details: {
					version: version?.version,
					apiVersion: 'JSON-RPC 2.0',
					savePath: globalOptions?.dir,
					categories: []
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
		const infoHash = await this.extractInfoHash(options);
		if (infoHash) {
			const existing = await this.findDownloadByHash(infoHash);
			if (existing) {
				const duplicateError = new Error(
					`Torrent already exists in Aria2: ${existing.name} (${existing.status}, ${Math.round(existing.progress * 100)}%)`
				);
				(duplicateError as Error & { existingTorrent: DownloadInfo }).existingTorrent = existing;
				(duplicateError as Error & { isDuplicate: boolean }).isDuplicate = true;
				throw duplicateError;
			}
		}

		const rpcOptions: Record<string, string> = {};
		if (options.savePath) {
			rpcOptions.dir = options.savePath;
		}
		if (options.paused) {
			rpcOptions.pause = 'true';
		}
		if (typeof options.seedRatioLimit === 'number') {
			rpcOptions['seed-ratio'] = String(options.seedRatioLimit);
		}
		if (typeof options.seedTimeLimit === 'number') {
			rpcOptions['seed-time'] = String(Math.max(0, Math.round(options.seedTimeLimit)));
		}

		let gid: string;

		if (options.torrentFile) {
			gid = await this.rpcRequest<string>('aria2.addTorrent', [
				options.torrentFile.toString('base64'),
				[],
				rpcOptions
			]);
		} else {
			let uri = options.magnetUri;
			if (!uri && options.infoHash) {
				uri = buildMagnetFromInfoHash(options.infoHash);
			}
			if (!uri && options.downloadUrl) {
				uri = options.downloadUrl;
			}
			if (!uri) {
				throw new Error('Aria2 requires magnet URI, torrent file, info hash, or download URL');
			}

			gid = await this.rpcRequest<string>('aria2.addUri', [[uri], rpcOptions]);
		}

		return infoHash || gid;
	}

	async getDownloads(category?: string): Promise<DownloadInfo[]> {
		const downloads = (await this.listAllDownloads()).map((item) => this.mapDownload(item));
		if (!category?.trim()) {
			return downloads;
		}

		const needle = category.trim().toLowerCase();
		return downloads.filter((download) => download.category?.toLowerCase() === needle);
	}

	async getDownload(id: string): Promise<DownloadInfo | null> {
		if (/^[a-f0-9]{16}$/i.test(id)) {
			try {
				const status = await this.rpcRequest<Aria2DownloadStatus>('aria2.tellStatus', [
					id,
					ARIA2_FIELDS
				]);
				return this.mapDownload(status);
			} catch {
				return null;
			}
		}

		if (/^[a-f0-9]{40}$/i.test(id)) {
			return this.findDownloadByHash(id);
		}

		const all = await this.getDownloads();
		return all.find((download) => download.id === id || download.hash === id) ?? null;
	}

	async removeDownload(id: string, _deleteFiles: boolean = false): Promise<void> {
		const target = await this.getDownload(id);
		const gid = target?.id || id;

		try {
			await this.rpcRequest<string>('aria2.remove', [gid]);
		} catch {
			await this.rpcRequest<string>('aria2.forceRemove', [gid]);
		}
	}

	async pauseDownload(id: string): Promise<void> {
		const target = await this.getDownload(id);
		const gid = target?.id || id;
		await this.rpcRequest<string>('aria2.pause', [gid]);
	}

	async resumeDownload(id: string): Promise<void> {
		const target = await this.getDownload(id);
		const gid = target?.id || id;
		await this.rpcRequest<string>('aria2.unpause', [gid]);
	}

	async getDefaultSavePath(): Promise<string> {
		const options = await this.rpcRequest<Record<string, string>>('aria2.getGlobalOption');
		return options?.dir || '';
	}

	async getCategories(): Promise<string[]> {
		return [];
	}

	async ensureCategory(_name: string, _savePath?: string): Promise<void> {
		// Aria2 has no category concept.
	}

	async setSeedingConfig(
		id: string,
		config: { ratioLimit?: number; seedingTimeLimit?: number }
	): Promise<void> {
		const target = await this.getDownload(id);
		const gid = target?.id || id;
		const options: Record<string, string> = {};

		if (typeof config.ratioLimit === 'number') {
			options['seed-ratio'] = String(config.ratioLimit);
		}

		if (typeof config.seedingTimeLimit === 'number') {
			options['seed-time'] = String(Math.max(0, Math.round(config.seedingTimeLimit)));
		}

		if (Object.keys(options).length === 0) {
			return;
		}

		await this.rpcRequest<string>('aria2.changeOption', [gid, options]);
	}

	async getBasePath(): Promise<string | undefined> {
		const path = await this.getDefaultSavePath();
		return path || undefined;
	}
}
