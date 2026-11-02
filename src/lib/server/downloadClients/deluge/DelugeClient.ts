/**
 * Deluge Web API client implementation.
 *
 * API reference:
 * https://deluge.readthedocs.io/en/latest/reference/webapi.html
 */

import type { ConnectionTestResult } from '#lib/types/downloadClient.js';
import type {
	AddDownloadOptions,
	DownloadClientConfig,
	DownloadInfo,
	IDownloadClient
} from '../core/interfaces';
import { getBasicAuthHeader, joinCategoryPath } from '../core/client-utils.js';
import {
	buildMagnetFromInfoHash,
	extractInfoHashFromMagnet,
	parseTorrentFile
} from '../utils/torrentParser';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'imports' as const });

interface DelugeJsonError {
	code?: number;
	message?: string;
}

interface DelugeJsonResponse<T> {
	id?: number;
	result: T;
	error?: DelugeJsonError | null;
}

interface DelugeUpdateUiResponse {
	torrents?: Record<string, DelugeTorrentInfo>;
}

interface DelugeTorrentInfo {
	name?: string;
	total_size?: number;
	total_done?: number;
	progress?: number;
	state?: string;
	download_payload_rate?: number;
	upload_payload_rate?: number;
	eta?: number;
	save_path?: string;
	label?: string;
	time_added?: number;
	finished_time?: number;
	seeding_time?: number;
	ratio?: number;
	stop_at_ratio?: boolean;
	stop_ratio?: number;
	remove_at_ratio?: boolean;
	hash?: string;
	error?: string;
}

type DelugeStatus = DownloadInfo['status'];

const DELUGE_FIELDS = [
	'name',
	'total_size',
	'total_done',
	'progress',
	'state',
	'download_payload_rate',
	'upload_payload_rate',
	'eta',
	'save_path',
	'label',
	'time_added',
	'finished_time',
	'seeding_time',
	'ratio',
	'stop_at_ratio',
	'stop_ratio',
	'remove_at_ratio',
	'hash',
	'error'
];

function mapDelugeState(state: string | undefined, progress: number): DelugeStatus {
	const normalized = (state || '').toLowerCase();

	if (normalized.includes('error')) return 'error';
	if (normalized.includes('seeding')) return 'seeding';
	if (normalized.includes('download')) return 'downloading';
	if (normalized.includes('queue')) return 'queued';
	if (normalized.includes('check')) return 'queued';
	if (normalized.includes('pause')) return 'paused';
	if (normalized.includes('allocat')) return 'queued';
	if (normalized.includes('move')) return 'queued';

	return progress >= 1 ? 'completed' : 'paused';
}

function toDate(value: number | undefined): Date | undefined {
	if (!value || value <= 0) return undefined;
	return new Date(value * 1000);
}

