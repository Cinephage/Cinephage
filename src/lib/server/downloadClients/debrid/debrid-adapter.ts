export type DebridProvider = 'realdebrid' | 'torbox';
export type DebridReadiness = 'awaiting_selection' | 'pending' | 'ready' | 'terminal';
export type SubmissionInput =
	{ kind: 'magnet'; magnet: string } | { kind: 'torrent'; bytes: Uint8Array; filename: string };
export type DebridErrorKind =
	| 'authentication'
	| 'permission'
	| 'throttled'
	| 'transient'
	| 'terminal'
	| 'ambiguous_submission'
	| 'provider_contract'
	| 'configuration'
	| 'network'
	| 'redirect';

export interface DebridCapability {
	storedClientId: string;
	tokenLoader: () => Promise<string | null>;
}
export interface CredentialResult {
	valid: true;
	accountId: string;
	accountLabel?: string;
}
export interface SubmissionResult {
	providerItemId: string;
	duplicateHint?: boolean;
}
export interface ProviderFile {
	providerFileId: string;
	path: string;
	name: string;
	sizeBytes: number;
	selected?: boolean;
}
export interface ProviderItem {
	providerItemId: string;
	providerState: string;
	readiness: DebridReadiness;
	progressPercent?: number;
	files: ProviderFile[];
	terminalReason?: string;
}
export interface EphemeralLink {
	url: string;
	filename?: string;
	sizeBytes?: number;
}
export interface DeleteResult {
	outcome: 'deleted' | 'already_absent';
}
export interface DebridAdapter {
	readonly provider: DebridProvider;
	readonly storedClientId: string;
	testCredentials(): Promise<CredentialResult>;
	findByInfoHash(infoHash: string): Promise<string | null>;
	submit(input: SubmissionInput): Promise<SubmissionResult>;
	inspect(providerItemId: string): Promise<ProviderItem>;
	resolveFreshLink(providerItemId: string, providerFileId: string): Promise<EphemeralLink>;
	delete(providerItemId: string): Promise<DeleteResult>;
	/**
	 * Pre-download file listing for a CACHED torrent (best-effort evidence
	 * probe for audio-language acquisition; audio-language design 2026-09-15
	 * tier 3). Returns null when the torrent is not cached or the provider
	 * cannot answer - absence of evidence, never an error the caller must
	 * handle beyond catching transport failures.
	 */
	checkInstantFiles?(infoHash: string): Promise<ProviderFile[] | null>;
}
export interface RealDebridAdapter extends DebridAdapter {
	readonly provider: 'realdebrid';
	selectFiles(providerItemId: string, providerFileIds: string[]): Promise<void>;
}
export interface DebridErrorInit {
	kind: DebridErrorKind;
	provider: DebridProvider;
	operation: string;
	httpStatus?: number;
	retryable: boolean;
	retryAfterMs?: number;
	redactedMessage: string;
}

export class DebridError extends Error {
	readonly isDebridError = true;
	readonly kind: DebridErrorKind;
	readonly provider: DebridProvider;
	readonly operation: string;
	readonly httpStatus?: number;
	readonly retryable: boolean;
	readonly retryAfterMs?: number;
	readonly redactedMessage: string;

	constructor(options: DebridErrorInit) {
		super(options.redactedMessage);
		this.name = 'DebridError';
		Object.assign(this, options);
		this.kind = options.kind;
		this.provider = options.provider;
		this.operation = options.operation;
		this.retryable = options.retryable;
		this.redactedMessage = options.redactedMessage;
	}
}

export function isDebridError(value: unknown): value is DebridError {
	return Boolean(
		value &&
		typeof value === 'object' &&
		(value as { isDebridError?: boolean }).isDebridError === true
	);
}

const RD_BASE = 'https://api.real-debrid.com/rest/1.0';
const TB_BASE = 'https://api.torbox.app/v1/api';
const TOKEN = Symbol('tokenLoader');
const SHA1 = /^[a-f0-9]{40}$/i;
const RETRIES = 3;

function failure(
	provider: DebridProvider,
	operation: string,
	kind: DebridErrorKind,
	redactedMessage: string,
	options: Partial<Pick<DebridErrorInit, 'httpStatus' | 'retryable' | 'retryAfterMs'>> = {}
): DebridError {
	return new DebridError({
		provider,
		operation,
		kind,
		redactedMessage,
		retryable: false,
		...options
	});
}

