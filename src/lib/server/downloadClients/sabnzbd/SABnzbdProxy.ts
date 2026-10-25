/**
 * SABnzbdProxy - Handles all HTTP communication with SABnzbd API.
 *
 * Optimized for SABnzbd API features:
 * - Uses nzo_ids filter for efficient single-item lookups
 * - Supports last_history_update for incremental polling
 * - Uses get_cats for lightweight category fetching
 * - Implements exponential backoff for retries
 */

import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'imports' as const });
import { randomUUID } from 'node:crypto';

/** Default timeout for SABnzbd API requests in milliseconds */
const API_TIMEOUT_MS = 20_000; // 20 seconds

/** Extended timeout for file uploads */
const UPLOAD_TIMEOUT_MS = 45_000; // 45 seconds

/** Maximum retry attempts for transient failures */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (doubles each retry) */
const RETRY_BASE_DELAY_MS = 1000;

import type {
	SabnzbdSettings,
	SabnzbdAddResponse,
	SabnzbdConfig,
	SabnzbdConfigResponse,
	SabnzbdQueue,
	SabnzbdHistory,
	SabnzbdVersionResponse,
	SabnzbdFullStatus,
	SabnzbdFullStatusResponse,
	SabnzbdErrorResponse,
	SabnzbdWarning,
	SabnzbdWarningsResponse
} from './types';

/**
 * Multipart part headers are line-based, so CR/LF or an unescaped quote in a
 * name or filename would let a release-derived value inject or truncate parts.
 */
