/**
 * rTorrent XML-RPC client implementation.
 *
 * Supports typical rTorrent RPC2 endpoints exposed directly or through ruTorrent.
 */

import { XMLParser } from 'fast-xml-parser';
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

type RTorrentStatus = DownloadInfo['status'];

function toNumber(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}

function toDate(epochSeconds: number | undefined): Date | undefined {
	if (!epochSeconds || epochSeconds <= 0) return undefined;
	return new Date(epochSeconds * 1000);
}

function normalizeHash(value: string): string | null {
	const normalized = value.trim();
	return /^[a-fA-F0-9]{40}$/.test(normalized) ? normalized : null;
}

function normalizeStatus(
	complete: number,
	transferActive: number,
	startedState: number,
	downRate: number,
	upRate: number,
	size: number,
	progress: number
): RTorrentStatus {
	if (complete > 0) {
		if (transferActive > 0 || upRate > 0) return 'seeding';
		return 'completed';
	}

	// Active transfer or non-zero download speed
	if (transferActive > 0 || downRate > 0) return 'downloading';

	// Started but currently idle (no peers/choked/metadata wait)
	if (startedState > 0 && progress > 0) return 'stalled';

	// Magnet metadata phase can report size=0 and no transfer yet while "started" in client UI.
	if (startedState > 0 && size <= 0 && progress <= 0) return 'downloading';

	if (progress > 0) return 'stalled';
	return 'paused';
}