function contract(provider: DebridProvider, operation: string, message: string): never {
	throw failure(provider, operation, 'provider_contract', message);
}

function retryAfter(response: Response): number | undefined {
	const value = response.headers.get('retry-after')?.trim();
	if (!value) return undefined;
	const seconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
	return seconds > 0 ? Math.min(15 * 60_000, Math.max(1000, seconds)) : undefined;
}

function classifyStatus(
	provider: DebridProvider,
	operation: string,
	response: Response,
	mutation: boolean
): DebridError {
	const options = { httpStatus: response.status };
	if (response.status === 429) {
		return failure(provider, operation, 'throttled', 'Provider rate limit reached.', {
			...options,
			retryable: !mutation,
			retryAfterMs: retryAfter(response)
		});
	}
	if (response.status === 401)
		return failure(provider, operation, 'authentication', 'Credentials were rejected.', options);
	if (response.status === 403)
		return failure(provider, operation, 'permission', 'Access was denied.', options);
	if (response.status === 408 || response.status === 425 || response.status >= 500) {
		return failure(
			provider,
			operation,
			mutation ? 'ambiguous_submission' : 'transient',
			mutation ? 'Submission may have completed.' : 'Provider is temporarily unavailable.',
			{ ...options, retryable: !mutation }
		);
	}
	return failure(
		provider,
		operation,
		mutation ? 'ambiguous_submission' : 'provider_contract',
		'Provider returned an unexpected response.',
		options
	);
}

interface RequestOptions {
	operation: string;
	url: string | ((token: string) => string);
	method?: string;
	headers?: Record<string, string>;
	body?: BodyInit | Uint8Array;
	mutation?: boolean;
	tokenInQuery?: boolean;
	allow?: number[];
	attempts?: number;
}

abstract class BaseAdapter {
	abstract readonly provider: DebridProvider;
	readonly storedClientId: string;
	private [TOKEN]: () => Promise<string | null>;

	constructor(capability: DebridCapability) {
		this.storedClientId = capability.storedClientId;
		this[TOKEN] = capability.tokenLoader;
	}

	protected request(options: RequestOptions): Promise<Response> {
		const operation = this.performRequest(options);
		void operation.catch(() => undefined);
		return operation;
	}

	private async performRequest(options: RequestOptions): Promise<Response> {
		const mutation = options.mutation ?? false;
		const attempts = options.attempts ?? (mutation ? 1 : RETRIES);
		for (let attempt = 1; ; attempt++) {
			const token = await this[TOKEN]();
			if (!token) {
				throw failure(
					this.provider,
					options.operation,
					'configuration',
					'API token is not available.'
				);
			}
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 30_000);
			try {
				const response = await fetch(
					typeof options.url === 'function' ? options.url(token) : options.url,
					{
						method: options.method ?? 'GET',
						headers: {
							...options.headers,
							...(options.tokenInQuery ? {} : { authorization: `Bearer ${token}` })
						},
						body: options.body as BodyInit | undefined,
						redirect: 'manual',
						signal: controller.signal
					}
				);
				if (
					response.type === 'opaqueredirect' ||
					(response.status >= 300 && response.status < 400)
				) {
					throw failure(
						this.provider,
						options.operation,
						'redirect',
						'Provider redirected the request.',
						{
							httpStatus: response.status || undefined
						}
					);
				}
				if (
					(response.status < 200 || response.status >= 300) &&
					!options.allow?.includes(response.status)
				) {
					throw classifyStatus(this.provider, options.operation, response, mutation);
				}
				return response;
			} catch (error) {
				const classified = isDebridError(error)
					? error
					: failure(
							this.provider,
							options.operation,
							mutation ? 'ambiguous_submission' : 'network',
							error instanceof Error && error.name === 'AbortError'
								? 'Request took too long.'
								: 'Network request failed.',
							{ retryable: !mutation }
						);
				if (
					!classified.retryable ||
					attempt >= attempts ||
					classified.kind === 'redirect' ||
					(classified.kind === 'throttled' && attempt >= 2)
				) {
					throw classified;
				}
				await new Promise((resolve) =>
					setTimeout(
						resolve,
						classified.retryAfterMs ?? Math.random() * Math.min(30_000, 1000 * 2 ** (attempt - 1))
					)
				);
			} finally {
				clearTimeout(timeout);
			}
		}
	}

	protected async json(response: Response, operation: string): Promise<unknown> {
		try {
			return await response.json();
		} catch {
			return contract(this.provider, operation, 'Provider response was not valid JSON.');
		}
	}
}