function sanitizeMultipartToken(value: string): string {
	return value.replace(/[\r\n"]/g, '_');
}

/** Part values are body content; only line breaks can inject a new part. */
function sanitizeMultipartValue(value: string): string {
	return value.replace(/[\r\n]/g, ' ');
}

/**
 * Error thrown when SABnzbd API returns an error.
 */
export class SabnzbdApiError extends Error {
	constructor(
		message: string,
		public readonly statusCode?: number
	) {
		super(message);
		this.name = 'SabnzbdApiError';
	}
}

/**
 * Options for adding NZB downloads per SABnzbd API 4.5.
 */
export interface AddNzbOptions {
	/** Post-processing option (-1=default, 0=none, 1=repair, 2=repair/unpack, 3=repair/unpack/delete) */
	pp?: number;
	/** Archive extraction password */
	password?: string;
	/** Post-processing script to run */
	script?: string;
}

/**
 * Proxy class for SABnzbd API communication.
 */
export class SABnzbdProxy {
	private settings: SabnzbdSettings;

	/**
	 * Timestamp of last history update from SABnzbd.
	 * Used for incremental polling - SABnzbd returns empty response if nothing changed.
	 */
	private lastHistoryUpdate: number = 0;

	constructor(settings: SabnzbdSettings) {
		this.settings = settings;
	}

	/**
	 * Reset incremental polling state.
	 * Call this when you want to force a full refresh.
	 */
	resetPollingState(): void {
		this.lastHistoryUpdate = 0;
	}

	/**
	 * Build the base URL for SABnzbd API.
	 */
	getBaseUrl(relativePath: string = ''): string {
		const protocol = this.settings.useSsl ? 'https' : 'http';
		const urlBase = this.settings.urlBase?.replace(/^\/|\/$/g, '') || '';
		const base = `${protocol}://${this.settings.host}:${this.settings.port}`;

		if (urlBase) {
			return `${base}/${urlBase}/${relativePath}`.replace(/\/+$/, '');
		}
		return `${base}/${relativePath}`.replace(/\/+$/, '');
	}

	/**
	 * Get SABnzbd version for testing connectivity.
	 */
	async getVersion(): Promise<string> {
		const response = await this.executeRequest<SabnzbdVersionResponse>('version');
		return response.version || 'Unknown';
	}

	/**
	 * Get SABnzbd configuration (categories, paths, etc.).
	 */
	async getConfig(): Promise<SabnzbdConfig> {
		const response = await this.executeRequest<SabnzbdConfigResponse>('get_config');
		return response.config;
	}

	/**
	 * Get SABnzbd full status (paused state, speeds, paths).
	 */
	async getFullStatus(): Promise<SabnzbdFullStatus> {
		const params = new URLSearchParams();
		params.set('skip_dashboard', '1');
		const response = await this.executeRequest<SabnzbdFullStatusResponse>('fullstatus', params);
		return response.status;
	}

	/**
	 * Get SABnzbd warnings/alerts.
	 * Returns list of warnings (disk space, server issues, incomplete downloads, etc.)
	 */
	async getWarnings(): Promise<SabnzbdWarning[]> {
		const response = await this.executeRequest<SabnzbdWarningsResponse>('warnings');
		return response.warnings || [];
	}

	/**
	 * Clear all SABnzbd warnings.
	 */
	async clearWarnings(): Promise<void> {
		const params = new URLSearchParams();
		params.set('value', 'clear');
		await this.executeRequest<unknown>('warnings', params);
	}

	/**
	 * Get current speed limit.
	 * Returns the limit as a percentage (0-100) or KB/s value.
	 */
	async getSpeedLimit(): Promise<number> {
		const status = await this.getFullStatus();
		return status.speedlimit || 0;
	}

	/**
	 * Set download speed limit.
	 * @param value - Percentage (0-100), or absolute value with suffix (e.g., "500K", "1M")
	 *                Pass 0 or empty string to remove limit.
	 */
	async setSpeedLimit(value: number | string): Promise<void> {
		const params = new URLSearchParams();
		params.set('name', 'speedlimit');
		params.set('value', String(value));
		await this.executeRequest<unknown>('config', params, 'POST');
	}

	/**
	 * Get available categories using lightweight get_cats endpoint.
	 * Much faster than fetching full config.
	 */
	async getCategories(): Promise<string[]> {
		const response = await this.executeRequest<{ categories: string[] }>('get_cats');
		return response.categories || [];
	}

	/**
	 * Get the download queue.
	 * Supports efficient filtering by nzo_ids for single-item lookups.
	 *
	 * @param start - Starting index for pagination
	 * @param limit - Maximum items to return
	 * @param nzoIds - Optional: Only return items with these IDs (comma-separated or array)
	 */
	async getQueue(
		start: number = 0,
		limit: number = 100,
		nzoIds?: string | string[]
	): Promise<SabnzbdQueue> {
		const params = new URLSearchParams();
		params.set('start', start.toString());
		params.set('limit', limit.toString());

		// Use nzo_ids filter for efficient single-item or batch lookups
		if (nzoIds) {
			const ids = Array.isArray(nzoIds) ? nzoIds.join(',') : nzoIds;
			params.set('nzo_ids', ids);
		}

		const response = await this.executeRequestWithRetry<{ queue: SabnzbdQueue }>('queue', params);
		return response.queue;
	}

	/**
	 * Get download history with support for incremental polling.
	 *
	 * When useIncremental is true:
	 * - Uses last_history_update parameter to only fetch if something changed
	 * - Returns null if nothing has changed since last call
	 * - Much more efficient for polling scenarios
	 *
	 * @param start - Starting index for pagination
	 * @param limit - Maximum items to return
	 * @param category - Optional category filter
	 * @param nzoIds - Optional: Only return items with these IDs
	 * @param useIncremental - If true, use incremental polling (returns null if unchanged)
	 */
	async getHistory(
		start: number = 0,
		limit: number = 100,
		category?: string,
		nzoIds?: string | string[],
		useIncremental: boolean = false
	): Promise<SabnzbdHistory | null> {
		const params = new URLSearchParams();
		params.set('start', start.toString());
		params.set('limit', limit.toString());

		if (category) {
			params.set('category', category);
		}

		// Use nzo_ids filter for efficient lookups
		if (nzoIds) {
			const ids = Array.isArray(nzoIds) ? nzoIds.join(',') : nzoIds;
			params.set('nzo_ids', ids);
		}

		// Use incremental polling if enabled and we have a previous timestamp
		if (useIncremental && this.lastHistoryUpdate > 0) {
			params.set('last_history_update', this.lastHistoryUpdate.toString());
		}

		const response = await this.executeRequestWithRetry<{
			history: SabnzbdHistory & { last_history_update?: number };
		}>('history', params);

		// Update our tracking timestamp if provided
		if (response.history.last_history_update) {
			this.lastHistoryUpdate = response.history.last_history_update;
		}

		// If using incremental and nothing changed, SABnzbd returns empty slots
		// We detect this by checking if we got an update timestamp but no slots
		if (useIncremental && response.history.slots.length === 0 && this.lastHistoryUpdate > 0) {
			return null; // Nothing changed
		}

		return response.history;
	}

	/**
	 * Add NZB by uploading file content.
	 * Supports SABnzbd API 4.5 parameters.
	 */
	async downloadNzb(
		nzbData: Buffer,
		filename: string,
		category: string,
		priority: number,
		options?: AddNzbOptions
	): Promise<SabnzbdAddResponse> {
		const params = new URLSearchParams();
		params.set('cat', category);
		params.set('priority', priority.toString());

		// Add optional API 4.5 parameters
		if (options?.pp !== undefined) {
			params.set('pp', options.pp.toString());
		}
		if (options?.password) {
			params.set('password', options.password);
		}
		if (options?.script) {
			params.set('script', options.script);
		}

		const response = await this.executeMultipartRequest(
			'addfile',
			params,
			{
				name: 'name',
				filename,
				data: nzbData,
				contentType: 'application/x-nzb'
			},
			{
				nzbname: filename
			}
		);

		return this.parseAddResponse(response);
	}

	/**
	 * Add NZB by URL.
	 * Supports SABnzbd API 4.5 parameters.
	 */
	async downloadNzbByUrl(
		url: string,
		category: string,
		priority: number,
		nzbName?: string,
		options?: AddNzbOptions
	): Promise<SabnzbdAddResponse> {
		const params = new URLSearchParams();
		params.set('name', url);
		params.set('cat', category);
		params.set('priority', priority.toString());
		if (nzbName) {
			params.set('nzbname', nzbName);
		}

		// Add optional API 4.5 parameters
		if (options?.pp !== undefined) {
			params.set('pp', options.pp.toString());
		}
		if (options?.password) {
			params.set('password', options.password);
		}
		if (options?.script) {
			params.set('script', options.script);
		}

		const response = await this.executeRequest<SabnzbdAddResponse | SabnzbdErrorResponse>(
			'addurl',
			params,
			'POST'
		);

		return this.parseAddResponse(response);
	}

	/**
	 * Remove item from queue or history.
	 * @param source 'queue' or 'history'
	 */
	async removeFrom(source: 'queue' | 'history', id: string, deleteData: boolean): Promise<void> {
		const params = new URLSearchParams();
		params.set('name', 'delete');
		params.set('value', id);
		params.set('del_files', deleteData ? '1' : '0');

		await this.executeRequest<unknown>(source, params);
	}

	/**
	 * Pause a specific download.
	 */
	async pause(id: string): Promise<void> {
		const params = new URLSearchParams();
		params.set('name', 'pause');
		params.set('value', id);

		await this.executeRequest<unknown>('queue', params);
	}

	/**
	 * Resume a specific download.
	 */
	async resume(id: string): Promise<void> {
		const params = new URLSearchParams();
		params.set('name', 'resume');
		params.set('value', id);

		await this.executeRequest<unknown>('queue', params);
	}

	/**
	 * Set password for an encrypted archive in the queue.
	 * @param id - The nzo_id of the download
	 * @param password - The archive password
	 */
	async setPassword(id: string, password: string): Promise<void> {
		const params = new URLSearchParams();
		params.set('name', 'rename');
		params.set('value', id);
		// value2 is the new name (empty to keep current)
		params.set('value2', '');
		// value3 is the password
		params.set('value3', password);

		await this.executeRequest<unknown>('queue', params);
		logger.debug({ id }, '[SABnzbd] Password set for download');
	}

	/**
	 * Retry a failed download from history.
	 */
	async retry(id: string): Promise<string | undefined> {
		const params = new URLSearchParams();
		params.set('value', id);

		const response = await this.executeRequest<{ status: boolean; nzo_id?: string }>(
			'retry',
			params
		);
		return response.nzo_id;
	}

	/**
	 * Get a single queue item by ID.
	 * Uses nzo_ids filter for efficient server-side lookup instead of fetching entire queue.
	 */
	async getQueueItem(id: string): Promise<SabnzbdQueue['slots'][0] | undefined> {
		// Use nzo_ids filter - SABnzbd returns only the matching item
		const queue = await this.getQueue(0, 1, id);
		return queue.slots[0];
	}

	/**
	 * Get a single history item by ID.
	 * Uses nzo_ids filter for efficient server-side lookup instead of fetching entire history.
	 */
	async getHistoryItem(id: string): Promise<SabnzbdHistory['slots'][0] | undefined> {
		// Use nzo_ids filter - SABnzbd returns only the matching item
		const history = await this.getHistory(0, 1, undefined, id);
		return history?.slots[0];
	}

	/**
	 * Get multiple queue/history items by ID in a single request.
	 * More efficient than multiple individual lookups.
	 */
	async getItemsByIds(ids: string[]): Promise<{
		queue: SabnzbdQueue['slots'];
		history: SabnzbdHistory['slots'];
	}> {
		const [queue, history] = await Promise.all([
			this.getQueue(0, ids.length, ids),
			this.getHistory(0, ids.length, undefined, ids)
		]);
		return {
			queue: queue.slots,
			history: history?.slots || []
		};
	}

	/**
	 * Build authentication parameters.
	 */
	private getAuthParams(): URLSearchParams {
		const params = new URLSearchParams();

		if (this.settings.apiKey) {
			params.set('apikey', this.settings.apiKey);
		} else if (this.settings.username && this.settings.password) {
			params.set('ma_username', this.settings.username);
			params.set('ma_password', this.settings.password);
		}

		params.set('output', 'json');
		return params;
	}

	/**
	 * Execute a standard API request.
	 */
	private async executeRequest<T>(
		mode: string,
		additionalParams?: URLSearchParams,
		method: 'GET' | 'POST' = 'GET'
	): Promise<T> {
		const url = new URL(this.getBaseUrl('api'));

		// Add mode and auth params
		url.searchParams.set('mode', mode);
		const authParams = this.getAuthParams();
		authParams.forEach((value, key) => url.searchParams.set(key, value));

		// Add additional params
		if (additionalParams) {
			additionalParams.forEach((value, key) => url.searchParams.set(key, value));
		}

		logger.debug(
			{
				mode,
				url: url.toString().replace(/apikey=[^&]+/, 'apikey=***')
			},
			'[SABnzbd] API request'
		);

		// Create abort controller with timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

		try {
			const response = await fetch(url.toString(), {
				method,
				headers: {
					Accept: 'application/json'
				},
				signal: controller.signal
			});

			if (!response.ok) {
				throw new SabnzbdApiError(
					`SABnzbd API returned ${response.status}: ${response.statusText}`,
					response.status
				);
			}

			const text = await response.text();
			this.checkForError(text);

			return JSON.parse(text) as T;
		} catch (error) {
			if (error instanceof SabnzbdApiError) {
				throw error;
			}
			// Handle abort/timeout specifically
			if (error instanceof Error && error.name === 'AbortError') {
				throw new SabnzbdApiError(`SABnzbd API request timed out after ${API_TIMEOUT_MS}ms`);
			}
			throw new SabnzbdApiError(
				`Failed to connect to SABnzbd: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/**
	 * Execute a multipart form request (for file uploads) with retry logic.
	 * Uses exponential backoff for transient failures (timeouts, server errors).
	 */
	private async executeMultipartRequest(
		mode: string,
		additionalParams: URLSearchParams,
		file: { name: string; filename: string; data: Buffer; contentType: string },
		fields?: Record<string, string>
	): Promise<unknown> {
		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				return await this.executeMultipartRequestOnce(mode, additionalParams, file, fields);
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Don't retry on auth errors or client errors (4xx)
				if (lastError instanceof SabnzbdApiError && lastError.statusCode) {
					if (lastError.statusCode >= 400 && lastError.statusCode < 500) {
						throw lastError;
					}
				}

				// Log retry attempt with exponential backoff
				if (attempt < MAX_RETRIES) {
					const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
					logger.warn(
						{
							mode,
							filename: file.filename,
							attempt: attempt + 1,
							maxRetries: MAX_RETRIES,
							delayMs,
							error: lastError.message
						},
						'[SABnzbd] Upload failed, retrying with backoff'
					);
					await new Promise((r) => setTimeout(r, delayMs));
				}
			}
		}

		logger.error(
			{
				mode,
				filename: file.filename,
				totalAttempts: MAX_RETRIES + 1,
				error: lastError?.message
			},
			'[SABnzbd] Upload failed after all retries'
		);

		throw lastError!;
	}

	/**
	 * Execute a single multipart form request attempt.
	 */
	private async executeMultipartRequestOnce(
		mode: string,
		additionalParams: URLSearchParams,
		file: { name: string; filename: string; data: Buffer; contentType: string },
		fields?: Record<string, string>
	): Promise<unknown> {
		const url = new URL(this.getBaseUrl('api'));

		// Add mode and auth params to URL
		url.searchParams.set('mode', mode);
		const authParams = this.getAuthParams();
		authParams.forEach((value, key) => url.searchParams.set(key, value));
		additionalParams.forEach((value, key) => url.searchParams.set(key, value));

		logger.debug({ mode, filename: file.filename }, '[SABnzbd] Multipart request');

		// Build multipart form data with cryptographically secure boundary
		// Using crypto.randomUUID() instead of Math.random() to avoid boundary collisions
		const boundary = `----FormBoundary${randomUUID().replace(/-/g, '')}`;
		const parts: Buffer[] = [];

		// Add file part
		parts.push(
			Buffer.from(
				`--${boundary}\r\n` +
					`Content-Disposition: form-data; name="${sanitizeMultipartToken(file.name)}"; filename="${sanitizeMultipartToken(file.filename)}"\r\n` +
					`Content-Type: ${sanitizeMultipartToken(file.contentType)}\r\n\r\n`
			)
		);
		parts.push(file.data);
		parts.push(Buffer.from('\r\n'));

		// Add additional fields if provided
		if (fields) {
			for (const [key, value] of Object.entries(fields)) {
				parts.push(
					Buffer.from(
						`--${boundary}\r\n` +
							`Content-Disposition: form-data; name="${sanitizeMultipartToken(key)}"\r\n\r\n` +
							`${sanitizeMultipartValue(value)}\r\n`
					)
				);
			}
		}

		// End boundary
		parts.push(Buffer.from(`--${boundary}--\r\n`));

		const body = Buffer.concat(parts);

		// Create abort controller with timeout (longer for file uploads)
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

		try {
			const response = await fetch(url.toString(), {
				method: 'POST',
				headers: {
					'Content-Type': `multipart/form-data; boundary=${boundary}`,
					Accept: 'application/json'
				},
				body,
				signal: controller.signal
			});

			if (!response.ok) {
				throw new SabnzbdApiError(
					`SABnzbd API returned ${response.status}: ${response.statusText}`,
					response.status
				);
			}

			const text = await response.text();
			this.checkForError(text);

			return JSON.parse(text);
		} catch (error) {
			if (error instanceof SabnzbdApiError) {
				throw error;
			}
			// Handle abort/timeout specifically
			if (error instanceof Error && error.name === 'AbortError') {
				throw new SabnzbdApiError(`SABnzbd upload request timed out`);
			}
			throw new SabnzbdApiError(
				`Failed to upload to SABnzbd: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/**
	 * Check response for SABnzbd error format.
	 */
	private checkForError(responseText: string): void {
		// Handle plain text error responses
		if (responseText.toLowerCase().startsWith('error')) {
			throw new SabnzbdApiError(responseText.replace(/^error:\s*/i, ''));
		}

		// Try to parse as JSON error
		try {
			const parsed = JSON.parse(responseText) as SabnzbdErrorResponse;
			if (parsed.status === false || parsed.status === 'false') {
				throw new SabnzbdApiError(parsed.error || 'Unknown SABnzbd error');
			}
		} catch (e) {
			// If JSON parsing fails but it's not an error response, that's fine
			if (e instanceof SabnzbdApiError) {
				throw e;
			}
		}
	}

	/**
	 * Execute a request with retry logic for transient failures.
	 * Uses exponential backoff: 1s, 2s, 4s, etc.
	 * Retries on timeout, server errors (5xx), or rate limiting (429).
	 * Does not retry on other client errors (4xx except 429).
	 */
	private async executeRequestWithRetry<T>(
		mode: string,
		additionalParams?: URLSearchParams,
		method: 'GET' | 'POST' = 'GET'
	): Promise<T> {
		let lastError: Error | null = null;

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				return await this.executeRequest<T>(mode, additionalParams, method);
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Check if we should retry based on error type
				if (lastError instanceof SabnzbdApiError && lastError.statusCode) {
					// 429 Too Many Requests - retry with longer backoff
					if (lastError.statusCode === 429) {
						logger.warn(
							{
								mode,
								attempt: attempt + 1
							},
							'[SABnzbd] Rate limited (429), will retry with longer backoff'
						);
						// Use longer backoff for rate limiting: 5s, 10s, 20s, 40s
						if (attempt < MAX_RETRIES) {
							const delayMs = 5000 * Math.pow(2, attempt);
							await new Promise((r) => setTimeout(r, delayMs));
							continue;
						}
					}
					// Don't retry on other client errors (4xx except 429)
					if (lastError.statusCode >= 400 && lastError.statusCode < 500) {
						throw lastError;
					}
				}

				// Log retry attempt with exponential backoff
				if (attempt < MAX_RETRIES) {
					// Exponential backoff: 1s, 2s, 4s, 8s...
					const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
					logger.warn(
						{
							mode,
							attempt: attempt + 1,
							maxRetries: MAX_RETRIES,
							delayMs,
							nextAttemptIn: `${delayMs / 1000}s`,
							error: lastError.message
						},
						'[SABnzbd] Request failed, retrying with backoff'
					);
					await new Promise((r) => setTimeout(r, delayMs));
				}
			}
		}

		// Log final failure with full context
		logger.error(
			{
				mode,
				totalAttempts: MAX_RETRIES + 1,
				error: lastError?.message,
				host: this.settings.host,
				port: this.settings.port
			},
			'[SABnzbd] Request failed after all retries'
		);

		throw lastError!;
	}

	/**
	 * Parse add response handling various formats.
	 */
	private parseAddResponse(response: unknown): SabnzbdAddResponse {
		const resp = response as SabnzbdAddResponse | SabnzbdErrorResponse;

		if ('nzo_ids' in resp && resp.nzo_ids) {
			return {
				status: true,
				nzo_ids: resp.nzo_ids
			};
		}

		if ('status' in resp) {
			const status = resp.status === true || resp.status === 'true';
			if (!status && 'error' in resp) {
				throw new SabnzbdApiError(resp.error || 'Failed to add NZB');
			}
			return {
				status,
				nzo_ids: []
			};
		}

		// Assume success if no explicit status
		return {
			status: true,
			nzo_ids: []
		};
	}
}