function normalizeSegmentForComparison(value: string): string {
	return value
		.toLowerCase()
		.replace(/[\s._-]+/g, ' ')
		.replace(/[^a-z0-9 ]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function segmentsLikelyMatch(a: string, b: string): boolean {
	const normalizedA = normalizeSegmentForComparison(a);
	const normalizedB = normalizeSegmentForComparison(b);

	if (!normalizedA || !normalizedB) {
		return false;
	}

	return normalizedA === normalizedB;
}

function collapseDuplicateTerminalSegment(path: string): string {
	const normalized = path.replace(/\/+$/, '');
	const hasLeadingSlash = normalized.startsWith('/');
	const parts = normalized.split('/').filter(Boolean);

	if (parts.length < 2) {
		return normalized;
	}

	const tail = parts[parts.length - 1];
	const parentTail = parts[parts.length - 2];
	const hasExtension = tail.includes('.');

	// Some rTorrent setups can transiently report .../<name>/<name>.
	// If the terminal segment duplicates the parent and has no extension,
	// prefer the parent directory as the content root.
	if (!hasExtension && segmentsLikelyMatch(tail, parentTail)) {
		const collapsed = parts.slice(0, -1).join('/');
		return hasLeadingSlash ? `/${collapsed}` : collapsed;
	}

	return normalized;
}

function resolveContentPath(savePath: string, basePath: unknown, name: string): string {
	if (typeof basePath === 'string' && basePath.trim().length > 0) {
		return collapseDuplicateTerminalSegment(basePath.trim());
	}

	const normalizedSavePath = collapseDuplicateTerminalSegment(savePath.trim());
	if (!normalizedSavePath) {
		return name;
	}

	const normalizedName = name.trim();
	if (!normalizedName) {
		return normalizedSavePath;
	}

	const tail = normalizedSavePath.split('/').pop() ?? '';
	if (segmentsLikelyMatch(tail, normalizedName)) {
		return normalizedSavePath;
	}

	return `${normalizedSavePath}/${normalizedName}`;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * Quote a value for embedding inside an rTorrent command string (e.g. the
 * extra commands ridden on `load.start`/`load.raw_start`). rTorrent's own
 * command parser treats `,` as an argument separator and `;` as a command
 * separator within a single string; unrelated to XML escaping, which only
 * protects the surrounding XML-RPC envelope. Without quoting, a category or
 * default save path containing `,`, `;`, `"`, or `\` can break the command
 * parse or splice in a second command.
 * https://rtorrent-docs.readthedocs.io/en/latest/cmd-ref.html
 */
function quoteRtorrentArg(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export class RTorrentClient implements IDownloadClient {
	readonly implementation = 'rtorrent';

	private config: DownloadClientConfig;
	private parser = new XMLParser({
		ignoreAttributes: false,
		parseTagValue: false,
		trimValues: true
	});

	constructor(config: DownloadClientConfig) {
		this.config = config;
	}

	private get rpcUrl(): string {
		const protocol = this.config.useSsl ? 'https' : 'http';
		const base = `${protocol}://${this.config.host}:${this.config.port}`;
		const urlBase = this.config.urlBase?.trim().replace(/^\/+|\/+$/g, '');

		if (!urlBase) {
			return `${base}/RPC2`;
		}

		if (/rpc2$/i.test(urlBase) || /action\.php$/i.test(urlBase)) {
			return `${base}/${urlBase}`;
		}

		return `${base}/${urlBase}/RPC2`;
	}

	private getAuthHeader(): string | null {
		return getBasicAuthHeader(this.config.username, this.config.password);
	}

	private encodeValue(value: unknown): string {
		if (value === null || value === undefined) {
			return '<string></string>';
		}

		if (Buffer.isBuffer(value)) {
			return `<base64>${value.toString('base64')}</base64>`;
		}

		if (typeof value === 'string') {
			return `<string>${escapeXml(value)}</string>`;
		}

		if (typeof value === 'boolean') {
			return `<boolean>${value ? '1' : '0'}</boolean>`;
		}

		if (typeof value === 'number') {
			if (Number.isInteger(value)) {
				return `<int>${value}</int>`;
			}
			return `<double>${value}</double>`;
		}

		if (Array.isArray(value)) {
			const data = value.map((item) => `<value>${this.encodeValue(item)}</value>`).join('');
			return `<array><data>${data}</data></array>`;
		}

		if (typeof value === 'object') {
			const members = Object.entries(value as Record<string, unknown>)
				.map(
					([key, val]) =>
						`<member><name>${escapeXml(key)}</name><value>${this.encodeValue(val)}</value></member>`
				)
				.join('');
			return `<struct>${members}</struct>`;
		}

		return `<string>${escapeXml(String(value))}</string>`;
	}

	private decodeValue(valueNode: unknown): unknown {
		if (valueNode === null || valueNode === undefined) {
			return null;
		}

		if (typeof valueNode !== 'object') {
			return valueNode;
		}

		const node = valueNode as Record<string, unknown>;
		if ('string' in node) return String(node.string ?? '');
		if ('int' in node) return toNumber(node.int);
		if ('i4' in node) return toNumber(node.i4);
		if ('i8' in node) return toNumber(node.i8);
		if ('long' in node) return toNumber(node.long);
		if ('double' in node) return toNumber(node.double);
		if ('boolean' in node)
			return node.boolean === '1' || node.boolean === 1 || node.boolean === true;
		if ('base64' in node) return Buffer.from(String(node.base64 ?? ''), 'base64');
		if ('dateTime.iso8601' in node) return String(node['dateTime.iso8601'] ?? '');

		if ('array' in node) {
			const arrayNode = node.array as Record<string, unknown> | undefined;
			const dataNode = (arrayNode?.data ?? {}) as Record<string, unknown>;
			const values = dataNode.value;
			const valueList = Array.isArray(values) ? values : values !== undefined ? [values] : [];
			return valueList.map((entry) => this.decodeValue(entry));
		}

		if ('struct' in node) {
			const structNode = node.struct as Record<string, unknown> | undefined;
			const membersRaw = structNode?.member;
			const members = Array.isArray(membersRaw)
				? membersRaw
				: membersRaw !== undefined
					? [membersRaw]
					: [];
			const result: Record<string, unknown> = {};

			for (const member of members) {
				if (!member || typeof member !== 'object') continue;
				const memberObj = member as Record<string, unknown>;
				const name = String(memberObj.name ?? '');
				if (!name) continue;
				result[name] = this.decodeValue(memberObj.value);
			}

			return result;
		}

		if ('value' in node) {
			return this.decodeValue(node.value);
		}

		return node;
	}

	private buildRequestXml(method: string, params: unknown[]): string {
		const paramsXml = params
			.map((param) => `<param><value>${this.encodeValue(param)}</value></param>`)
			.join('');

		return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(method)}</methodName><params>${paramsXml}</params></methodCall>`;
	}

	private async rpcRequest<T>(method: string, params: unknown[] = []): Promise<T> {
		const headers = new Headers({
			'Content-Type': 'text/xml'
		});

		const authHeader = this.getAuthHeader();
		if (authHeader) {
			headers.set('Authorization', authHeader);
		}

		const response = await fetch(this.rpcUrl, {
			method: 'POST',
			headers,
			body: this.buildRequestXml(method, params)
		});

		if (response.status === 401 || response.status === 403) {
			throw new Error('rTorrent authentication failed: Invalid credentials');
		}

		if (!response.ok) {
			throw new Error(`rTorrent API error: ${response.status} ${response.statusText}`);
		}

		const xmlText = await response.text();
		let parsed: Record<string, unknown>;
		try {
			parsed = this.parser.parse(xmlText) as Record<string, unknown>;
		} catch {
			throw new Error('rTorrent API returned invalid XML response');
		}

		const methodResponse = parsed.methodResponse as Record<string, unknown> | undefined;
		if (!methodResponse) {
			throw new Error('Invalid rTorrent XML-RPC response');
		}

		if (methodResponse.fault) {
			const faultNode = methodResponse.fault as Record<string, unknown>;
			const faultData = this.decodeValue(faultNode.value) as Record<string, unknown>;
			const faultMessage = String(faultData?.faultString ?? 'Unknown XML-RPC fault');
			throw new Error(`rTorrent RPC fault: ${faultMessage}`);
		}

		const paramsNode = methodResponse.params as Record<string, unknown> | undefined;
		const rawParam = paramsNode?.param;
		const firstParam = Array.isArray(rawParam) ? rawParam[0] : rawParam;
		const valueNode =
			firstParam && typeof firstParam === 'object'
				? (firstParam as Record<string, unknown>).value
				: undefined;

		return this.decodeValue(valueNode) as T;
	}

	private async callFirstSuccess<T>(
		candidates: Array<{ method: string; params?: unknown[] }>
	): Promise<T> {
		let lastError: unknown = null;
		for (const candidate of candidates) {
			try {
				return await this.rpcRequest<T>(candidate.method, candidate.params ?? []);
			} catch (error) {
				lastError = error;
			}
		}

		if (lastError instanceof Error) {
			throw lastError;
		}
		throw new Error('No supported rTorrent RPC method succeeded');
	}

	private async getTorrentHashes(): Promise<string[]> {
		const candidates: Array<{ method: string; params?: unknown[] }> = [
			{ method: 'd.multicall2', params: ['', 'main', 'd.hash='] },
			{ method: 'd.multicall2', params: ['', 'default', 'd.hash='] },
			{ method: 'd.multicall', params: ['main', '', 'd.hash='] },
			{ method: 'd.multicall', params: ['default', '', 'd.hash='] },
			{ method: 'download_list' }
		];

		const hashes = new Set<string>();
		let hadSuccess = false;
		let lastError: unknown = null;

		for (const candidate of candidates) {
			try {
				const raw = await this.rpcRequest<unknown>(candidate.method, candidate.params ?? []);
				hadSuccess = true;
				this.extractHashes(raw).forEach((hash) => hashes.add(hash));
			} catch (error) {
				lastError = error;
			}
		}

		if (hashes.size > 0) {
			return Array.from(hashes);
		}

		if (!hadSuccess && lastError instanceof Error) {
			throw lastError;
		}

		return [];
	}

	private extractHashes(raw: unknown): string[] {
		if (!Array.isArray(raw)) {
			if (typeof raw === 'string') {
				const single = normalizeHash(raw);
				return single ? [single] : [];
			}
			return [];
		}

		const hashes: string[] = [];
		for (const entry of raw) {
			if (typeof entry === 'string') {
				const hash = normalizeHash(entry);
				if (hash) hashes.push(hash);
				continue;
			}

			if (Array.isArray(entry) && typeof entry[0] === 'string') {
				const hash = normalizeHash(entry[0]);
				if (hash) hashes.push(hash);
				continue;
			}

			if (entry && typeof entry === 'object') {
				const objectHash = (entry as Record<string, unknown>).hash;
				if (typeof objectHash === 'string') {
					const hash = normalizeHash(objectHash);
					if (hash) hashes.push(hash);
				}
			}
		}

		return hashes;
	}

	private async getTorrentField<T>(hash: string, methods: string[], fallback: T): Promise<T> {
		for (const method of methods) {
			try {
				return await this.rpcRequest<T>(method, [hash]);
			} catch {
				// Try next candidate method name
			}
		}
		return fallback;
	}

	private async setCategory(hash: string, category: string): Promise<void> {
		const normalized = category.trim();
		if (!normalized) return;

		await this.callFirstSuccess<unknown>([
			{ method: 'd.custom1.set', params: [hash, normalized] },
			{ method: 'd.set_custom1', params: [hash, normalized] }
		]);
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

	private async getTorrentInfo(hash: string): Promise<DownloadInfo | null> {
		const [
			name,
			sizeBytes,
			completedBytes,
			downRate,
			upRate,
			isActive,
			state,
			complete,
			directory,
			basePath,
			category,
			ratio,
			createdAt,
			finishedTs
		] = await Promise.all([
			this.getTorrentField<string>(hash, ['d.name', 'd.get_name'], hash),
			this.getTorrentField<number | string>(hash, ['d.size_bytes', 'd.get_size_bytes'], 0),
			this.getTorrentField<number | string>(
				hash,
				['d.completed_bytes', 'd.get_completed_bytes'],
				0
			),
			this.getTorrentField<number | string>(hash, ['d.down.rate', 'd.get_down_rate'], 0),
			this.getTorrentField<number | string>(hash, ['d.up.rate', 'd.get_up_rate'], 0),
			this.getTorrentField<number | string>(hash, ['d.is_active', 'd.get_is_active'], 0),
			this.getTorrentField<number | string>(hash, ['d.state', 'd.get_state'], 0),
			this.getTorrentField<number | string>(hash, ['d.complete', 'd.get_complete'], 0),
			this.getTorrentField<string>(hash, ['d.directory', 'd.get_directory'], ''),
			this.getTorrentField<string>(hash, ['d.base_path', 'd.get_base_path'], ''),
			this.getTorrentField<string>(hash, ['d.custom1', 'd.get_custom1'], ''),
			this.getTorrentField<number | string>(hash, ['d.ratio', 'd.get_ratio'], 0),
			this.getTorrentField<number | string>(hash, ['d.creation_date', 'd.get_creation_date'], 0),
			this.getTorrentField<number | string>(hash, ['d.timestamp.finished'], 0)
		]);

		const size = toNumber(sizeBytes);
		const completed = toNumber(completedBytes);
		const progress = size > 0 ? Math.max(0, Math.min(1, completed / size)) : 0;
		const activeFlag = toNumber(isActive);
		const startedFlag = toNumber(state);
		const completeFlag = toNumber(complete);
		const downloadRate = toNumber(downRate);
		const uploadRate = toNumber(upRate);
		const status = normalizeStatus(
			completeFlag,
			activeFlag,
			startedFlag,
			downloadRate,
			uploadRate,
			size,
			progress
		);
		const savePath = typeof directory === 'string' ? directory : '';
		const ratioRaw = toNumber(ratio);
		const normalizedRatio = ratioRaw > 10 ? ratioRaw / 1000 : ratioRaw;
		const normalizedCategory =
			typeof category === 'string' && category.trim().length > 0 ? category.trim() : undefined;
		const normalizedName = typeof name === 'string' ? name : hash;
		const contentPath = resolveContentPath(savePath, basePath, normalizedName);
		const finishedAt = toNumber(finishedTs);
		const secondsSinceFinished =
			finishedAt > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - finishedAt) : 0;

		return {
			id: hash,
			name: normalizedName,
			hash,
			progress,
			status,
			size,
			downloadSpeed: downloadRate,
			uploadSpeed: uploadRate,
			savePath,
			contentPath,
			category: normalizedCategory,
			ratio: normalizedRatio,
			addedOn: toDate(toNumber(createdAt)),
			completedOn: finishedAt > 0 ? new Date(finishedAt * 1000) : undefined,
			seedingTime: completeFlag > 0 && finishedAt > 0 ? secondsSinceFinished : undefined,
			ratioLimit: this.config.seedRatioLimit,
			seedingTimeLimit: this.config.seedTimeLimit,
			canMoveFiles: status !== 'downloading' && status !== 'seeding' && status !== 'queued',
			// 'completed' means the torrent finished downloading and has no active
			// transfer or upload — an actively seeding torrent is never removable.
			// On top of that, the client-level seed goals must be met (evaluated
			// app-side; rTorrent has no per-torrent stop-at-ratio command).
			canBeRemoved:
				status === 'completed' && this.hasReachedSeedLimit(normalizedRatio, secondsSinceFinished)
		};
	}

	/**
	 * Seed goals come from the client's own configuration (seedRatioLimit as a
	 * decimal, seedTimeLimit in minutes), parsed once in DownloadClientManager.
	 * With no limits configured a torrent is never removable, matching the
	 * Transmission/qBittorrent behavior.
	 */
	private hasReachedSeedLimit(ratio: number, secondsSinceFinished: number): boolean {
		const ratioLimit = this.config.seedRatioLimit;
		if (typeof ratioLimit === 'number' && ratioLimit > 0 && ratio >= ratioLimit) {
			return true;
		}

		const seedTimeLimit = this.config.seedTimeLimit;
		if (
			typeof seedTimeLimit === 'number' &&
			seedTimeLimit > 0 &&
			secondsSinceFinished >= seedTimeLimit * 60
		) {
			return true;
		}

		return false;
	}

	async test(): Promise<ConnectionTestResult> {
		try {
			const [version, apiVersion, savePath, categories] = await Promise.all([
				this.callFirstSuccess<string>([
					{ method: 'system.client_version' },
					{ method: 'system.client_version.get' }
				]),
				this.callFirstSuccess<string>([
					{ method: 'system.api_version' },
					{ method: 'system.api_version.get' }
				]).catch(() => undefined),
				this.getDefaultSavePath(),
				this.getCategories()
			]);

			return {
				success: true,
				details: {
					version: version || 'rTorrent',
					apiVersion,
					savePath,
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
					`Torrent already exists in rTorrent: ${existing.name} (${existing.status}, ${Math.round(existing.progress * 100)}%)`
				);
				(duplicateError as Error & { existingTorrent: DownloadInfo }).existingTorrent = existing;
				(duplicateError as Error & { isDuplicate: boolean }).isDuplicate = true;
				throw duplicateError;
			}
		}

		const beforeHashes = infoHash
			? null
			: new Set((await this.getTorrentHashes()).map((hash) => hash.toLowerCase()));

		// Derive a per-category directory atomically at load time. Post-hoc
		// d.directory.set does not move existing data, so the directory and
		// label must ride along with load.start/load.raw_start.
		let effectiveSavePath = options.savePath?.trim() || '';
		if (!effectiveSavePath && options.category?.trim()) {
			try {
				effectiveSavePath = joinCategoryPath(await this.getDefaultSavePath(), options.category);
			} catch (error) {
				effectiveSavePath = '';
				logger.warn(
					{ err: error, category: options.category },
					'[rTorrent] Failed to resolve default save path; falling back to label-only'
				);
			}
		}
		const normalizedCategory = options.category?.trim() || '';
		const extraCommands: string[] = [];
		if (effectiveSavePath) {
			extraCommands.push(`d.directory.set=${quoteRtorrentArg(effectiveSavePath)}`);
		}
		if (normalizedCategory) {
			extraCommands.push(`d.custom1.set=${quoteRtorrentArg(normalizedCategory)}`);
		}

		if (options.torrentFile) {
			await this.callFirstSuccess<unknown>([
				{ method: 'load.raw_start', params: ['', options.torrentFile, ...extraCommands] },
				{ method: 'load_raw_start', params: ['', options.torrentFile, ...extraCommands] }
			]);
		} else {
			let source = options.magnetUri;
			if (!source && options.infoHash) {
				source = buildMagnetFromInfoHash(options.infoHash);
			}
			if (!source && options.downloadUrl) {
				source = options.downloadUrl;
			}
			if (!source) {
				throw new Error('rTorrent requires magnet URI, torrent file, info hash, or download URL');
			}

			await this.callFirstSuccess<unknown>([
				{ method: 'load.start', params: ['', source, ...extraCommands] },
				{ method: 'load_start', params: ['', source, ...extraCommands] }
			]);
		}

		let resolvedHash = infoHash;
		if (!resolvedHash && beforeHashes) {
			for (let attempt = 0; attempt < 10; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 150));
				const current = await this.getTorrentHashes();
				const added = current.find((hash) => !beforeHashes.has(hash.toLowerCase()));
				if (added) {
					resolvedHash = added.toLowerCase();
					break;
				}
			}
		}

		const resolvedHashForClient = resolvedHash
			? await this.findExistingHashInClient(resolvedHash)
			: null;
		const hashForOperations = resolvedHashForClient ?? resolvedHash;

		if (hashForOperations && options.category?.trim()) {
			await this.setCategory(hashForOperations, options.category.trim());
		}

		if (hashForOperations && options.paused) {
			await this.pauseDownload(hashForOperations);
		}

		return resolvedHash || '';
	}

	private async findExistingHashInClient(hash: string): Promise<string | null> {
		const needle = hash.toLowerCase();
		const hashes = await this.getTorrentHashes();
		return hashes.find((item) => item.toLowerCase() === needle) ?? null;
	}

	async getDownloads(category?: string): Promise<DownloadInfo[]> {
		const hashes = await this.getTorrentHashes();
		const infos = await Promise.all(hashes.map((hash) => this.getTorrentInfo(hash)));
		let downloads = infos.filter((item): item is DownloadInfo => item !== null);

		if (category?.trim()) {
			const needle = category.trim().toLowerCase();
			downloads = downloads.filter((download) => download.category?.toLowerCase() === needle);
		}

		return downloads;
	}

	async getDownload(id: string): Promise<DownloadInfo | null> {
		if (/^[a-f0-9]{40}$/i.test(id)) {
			const existingHash = await this.findExistingHashInClient(id);
			if (!existingHash) {
				return null;
			}
			return this.getTorrentInfo(existingHash);
		}

		const all = await this.getDownloads();
		return (
			all.find((download) => download.id === id || download.hash === id || download.name === id) ??
			null
		);
	}

	async removeDownload(id: string, _deleteFiles: boolean = false): Promise<void> {
		await this.callFirstSuccess<unknown>([
			{ method: 'd.erase', params: [id] },
			{ method: 'd.delete_tied', params: [id] }
		]);
	}

	async pauseDownload(id: string): Promise<void> {
		await this.callFirstSuccess<unknown>([
			{ method: 'd.stop', params: [id] },
			{ method: 'd.pause', params: [id] }
		]);
	}

	async resumeDownload(id: string): Promise<void> {
		await this.callFirstSuccess<unknown>([
			{ method: 'd.start', params: [id] },
			{ method: 'd.resume', params: [id] }
		]);
	}

	async getDefaultSavePath(): Promise<string> {
		const path = await this.callFirstSuccess<string>([
			{ method: 'directory.default' },
			{ method: 'get_directory' }
		]);

		return typeof path === 'string' ? path : '';
	}

	async getCategories(): Promise<string[]> {
		const downloads = await this.getDownloads();
		return Array.from(
			new Set(
				downloads
					.map((download) => download.category?.trim() || '')
					.filter((category) => category.length > 0)
			)
		).sort((a, b) => a.localeCompare(b));
	}

	async ensureCategory(_name: string, _savePath?: string): Promise<void> {
		// rTorrent has no explicit category registration mechanism.
	}

	async markItemAsImported(id: string, importedCategory?: string): Promise<void> {
		if (!importedCategory?.trim()) {
			return;
		}
		await this.setCategory(id, importedCategory.trim());
	}

	async setSeedingConfig(
		_id: string,
		_config: { ratioLimit?: number; seedingTimeLimit?: number }
	): Promise<void> {
		// Deliberately not implemented: rTorrent has no per-torrent stop-at-ratio
		// XMLRPC command, so seed goals cannot be pushed into the client (Radarr
		// evaluates them app-side for the same reason). This client reads the
		// client-level seedRatioLimit/seedTimeLimit from its own config instead.
		// Known limitation: indexer-level per-grab overrides are not honored here.
	}

	async getBasePath(): Promise<string | undefined> {
		const path = await this.getDefaultSavePath();
		return path || undefined;
	}
}