function record(
	value: unknown,
	provider: DebridProvider,
	operation: string
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return contract(provider, operation, 'Provider response was malformed.');
	}
	return value as Record<string, unknown>;
}

function infoHash(value: string, provider: DebridProvider): string {
	if (!SHA1.test(value)) return contract(provider, 'findByInfoHash', 'Info hash is invalid.');
	return value.toLowerCase();
}

function files(
	provider: DebridProvider,
	operation: string,
	values: Array<{ id: unknown; path: unknown; size: unknown; selected?: boolean }>
): ProviderFile[] {
	const seen = new Set<string>();
	return values.map((value) => {
		const id = String(value.id);
		if (
			(typeof value.id !== 'string' && typeof value.id !== 'number') ||
			(typeof value.id === 'number' && (!Number.isSafeInteger(value.id) || value.id < 0)) ||
			!id ||
			seen.has(id) ||
			typeof value.path !== 'string' ||
			value.path.includes('\0') ||
			typeof value.size !== 'number' ||
			!Number.isInteger(value.size) ||
			value.size < 0
		) {
			return contract(provider, operation, 'Provider file metadata is invalid.');
		}
		seen.add(id);
		const path = value.path.normalize('NFC').replace(/^\//, '');
		const name = path.split('/').filter(Boolean).at(-1)?.normalize('NFC');
		if (!name) return contract(provider, operation, 'Provider file name is invalid.');
		return {
			providerFileId: id,
			path,
			name,
			sizeBytes: value.size,
			...(value.selected === undefined ? {} : { selected: value.selected })
		};
	});
}

const RD_PENDING = new Set([
	'magnet_conversion',
	'queued',
	'downloading',
	'compressing',
	'uploading'
]);
const RD_TERMINAL = new Set(['magnet_error', 'error', 'virus', 'dead']);
const RD_STATES = new Set(['waiting_files_selection', 'downloaded', ...RD_PENDING, ...RD_TERMINAL]);

interface RdInfo {
	id: string;
	status: string;
	progress?: number;
	links: unknown[];
	files: Array<{ id: unknown; path: unknown; bytes: unknown; selected: number }>;
}

class RealDebrid extends BaseAdapter implements RealDebridAdapter {
	readonly provider = 'realdebrid' as const;
	private readonly selected = new Set<string>();

	async testCredentials(): Promise<CredentialResult> {
		const response = await this.request({ operation: 'testCredentials', url: `${RD_BASE}/user` });
		if (response.status !== 200)
			return contract(this.provider, 'testCredentials', 'Unexpected status.');
		const body = record(
			await this.json(response, 'testCredentials'),
			this.provider,
			'testCredentials'
		);
		if (!Number.isInteger(body.id) || typeof body.username !== 'string' || !body.username.trim()) {
			return contract(this.provider, 'testCredentials', 'Account identity is missing.');
		}
		return { valid: true, accountId: String(body.id), accountLabel: body.username };
	}

	async findByInfoHash(hash: string): Promise<string | null> {
		const wanted = infoHash(hash, this.provider);
		const response = await this.request({
			operation: 'findByInfoHash',
			url: `${RD_BASE}/torrents?limit=5000`
		});
		const body = await this.json(response, 'findByInfoHash');
		if (!Array.isArray(body))
			return contract(this.provider, 'findByInfoHash', 'Torrent list is invalid.');
		for (const raw of body) {
			const item = record(raw, this.provider, 'findByInfoHash');
			if (
				typeof item.id !== 'string' ||
				!item.id ||
				typeof item.hash !== 'string' ||
				!SHA1.test(item.hash)
			) {
				return contract(this.provider, 'findByInfoHash', 'Torrent list item is invalid.');
			}
			if (item.hash.toLowerCase() === wanted) return item.id;
		}
		return null;
	}

	/**
	 * Real-Debrid instant availability: per-host variants of file id →
	 * {filename, filesize} for cached torrents. The endpoint has a history of
	 * deprecation churn (rdt-client #545/#617) - 404 and empty bodies are
	 * treated as "no evidence" (null), never an error.
	 */
	async checkInstantFiles(hash: string): Promise<ProviderFile[] | null> {
		const wanted = infoHash(hash, this.provider);
		const response = await this.request({
			operation: 'checkInstantFiles',
			url: `${RD_BASE}/torrents/instantavailability/${wanted}`,
			allow: [404]
		});
		if (response.status === 404) return null;
		const body = record(
			await this.json(response, 'checkInstantFiles'),
			this.provider,
			'checkInstantFiles'
		);
		// Response is keyed by the hash (historically upper-case); match
		// case-insensitively and tolerate a bare variant object.
		const entry = Object.keys(body).find((key) => key.toLowerCase() === wanted) ?? null;
		const variants = entry ? body[entry] : null;
		const rdVariants = (variants as { rd?: unknown }).rd;
		if (!Array.isArray(rdVariants)) {
			return null;
		}
		// Variants are alternative file sets; the most complete one is the
		// best evidence (others are partial cached subsets).
		let best: Array<[string, { filename?: unknown; filesize?: unknown }]> = [];
		for (const rawVariant of rdVariants) {
			const variant = record(rawVariant, this.provider, 'checkInstantFiles');
			const entries = Object.entries(variant) as Array<
				[string, { filename?: unknown; filesize?: unknown }]
			>;
			if (entries.length > best.length) best = entries;
		}
		if (best.length === 0) return null;
		const files: ProviderFile[] = [];
		for (const [id, meta] of best) {
			if (typeof meta?.filename !== 'string' || !meta.filename) continue;
			const name = meta.filename.split(/[\\/]/).pop() ?? meta.filename;
			files.push({
				providerFileId: id,
				path: meta.filename,
				name,
				sizeBytes: typeof meta.filesize === 'number' ? meta.filesize : 0
			});
		}
		return files.length > 0 ? files : null;
	}

	async submit(input: SubmissionInput): Promise<SubmissionResult> {
		const magnet = input.kind === 'magnet';
		const response = await this.request({
			operation: 'submit',
			url: `${RD_BASE}/torrents/${magnet ? 'addMagnet' : 'addTorrent'}`,
			method: magnet ? 'POST' : 'PUT',
			headers: {
				'content-type': magnet ? 'application/x-www-form-urlencoded' : 'application/x-bittorrent'
			},
			body: magnet ? `magnet=${encodeURIComponent(input.magnet)}` : input.bytes,
			mutation: true,
			allow: [400]
		});
		if (response.status === 400) {
			await this.json(response, 'submit');
			return contract(this.provider, 'submit', 'Provider rejected the submission.');
		}
		if (response.status !== 201) return contract(this.provider, 'submit', 'Unexpected status.');
		const body = record(await this.json(response, 'submit'), this.provider, 'submit');
		if (typeof body.id !== 'string' || !body.id)
			return contract(this.provider, 'submit', 'Item ID is missing.');
		return { providerItemId: body.id };
	}

	async inspect(providerItemId: string): Promise<ProviderItem> {
		let raw = await this.rawInfo(providerItemId, RETRIES);
		if (raw.status === 'waiting_files_selection' && !this.selected.has(providerItemId)) {
			this.normalize(raw, providerItemId);
			this.selected.add(providerItemId);
			await this.selectFiles(providerItemId, []);
			raw = await this.rawInfo(providerItemId, RETRIES);
		}
		return this.normalize(raw, providerItemId);
	}

	async selectFiles(providerItemId: string, _ids: string[]): Promise<void> {
		const response = await this.request({
			operation: 'selectFiles',
			url: `${RD_BASE}/torrents/selectFiles/${encodeURIComponent(providerItemId)}`,
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'files=all',
			mutation: true,
			allow: [404]
		});
		if (response.status !== 202 && response.status !== 204) {
			return contract(this.provider, 'selectFiles', 'Selection failed.');
		}
	}

	async resolveFreshLink(providerItemId: string, providerFileId: string): Promise<EphemeralLink> {
		const raw = await this.rawInfo(providerItemId, 1);
		const selected = raw.files.filter((file) => file.selected === 1);
		const index = selected.findIndex((file) => String(file.id) === providerFileId);
		const link = raw.links[index];
		if (index < 0 || typeof link !== 'string' || !link) {
			return contract(this.provider, 'resolveFreshLink', 'Selected file link is missing.');
		}
		const response = await this.request({
			operation: 'resolveFreshLink',
			url: `${RD_BASE}/unrestrict/link`,
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: `link=${encodeURIComponent(link)}`,
			attempts: 1
		});
		const body = record(
			await this.json(response, 'resolveFreshLink'),
			this.provider,
			'resolveFreshLink'
		);
		if (
			typeof body.download !== 'string' ||
			!body.download ||
			typeof body.filename !== 'string' ||
			!body.filename ||
			!Number.isInteger(body.filesize) ||
			(body.filesize as number) < 0
		) {
			return contract(this.provider, 'resolveFreshLink', 'Direct link metadata is invalid.');
		}
		return { url: body.download, filename: body.filename, sizeBytes: body.filesize as number };
	}

	async delete(providerItemId: string): Promise<DeleteResult> {
		const response = await this.request({
			operation: 'delete',
			url: `${RD_BASE}/torrents/delete/${encodeURIComponent(providerItemId)}`,
			method: 'DELETE',
			allow: [404]
		});
		if (response.status === 204) return { outcome: 'deleted' };
		if (response.status === 404) return { outcome: 'already_absent' };
		return contract(this.provider, 'delete', 'Delete failed.');
	}

	private async rawInfo(providerItemId: string, attempts: number): Promise<RdInfo> {
		const response = await this.request({
			operation: 'inspect',
			url: `${RD_BASE}/torrents/info/${encodeURIComponent(providerItemId)}`,
			attempts
		});
		const body = record(await this.json(response, 'inspect'), this.provider, 'inspect');
		if (
			body.id !== providerItemId ||
			typeof body.status !== 'string' ||
			!RD_STATES.has(body.status) ||
			!Array.isArray(body.files) ||
			!body.files.every(
				(file) =>
					file &&
					typeof file === 'object' &&
					((file as { selected?: unknown }).selected === 0 ||
						(file as { selected?: unknown }).selected === 1)
			)
		) {
			return contract(this.provider, 'inspect', 'Torrent metadata is invalid.');
		}
		return { ...(body as unknown as RdInfo), links: Array.isArray(body.links) ? body.links : [] };
	}

	private normalize(raw: RdInfo, providerItemId: string): ProviderItem {
		const normalized = files(
			this.provider,
			'inspect',
			raw.files.map((file) => ({
				id: file.id,
				path: file.path,
				size: file.bytes,
				selected: file.selected === 1
			}))
		);
		let readiness: DebridReadiness;
		if (raw.status === 'waiting_files_selection') readiness = 'awaiting_selection';
		else if (RD_PENDING.has(raw.status)) readiness = 'pending';
		else if (RD_TERMINAL.has(raw.status)) readiness = 'terminal';
		else {
			if (
				!normalized.some((file) => file.selected) ||
				raw.links.length !== normalized.filter((file) => file.selected).length
			) {
				return contract(this.provider, 'inspect', 'Selected files and links do not match.');
			}
			readiness = 'ready';
		}
		return {
			providerItemId,
			providerState: raw.status,
			readiness,
			files: normalized,
			...(typeof raw.progress === 'number' && Number.isFinite(raw.progress)
				? { progressPercent: raw.progress }
				: {}),
			...(readiness === 'terminal' ? { terminalReason: 'Provider reported a terminal state.' } : {})
		};
	}
}

const TB_PENDING = new Set([
	'downloading',
	'uploading',
	'stalled (no seeds)',
	'paused',
	'completed',
	'cached',
	'metaDL',
	'checkingResumeData'
]);
const TB_TERMINAL_CREATE = new Set([
	'MISSING_REQUIRED_OPTION',
	'BOZO_TORRENT',
	'DOWNLOAD_TOO_LARGE',
	'MONTHLY_LIMIT',
	'ACTIVE_LIMIT'
]);

class TorBox extends BaseAdapter implements DebridAdapter {
	readonly provider = 'torbox' as const;

	async testCredentials(): Promise<CredentialResult> {
		const response = await this.request({
			operation: 'testCredentials',
			url: `${TB_BASE}/user/me`,
			allow: [403]
		});
		const data = record(
			await this.envelope(response, 'testCredentials'),
			this.provider,
			'testCredentials'
		);
		if (!Number.isFinite(data.id) || !Number.isFinite(data.plan)) {
			return contract(this.provider, 'testCredentials', 'Account identity is missing.');
		}
		return { valid: true, accountId: String(data.id) };
	}

	async findByInfoHash(hash: string): Promise<string | null> {
		const wanted = infoHash(hash, this.provider);
		const response = await this.request({
			operation: 'findByInfoHash',
			url: `${TB_BASE}/torrents/mylist?bypass_cache=true`
		});
		const data = await this.envelope(response, 'findByInfoHash');
		if (!Array.isArray(data))
			return contract(this.provider, 'findByInfoHash', 'Torrent list is invalid.');
		for (const raw of data) {
			const item = record(raw, this.provider, 'findByInfoHash');
			if (
				!Number.isSafeInteger(item.id) ||
				(item.id as number) < 0 ||
				typeof item.hash !== 'string' ||
				!SHA1.test(item.hash)
			) {
				return contract(this.provider, 'findByInfoHash', 'Torrent list item is invalid.');
			}
			if (item.hash.toLowerCase() === wanted) return String(item.id);
		}
		return null;
	}

	/**
	 * TorBox cached check with file listings (`checkcached?format=list&
	 * listFiles=true`): returns per-hash cached status plus the file list for
	 * cached torrents. Not cached / not listed → null.
	 */
	async checkInstantFiles(hash: string): Promise<ProviderFile[] | null> {
		const wanted = infoHash(hash, this.provider);
		const response = await this.request({
			operation: 'checkInstantFiles',
			url: `${TB_BASE}/torrents/checkcached?hash=${wanted}&format=list&listFiles=true`,
			allow: [404]
		});
		if (response.status === 404) return null;
		const data = await this.envelope(response, 'checkInstantFiles');
		if (!Array.isArray(data)) return null;
		const entry = data.find((raw) => {
			const candidate = record(raw, this.provider, 'checkInstantFiles');
			return typeof candidate.hash === 'string' && candidate.hash.toLowerCase() === wanted;
		});
		if (!entry) return null;
		const item = record(entry, this.provider, 'checkInstantFiles');
		if (!item.cached) return null;
		const rawFiles = item.files;
		if (!Array.isArray(rawFiles) || rawFiles.length === 0) return null;
		const files: ProviderFile[] = [];
		for (const rawFile of rawFiles) {
			const file = record(rawFile, this.provider, 'checkInstantFiles');
			if (typeof file.name !== 'string' || !file.name) continue;
			files.push({
				providerFileId: String(file.id ?? ''),
				path: typeof file.path === 'string' && file.path ? file.path : file.name,
				name: file.name.split(/[\\/]/).pop() ?? file.name,
				sizeBytes: Number.isFinite(file.size) ? (file.size as number) : 0
			});
		}
		return files.length > 0 ? files : null;
	}

	async submit(input: SubmissionInput): Promise<SubmissionResult> {
		const form = new FormData();
		if (input.kind === 'magnet') form.append('magnet', input.magnet);
		else form.append('file', new Blob([input.bytes as BlobPart]), input.filename);
		const response = await this.request({
			operation: 'submit',
			url: `${TB_BASE}/torrents/createtorrent`,
			method: 'POST',
			body: form,
			mutation: true,
			allow: [400, 403]
		});
		const data = record(await this.envelope(response, 'submit'), this.provider, 'submit');
		if (response.status !== 200) {
			return contract(this.provider, 'submit', 'Submission returned an unexpected status.');
		}
		if (
			typeof data.hash !== 'string' ||
			!data.hash ||
			!Number.isFinite(data.torrent_id) ||
			typeof data.auth_id !== 'string' ||
			!data.auth_id
		) {
			return contract(this.provider, 'submit', 'Submission response is invalid.');
		}
		return { providerItemId: String(data.torrent_id) };
	}

	async inspect(providerItemId: string): Promise<ProviderItem> {
		const response = await this.request({
			operation: 'inspect',
			url: `${TB_BASE}/torrents/mylist?id=${encodeURIComponent(providerItemId)}&bypass_cache=true`
		});
		const data = await this.envelope(response, 'inspect');
		const items = Array.isArray(data) ? data : [data];
		const raw = items.find(
			(item) =>
				item && typeof item === 'object' && (item as { id?: unknown }).id === Number(providerItemId)
		);
		const torrent = record(raw, this.provider, 'inspect');
		if (
			!Number.isFinite(torrent.id) ||
			typeof torrent.download_state !== 'string' ||
			typeof torrent.download_finished !== 'boolean' ||
			typeof torrent.download_present !== 'boolean' ||
			!Array.isArray(torrent.files)
		) {
			return contract(this.provider, 'inspect', 'Torrent metadata is invalid.');
		}
		const normalized = files(
			this.provider,
			'inspect',
			torrent.files.map((rawFile) => {
				const file = record(rawFile, this.provider, 'inspect');
				return { id: file.id, path: file.name, size: file.size };
			})
		);
		const state = torrent.download_state;
		const ready =
			torrent.download_finished === true &&
			torrent.download_present === true &&
			normalized.length > 0;
		if (!TB_PENDING.has(state)) return contract(this.provider, 'inspect', 'Unknown torrent state.');
		const progress = torrent.progress;
		return {
			providerItemId: String(torrent.id),
			providerState: state,
			readiness: ready ? 'ready' : 'pending',
			files: normalized,
			...(typeof progress === 'number' && Number.isFinite(progress)
				? { progressPercent: progress <= 1 ? progress * 100 : progress }
				: {})
		};
	}

	async resolveFreshLink(providerItemId: string, providerFileId: string): Promise<EphemeralLink> {
		const response = await this.request({
			operation: 'resolveFreshLink',
			url: (token) =>
				`${TB_BASE}/torrents/requestdl?token=${encodeURIComponent(token)}` +
				`&torrent_id=${encodeURIComponent(providerItemId)}` +
				`&file_id=${encodeURIComponent(providerFileId)}&zip_link=false`,
			tokenInQuery: true,
			attempts: 1,
			allow: [403]
		});
		const data = await this.envelope(response, 'resolveFreshLink');
		if (typeof data !== 'string' || !data)
			return contract(this.provider, 'resolveFreshLink', 'Direct link is missing.');
		return { url: data };
	}

	async delete(providerItemId: string): Promise<DeleteResult> {
		const id = Number(providerItemId);
		if (!Number.isInteger(id) || id < 0)
			return contract(this.provider, 'delete', 'Item ID is invalid.');
		const response = await this.request({
			operation: 'delete',
			url: `${TB_BASE}/torrents/controltorrent`,
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ operation: 'delete', torrent_id: id }),
			allow: [404, 409]
		});
		try {
			const data = await this.envelope(response, 'delete');
			if (response.status !== 200 || data !== null) {
				return contract(this.provider, 'delete', 'Delete response is invalid.');
			}
			return { outcome: 'deleted' };
		} catch (error) {
			if (response.status === 404 && isDebridError(error) && error.kind === 'provider_contract') {
				return { outcome: 'already_absent' };
			}
			throw error;
		}
	}

	private async envelope(response: Response, operation: string): Promise<unknown> {
		const envelope = record(await this.json(response, operation), this.provider, operation);
		if (envelope.success === true && envelope.error === null) return envelope.data;
		const code = typeof envelope.error === 'string' ? envelope.error : '';
		if ((response.status === 401 || response.status === 403) && code === 'BAD_TOKEN') {
			throw failure(this.provider, operation, 'authentication', 'Credentials were rejected.', {
				httpStatus: response.status
			});
		}
		if (operation === 'submit' && TB_TERMINAL_CREATE.has(code)) {
			throw failure(this.provider, operation, 'terminal', 'Provider rejected the submission.', {
				httpStatus: response.status
			});
		}
		if (operation === 'delete' && response.status === 409 && code === 'NOT_OWNER') {
			throw failure(
				this.provider,
				operation,
				'permission',
				'Provider item is not owned by this account.',
				{
					httpStatus: response.status
				}
			);
		}
		throw failure(this.provider, operation, 'provider_contract', 'Provider reported a failure.', {
			httpStatus: response.status
		});
	}
}

export function createDebridAdapter(
	implementation: DebridProvider,
	capability: DebridCapability
): DebridAdapter {
	if (!capability || typeof capability.tokenLoader !== 'function') {
		throw new Error('createDebridAdapter: capability.tokenLoader is required');
	}
	if (implementation === 'realdebrid') return new RealDebrid(capability);
	if (implementation === 'torbox') return new TorBox(capability);
	throw new Error(`createDebridAdapter: unsupported implementation "${implementation}"`);
}