function toNumber(value: number | undefined): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class DelugeClient implements IDownloadClient {
	readonly implementation = 'deluge';

	private config: DownloadClientConfig;
	private sessionCookie: string | null = null;
	private requestId = 1;
	private connected = false;

	constructor(config: DownloadClientConfig) {
		this.config = config;
	}

	private get apiUrl(): string {
		const protocol = this.config.useSsl ? 'https' : 'http';
		const base = `${protocol}://${this.config.host}:${this.config.port}`;
		const urlBase = this.config.urlBase?.trim().replace(/^\/+|\/+$/g, '');

		if (!urlBase) {
			return `${base}/json`;
		}

		if (/json$/i.test(urlBase)) {
			return `${base}/${urlBase}`;
		}

		return `${base}/${urlBase}/json`;
	}

	private getAuthHeader(): string | null {
		return getBasicAuthHeader(this.config.username, this.config.password);
	}

	private async request<T>(method: string, params: unknown[] = []): Promise<T> {
		const headers = new Headers({
			'Content-Type': 'application/json'
		});

		if (this.sessionCookie) {
			headers.set('Cookie', this.sessionCookie);
		}

		const authHeader = this.getAuthHeader();
		if (authHeader) {
			headers.set('Authorization', authHeader);
		}

		const response = await fetch(this.apiUrl, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				method,
				params,
				id: this.requestId++
			})
		});

		const setCookie = response.headers.get('set-cookie');
		if (setCookie) {
			this.sessionCookie = setCookie.split(';')[0];
		}

		if (response.status === 401 || response.status === 403) {
			throw new Error('Deluge authentication failed: Invalid credentials');
		}

		if (!response.ok) {
			throw new Error(`Deluge API error: ${response.status} ${response.statusText}`);
		}

		let payload: DelugeJsonResponse<T>;
		try {
			payload = (await response.json()) as DelugeJsonResponse<T>;
		} catch {
			throw new Error('Deluge API returned an invalid JSON response');
		}

		if (payload.error) {
			const message = payload.error.message || 'Unknown Deluge API error';
			throw new Error(message);
		}

		return payload.result;
	}

	private async ensureConnected(forceReconnect = false): Promise<void> {
		if (this.connected && !forceReconnect) {
			return;
		}

		const password = this.config.password?.trim();
		if (!password) {
			throw new Error('Deluge password is required for Web API authentication');
		}

		const authenticated = await this.request<boolean>('auth.login', [password]);
		if (!authenticated) {
			throw new Error('Deluge authentication failed: Invalid password');
		}

		const isConnected = await this.request<boolean>('web.connected');
		if (!isConnected) {
			const hosts = await this.request<Array<[string, string, number, string]>>('web.get_hosts');
			if (!hosts || hosts.length === 0) {
				throw new Error('Deluge daemon is not connected and no hosts are configured');
			}

			const hostId = hosts[0][0];
			const connected = await this.request<boolean>('web.connect', [hostId]);
			if (!connected) {
				throw new Error('Failed to connect Deluge Web UI to daemon');
			}
		}

		this.connected = true;
	}

	private shouldReconnect(error: unknown): boolean {
		const message =
			error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
		return (
			message.includes('not authenticated') ||
			message.includes('invalid session') ||
			message.includes('unknown method') ||
			message.includes('not connected')
		);
	}

	private async call<T>(method: string, params: unknown[] = []): Promise<T> {
		await this.ensureConnected();
		try {
			return await this.request<T>(method, params);
		} catch (error) {
			if (this.shouldReconnect(error)) {
				this.connected = false;
				await this.ensureConnected(true);
				return this.request<T>(method, params);
			}
			throw error;
		}
	}

	private hasReachedSeedLimit(torrent: DelugeTorrentInfo): boolean {
		return (
			torrent.stop_at_ratio === true &&
			typeof torrent.ratio === 'number' &&
			typeof torrent.stop_ratio === 'number' &&
			torrent.ratio >= torrent.stop_ratio
		);
	}

	private mapTorrent(hash: string, torrent: DelugeTorrentInfo): DownloadInfo {
		const progressPercent = toNumber(torrent.progress);
		const progress = Math.max(0, Math.min(1, progressPercent / 100));
		const size = toNumber(torrent.total_size);
		const status = mapDelugeState(torrent.state, progress);
		const savePath = torrent.save_path || '';
		const name = torrent.name || hash;
		const contentPath = savePath ? `${savePath.replace(/\/+$/, '')}/${name}` : name;
		const etaValue = toNumber(torrent.eta);
		const eta = etaValue >= 0 ? etaValue : undefined;
		const ratio = typeof torrent.ratio === 'number' ? torrent.ratio : undefined;

		return {
			id: hash,
			name,
			hash,
			progress,
			status,
			size,
			downloadSpeed: toNumber(torrent.download_payload_rate),
			uploadSpeed: toNumber(torrent.upload_payload_rate),
			eta,
			savePath,
			contentPath,
			category: torrent.label || undefined,
			ratio,
			addedOn: toDate(torrent.time_added),
			completedOn: toDate(torrent.finished_time),
			seedingTime: typeof torrent.seeding_time === 'number' ? torrent.seeding_time : undefined,
			ratioLimit: torrent.stop_at_ratio ? torrent.stop_ratio : undefined,
			canMoveFiles: status !== 'downloading' && status !== 'seeding' && status !== 'queued',
			canBeRemoved:
				status !== 'downloading' && (status !== 'seeding' || this.hasReachedSeedLimit(torrent)),
			errorMessage: torrent.error || undefined
		};
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

	async test(): Promise<ConnectionTestResult> {
		try {
			await this.ensureConnected();

			const [configValues, categories] = await Promise.all([
				this.call<Record<string, string>>('core.get_config_values', [['download_location']]),
				this.getCategories()
			]);

			let version: string | undefined;
			try {
				version = await this.call<string>('core.get_libtorrent_version');
			} catch {
				version = undefined;
			}

			return {
				success: true,
				details: {
					version: version ? `Deluge (${version})` : 'Deluge',
					savePath: configValues?.download_location,
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
		const infoHash = await this.extractInfoHash(options);
		if (infoHash) {
			const existing = await this.getDownload(infoHash);
			if (existing) {
				const duplicateError = new Error(
					`Torrent already exists in Deluge: ${existing.name} (${existing.status}, ${Math.round(existing.progress * 100)}%)`
				);
				(duplicateError as Error & { existingTorrent: DownloadInfo }).existingTorrent = existing;
				(duplicateError as Error & { isDuplicate: boolean }).isDuplicate = true;
				throw duplicateError;
			}
		}

		const addOptions: Record<string, unknown> = {};
		if (options.savePath) {
			addOptions.download_location = options.savePath;
		} else if (options.category?.trim()) {
			try {
				const derived = joinCategoryPath(await this.getDefaultSavePath(), options.category);
				if (derived) {
					addOptions.download_location = derived;
				}
			} catch (error) {
				// download_location stays unset; the label still gets applied below.
				logger.warn(
					{ err: error, category: options.category },
					'[Deluge] Failed to resolve default save path; falling back to label-only'
				);
			}
		}
		if (options.category?.trim()) {
			try {
				await this.ensureCategory(options.category.trim());
			} catch {
				// Label plugin is optional — never block the download on it.
			}
		}
		if (options.paused) {
			addOptions.add_paused = true;
		}
		if (typeof options.seedRatioLimit === 'number') {
			addOptions.stop_at_ratio = options.seedRatioLimit >= 0;
			if (options.seedRatioLimit >= 0) {
				addOptions.stop_ratio = options.seedRatioLimit;
			}
		}

		let hash: string | null;

		if (options.torrentFile) {
			hash = await this.call<string | null>('core.add_torrent_file', [
				`${Date.now()}.torrent`,
				options.torrentFile.toString('base64'),
				addOptions
			]);
		} else if (options.magnetUri) {
			hash = await this.call<string | null>('core.add_torrent_magnet', [
				options.magnetUri,
				addOptions
			]);
		} else if (options.infoHash) {
			const magnet = buildMagnetFromInfoHash(options.infoHash);
			hash = await this.call<string | null>('core.add_torrent_magnet', [magnet, addOptions]);
		} else if (options.downloadUrl) {
			hash = await this.call<string | null>('core.add_torrent_url', [
				options.downloadUrl,
				addOptions
			]);
		} else {
			throw new Error('Deluge requires magnet URI, torrent file, info hash, or download URL');
		}

		const resultHash = (hash || infoHash || '').toLowerCase();
		if (!resultHash) {
			throw new Error('Deluge did not return a torrent hash');
		}

		if (options.category?.trim()) {
			try {
				// The classic label plugin has no label add-option; core.add_torrent_*
				// silently ignores one. label.set_torrent after the add is the real
				// mechanism (same one markItemAsImported already uses below).
				await this.call<unknown>('label.set_torrent', [resultHash, options.category.trim()]);
			} catch {
				// Label plugin is optional; never block the download on it.
			}
		}

		if (options.priority === 'force') {
			await this.resumeDownload(resultHash);
		}

		return resultHash;
	}

	async getDownloads(category?: string): Promise<DownloadInfo[]> {
		const updateUi = await this.call<DelugeUpdateUiResponse>('web.update_ui', [DELUGE_FIELDS, {}]);
		const torrents = updateUi.torrents || {};

		let downloads = Object.entries(torrents).map(([hash, torrent]) =>
			this.mapTorrent(hash, torrent)
		);
		if (category?.trim()) {
			const needle = category.trim().toLowerCase();
			downloads = downloads.filter((download) => download.category?.toLowerCase() === needle);
		}

		return downloads;
	}

	async getDownload(id: string): Promise<DownloadInfo | null> {
		const hashLike = /^[a-f0-9]{40}$/i.test(id);
		if (hashLike) {
			try {
				const torrent = await this.call<DelugeTorrentInfo>('web.get_torrent_status', [
					id,
					DELUGE_FIELDS
				]);
				if (torrent && Object.keys(torrent).length > 0) {
					return this.mapTorrent(id.toLowerCase(), torrent);
				}
			} catch {
				// Fall back to scanning all torrents
			}
		}

		const all = await this.getDownloads();
		return all.find((download) => download.id === id || download.hash === id) ?? null;
	}

	async removeDownload(id: string, deleteFiles: boolean = false): Promise<void> {
		await this.call<boolean>('core.remove_torrent', [id, deleteFiles]);
	}

	async pauseDownload(id: string): Promise<void> {
		await this.call<boolean>('core.pause_torrent', [[id]]);
	}

	async resumeDownload(id: string): Promise<void> {
		await this.call<boolean>('core.resume_torrent', [[id]]);
	}

	async getDefaultSavePath(): Promise<string> {
		const values = await this.call<Record<string, string>>('core.get_config_values', [
			['download_location']
		]);
		return values?.download_location || '';
	}

	async getCategories(): Promise<string[]> {
		try {
			const labels = await this.call<string[]>('label.get_labels');
			return (labels || []).map((label) => label.trim()).filter((label) => label.length > 0);
		} catch {
			return [];
		}
	}

	async ensureCategory(name: string, _savePath?: string): Promise<void> {
		const normalized = name.trim();
		if (!normalized) {
			return;
		}

		try {
			await this.call<unknown>('label.add', [normalized]);
		} catch (error) {
			const message =
				error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
			if (message.includes('already') || message.includes('exists')) {
				return;
			}
			throw error;
		}
	}

	async markItemAsImported(id: string, importedCategory?: string): Promise<void> {
		if (!importedCategory?.trim()) {
			return;
		}

		await this.ensureCategory(importedCategory);
		await this.call<unknown>('label.set_torrent', [id, importedCategory.trim()]);
	}

	async setSeedingConfig(
		id: string,
		config: { ratioLimit?: number; seedingTimeLimit?: number }
	): Promise<void> {
		const options: Record<string, unknown> = {};

		if (typeof config.ratioLimit === 'number') {
			options.stop_at_ratio = config.ratioLimit >= 0;
			if (config.ratioLimit >= 0) {
				options.stop_ratio = config.ratioLimit;
			}
		}

		if (typeof config.seedingTimeLimit === 'number' && config.seedingTimeLimit >= 0) {
			options.stop_seed_at_ratio = false;
		}

		if (Object.keys(options).length === 0) {
			return;
		}

		await this.call<unknown>('core.set_torrent_options', [[id], options]);
	}

	async getBasePath(): Promise<string | undefined> {
		const path = await this.getDefaultSavePath();
		return path || undefined;
	}
}
