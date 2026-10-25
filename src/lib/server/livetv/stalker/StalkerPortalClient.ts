/**
 * Stalker Portal Client
 *
 * Client for communicating with Stalker/Ministra protocol IPTV portals.
 * Implements the STB emulation protocol based on stalkerhek reference.
 *
 * Protocol flow:
 * 1. Handshake - reserve/obtain token
 * 2. Authenticate - either with credentials or device IDs
 * 3. API calls - all require proper headers with token
 */

import { createChildLogger } from '#lib/logging/index.js';
import { randomBytes } from 'node:crypto';

const logger = createChildLogger({ logDomain: 'livetv' as const });
import type {
	StalkerAccountTestResult,
	StalkerRawProfile,
	StalkerCategory,
	StalkerChannel,
	EpgProgramRaw
} from '#lib/types/livetv.js';

const REQUEST_TIMEOUT = 30000; // 30 seconds (increased for slow portals)

// STB User-Agent strings (mimic MAG200 set-top box)
// Full version - used for authenticated API calls and stream fetching
export const STB_USER_AGENT =
	'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 4 rev: 2116 Mobile Safari/533.3';

// Lightweight version - used for portal detection/probing (no auth required)
export const STB_USER_AGENT_PROBE =
	'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';

// ============================================================================
// Stalker-specific error classes
// ============================================================================

/**
 * Base class for Stalker protocol errors with HTTP status awareness.
 * The `retryable` flag indicates whether the request can be retried.
 */
export class StalkerProtocolError extends Error {
	readonly statusCode: number;
	readonly retryable: boolean;

	constructor(message: string, statusCode: number, retryable: boolean) {
		super(message);
		this.name = 'StalkerProtocolError';
		this.statusCode = statusCode;
		this.retryable = retryable;
	}
}

/**
 * HTTP 456/459 — Max connections reached or IP lock.
 * Retrying later may work, but immediate retries won't help.
 */
export class StalkerMaxConnectionsError extends StalkerProtocolError {
	constructor(statusCode: number = 456) {
		super(`Max connections or IP lock (HTTP ${statusCode})`, statusCode, false);
		this.name = 'StalkerMaxConnectionsError';
	}
}

/**
 * HTTP 458 — Account blocked/banned by portal.
 * No retry will help; account is dead.
 */
export class StalkerAccountBlockedError extends StalkerProtocolError {
	constructor() {
		super('Account blocked by portal (HTTP 458)', 458, false);
		this.name = 'StalkerAccountBlockedError';
	}
}

/**
 * HTTP 462 — Token/play_token already used (single-use token consumed).
 * Must request a new token via create_link; retrying the same URL is pointless.
 */
export class StalkerTokenUsedError extends StalkerProtocolError {
	constructor() {
		super('Token already used (HTTP 462)', 462, false);
		this.name = 'StalkerTokenUsedError';
	}
}

/**
 * Generate prehash for handshake authentication.
 * Reference implementations (stalkerhek) use prehash=0.
 * All tested portals accept this value.
 */
function generatePrehash(_macAddress: string): string {
	return '0';
}

/**
 * Detect the Stalker portal endpoint type from a portal URL.
 *
 * Portals that use the "/stalker_portal/" path structure use
 * "stalker_portal/server/load.php" as their API endpoint.
 * All other patterns (e.g. "/c", "/c/portal.php") use "portal.php".
 *
 * @param portalUrl - The raw portal URL as provided by the user or stored in config
 * @returns The endpoint path (e.g. "portal.php" or "stalker_portal/server/load.php")
 */
export function detectStalkerEndpoint(portalUrl: string): string {
	if (portalUrl.includes('/stalker_portal/') || portalUrl.endsWith('/stalker_portal')) {
		return 'stalker_portal/server/load.php';
	}
	return 'portal.php';
}

/**
 * Probe a Stalker portal URL to determine the correct API endpoint.
 *
 * Builds candidate endpoint URLs the same way getPortalEndpoint() would,
 * then tests each with a lightweight handshake request. Returns the endpoint
 * value that produces a valid response.
 *
 * Falls back to the URL-path heuristic if probing fails (offline portal, etc.).
 */
export async function probeStalkerEndpoint(portalUrl: string): Promise<string> {
	const url = portalUrl.trim().replace(/\/+$/, '');
	const hasStalkerPortal = url.includes('/stalker_portal/') || url.endsWith('/stalker_portal');

	interface Candidate {
		endpoint: string;
		testUrl: string;
	}

	const candidates: Candidate[] = [];

	if (hasStalkerPortal) {
		if (!url.includes('/portal.php')) {
			candidates.push({ endpoint: 'portal.php', testUrl: `${url}/portal.php` });
		} else {
			candidates.push({ endpoint: 'portal.php', testUrl: url });
		}

		const idx = url.indexOf('/stalker_portal');
		const base = idx > 0 ? url.substring(0, idx) : url;
		candidates.push({
			endpoint: 'stalker_portal/server/load.php',
			testUrl: `${base}/stalker_portal/server/load.php`
		});

		// Some stalker_portal URLs include a sub-path like /c/ or /stalker_portal/c/
		// that routes API calls through portal.php at that path. Test this variant.
		// Example: http://xp1.tv/stalker_portal/c/ → needs /stalker_portal/c/portal.php
		const afterStalker = url.substring(idx + '/stalker_portal'.length);
		if (afterStalker !== '' && afterStalker !== '/') {
			const subPathUrl = `${url}/portal.php`;
			if (subPathUrl !== candidates[0]?.testUrl) {
				candidates.push({ endpoint: 'portal.php', testUrl: subPathUrl });
			}
		}
	} else {
		if (url.includes('/portal.php')) {
			candidates.push({ endpoint: 'portal.php', testUrl: url });
		} else {
			candidates.push({ endpoint: 'portal.php', testUrl: `${url}/portal.php` });
		}
	}

	for (const { endpoint, testUrl } of candidates) {
		try {
			const response = await fetch(
				`${testUrl}?type=stb&action=handshake&token=PROBE&prehash=0&JsHttpRequest=1-xml`,
				{
					method: 'GET',
					signal: AbortSignal.timeout(10000),
					headers: { 'User-Agent': STB_USER_AGENT_PROBE }
				}
			);
			if (response.ok || response.status === 403) {
				return endpoint;
			}
		} catch {
			continue;
		}
	}

	return detectStalkerEndpoint(portalUrl);
}

/**
 * Configuration for Stalker Portal client
 */
export interface StalkerPortalConfig {
	portalUrl: string;
	macAddress: string;
	serialNumber: string;
	deviceId: string;
	deviceId2: string;
	model: string;
	timezone: string;
	/**
	 * Portal UI language sent as the `stb_lang` cookie and `Accept-Language`
	 * header. Expected as a 2-letter ISO 639-1 code; regional/script variants
	 * are reduced to their base tag. Defaults to 'en'.
	 */
	language?: string;
	token?: string;
	username?: string;
	password?: string;
	endpoint?: string;
}

/** Language used when the account config does not specify one. */
const DEFAULT_STALKER_LANGUAGE = 'en';

/**
 * Reduce a configured language to the 2-letter base code Stalker portals
 * understand (`pt-BR` → `pt`), falling back to 'en' for anything unusable.
 */
function normalizeStalkerLanguage(value: string | undefined): string {
	const base = value?.trim().toLowerCase().split('-')[0] ?? '';
	return /^[a-z]{2}$/.test(base) ? base : DEFAULT_STALKER_LANGUAGE;
}

interface StalkerResponse<T> {
	js: T;
	text?: string;
}

interface HandshakeResponse {
	token?: string;
	random?: string;
}

interface _ProfileAuthResponse {
	id?: string;
	fname?: string;
}

interface GenresResponse {
	id: string;
	title: string;
	alias: string;
	censored: string;
}

interface ChannelData {
	id: string;
	name: string;
	number: string;
	logo: string;
	tv_genre_id: string;
	cmd: string;
	tv_archive: string;
	tv_archive_duration: string;
	cmds?: Array<{ id: string; ch_id: string }>;
}

interface ChannelsResponse {
	data: ChannelData[];
	total_items: number;
}

interface AccountInfoResponse {
	mac: string;
	phone: string;
}

interface CreateLinkResponse {
	cmd: string;
}

interface EpgInfoResponse {
	data: Record<string, EpgProgramData[]>;
}

interface EpgProgramData {
	id: string;
	ch_id: string;
	time: string;
	time_to: string;
	duration: number;
	name: string;
	descr: string;
	category: string;
	director: string;
	actor: string;
	start_timestamp: number;
	stop_timestamp: number;
	mark_archive: number;
}

/**
 * Retry configuration
 */
interface RetryConfig {
	maxRetries: number;
	baseDelay: number;
	maxDelay: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxRetries: 3,
	baseDelay: 1000,
	maxDelay: 10000
};

/**
 * Generate a random 32-character hex token
 */
function generateToken(): string {
	return randomBytes(16).toString('hex').toUpperCase();
}

/**
 * Retry with exponential backoff.
 * Automatically skips retries for non-retryable StalkerProtocolError instances.
 * An optional `shouldRetry` predicate can further control retry behavior.
 */
async function _retryWithBackoff<T>(
	fn: () => Promise<T>,
	config: RetryConfig = DEFAULT_RETRY_CONFIG,
	shouldRetry?: (error: Error) => boolean
): Promise<T> {
	let lastError: Error | null = null;

	for (let attempt = 0; attempt < config.maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Non-retryable Stalker protocol errors (458 blocked, 462 token used, etc.)
			if (lastError instanceof StalkerProtocolError && !lastError.retryable) {
				throw lastError;
			}

			// Custom retry predicate
			if (shouldRetry && !shouldRetry(lastError)) {
				throw lastError;
			}

			if (attempt < config.maxRetries - 1) {
				const delay = Math.min(config.baseDelay * Math.pow(2, attempt), config.maxDelay);
				logger.debug(
					{
						error: lastError.message
					},
					`[StalkerPortal] Attempt ${attempt + 1} failed, retrying in ${delay}ms`
				);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	throw lastError;
}

export class StalkerPortalClient {
	private config: StalkerPortalConfig;
	private token: string;
	private authenticated: boolean = false;
	private lastProfile: StalkerRawProfile | null = null;
	private watchdogInterval: ReturnType<typeof setInterval> | null = null;
	private workingEndpoint: string | null = null;
	private static readonly WATCHDOG_INTERVAL_MS = 120_000; // 2 minutes (matches stalkerhek)

	constructor(config: StalkerPortalConfig) {
		// Normalize portal URL - ensure it doesn't end with slash
		this.config = {
			...config,
			portalUrl: config.portalUrl.replace(/\/+$/, ''),
			macAddress: config.macAddress.toUpperCase(),
			language: normalizeStalkerLanguage(config.language)
		};

		// Generate token if not provided
		this.token = config.token || generateToken();
	}

	/** Portal UI language (stb_lang / Accept-Language), normalized to 2 letters. */
	private get language(): string {
		return this.config.language ?? DEFAULT_STALKER_LANGUAGE;
	}

	/**
	 * Get the current token
	 */
	getToken(): string {
		return this.token;
	}

	/**
	 * Check if client is authenticated
	 */
	isAuthenticated(): boolean {
		return this.authenticated;
	}

	/**
	 * Get the portal API endpoint URL.
	 *
	 * Supports two endpoint types:
	 *   — "portal.php" (default): /c/portal.php or /portal.php
	 *   — "stalker_portal/server/load.php": for portals that use
	 *     the stalker_portal directory structure
	 *
	 * Auto-detection heuristic:
	 *   — If `config.endpoint` is explicitly set, use it.
	 *   — If the portal URL path contains "/stalker_portal/", use
	 *     the load.php endpoint (these portals consistently return
	 *     404 on /c/portal.php).
	 *   — Otherwise, fall back to the legacy portal.php logic.
	 */
	private getAlternativeEndpoint(primaryEndpoint: string): string | null {
		const url = this.config.portalUrl.trim().replace(/\/+$/, '');
		const hasStalkerPortal = url.includes('/stalker_portal/') || url.endsWith('/stalker_portal');

		if (!hasStalkerPortal) {
			return null;
		}

		if (primaryEndpoint.includes('server/load.php')) {
			if (!url.includes('/portal.php')) {
				return `${url}/portal.php`;
			}
			return url;
		}

		const idx = url.indexOf('/stalker_portal');
		const base = idx > 0 ? url.substring(0, idx) : url;
		return `${base}/stalker_portal/server/load.php`;
	}

	private getPortalEndpoint(): string {
		if (this.workingEndpoint) {
			return this.workingEndpoint;
		}

		const url = this.config.portalUrl.trim().replace(/\/+$/, '');

		const hasStalkerPortal = url.includes('/stalker_portal/') || url.endsWith('/stalker_portal');
		const endpoint =
			this.config.endpoint || (hasStalkerPortal ? 'stalker_portal/server/load.php' : null);

		if (endpoint === 'stalker_portal/server/load.php') {
			const idx = url.indexOf('/stalker_portal');
			const base = idx > 0 ? url.substring(0, idx) : url;
			return `${base}/${endpoint}`;
		}

		if (url.includes('/portal.php')) {
			return url;
		}
		if (url.endsWith('/c')) {
			return `${url}/portal.php`;
		}
		return `${url}/portal.php`;
	}

	/**
	 * Build cookie string for requests
	 */
	private getCookie(): string {
		const parts = [
			`sn=${encodeURIComponent(this.config.serialNumber)}`,
			`mac=${encodeURIComponent(this.config.macAddress)}`,
			`stb_lang=${this.language}`,
			`timezone=${encodeURIComponent(this.config.timezone)}`
		];
		return parts.join('; ') + ';';
	}

	/**
	 * Build request headers for handshake (no Authorization)
	 */
	private getHandshakeHeaders(): HeadersInit {
		return {
			'User-Agent': STB_USER_AGENT,
			'X-User-Agent': `Model: ${this.config.model}; Link: Ethernet`,
			Accept: '*/*',
			'Accept-Language': this.language,
			Cookie: this.getCookie()
		};
	}

	/**
	 * Build request headers for authenticated requests
	 */
	private getHeaders(): HeadersInit {
		return {
			'User-Agent': STB_USER_AGENT,
			'X-User-Agent': `Model: ${this.config.model}; Link: Ethernet`,
			Accept: '*/*',
			'Accept-Language': this.language,
			Authorization: `Bearer ${this.token}`,
			Cookie: this.getCookie()
		};
	}

	/**
	 * Get headers for streaming from backend servers.
	 * Stream URLs from create_link are self-authenticating via play_token in the URL.
	 * Backend stream servers don't understand portal auth headers (Authorization, Cookie) —
	 * only User-Agent is needed. Sending portal headers to backend servers can cause errors.
	 */
	getStreamHeaders(): HeadersInit {
		return {
			'User-Agent': STB_USER_AGENT
		};
	}

	/**
	 * Get full portal API headers (for portal API calls only, NOT for stream fetching).
	 */
	getPortalHeaders(): HeadersInit {
		return this.getHeaders();
	}

	/**
	 * Make a raw HTTP request to the portal
	 */
	private async httpRequest(url: string, useAuth: boolean = true): Promise<string> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

		try {
			const response = await fetch(url, {
				method: 'GET',
				headers: useAuth ? this.getHeaders() : this.getHandshakeHeaders(),
				signal: controller.signal
			});

			clearTimeout(timeoutId);

			// Handle Stalker-specific HTTP error codes before generic check
			if (response.status === 456 || response.status === 459) {
				throw new StalkerMaxConnectionsError(response.status);
			}
			if (response.status === 458) {
				throw new StalkerAccountBlockedError();
			}
			if (response.status === 462) {
				throw new StalkerTokenUsedError();
			}
			if (!response.ok) {
				throw new StalkerProtocolError(
					`HTTP ${response.status}: ${response.statusText}`,
					response.status,
					response.status >= 500 // 5xx are retryable
				);
			}

			return await response.text();
		} catch (error) {
			clearTimeout(timeoutId);
			if (error instanceof Error && error.name === 'AbortError') {
				throw new Error('Request timed out', { cause: error });
			}
			throw error;
		}
	}

	/**
	 * Make a request to the portal API and parse JSON response
	 */
	private async request<T>(
		type: string,
		action: string,
		params: Record<string, string> = {},
		useAuth: boolean = true
	): Promise<T> {
		const endpoint = this.getPortalEndpoint();
		const url = new URL(endpoint);
		url.searchParams.set('type', type);
		url.searchParams.set('action', action);
		url.searchParams.set('JsHttpRequest', '1-xml');

		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}

		if (action === 'create_link') {
			logger.debug({ fullUrl: url.toString() }, '[StalkerPortal] Request URL');
		}

		const text = await this.httpRequest(url.toString(), useAuth);

		if (action === 'create_link') {
			logger.debug({ text: text.substring(0, 500) }, '[StalkerPortal] Raw response');
		}

		let data: StalkerResponse<T>;
		try {
			data = JSON.parse(text) as StalkerResponse<T>;
		} catch {
			throw new Error(`Invalid JSON response from portal: ${text.substring(0, 200)}`);
		}
		return data.js;
	}

	/**
	 * Start the client - performs handshake and authentication
	 */
	async start(): Promise<void> {
		// Stop any existing watchdog before re-authenticating
		this.stopWatchdog();

		// Step 1: Handshake
		await this.handshake();

		// Step 2: Authenticate
		if (this.config.username && this.config.password) {
			await this.authenticate();
		} else {
			await this.authenticateWithDeviceIds();
		}

		this.authenticated = true;

		// Step 3: Start watchdog keepalive to prevent session expiration
		this.startWatchdog();
	}

	/**
	 * Perform handshake to reserve/obtain token
	 */
	async handshake(): Promise<void> {
		logger.debug(
			{
				portalUrl: this.config.portalUrl,
				mac: this.config.macAddress.substring(0, 8) + '...'
			},
			'[StalkerPortal] Performing handshake'
		);

		try {
			await this.doHandshake(this.getPortalEndpoint());
		} catch (error) {
			const status = error instanceof StalkerProtocolError ? error.statusCode : 0;

			if (status === 404) {
				const primaryEndpoint = this.getPortalEndpoint();
				const alternative = this.getAlternativeEndpoint(primaryEndpoint);

				if (alternative) {
					logger.debug(
						{
							primaryEndpoint,
							alternativeEndpoint: alternative
						},
						'[StalkerPortal] Primary endpoint returned 404, trying alternative'
					);

					try {
						await this.doHandshake(alternative);
						this.workingEndpoint = alternative;
						logger.info(
							{ workingEndpoint: alternative },
							'[StalkerPortal] Alternative endpoint works, cached for future requests'
						);
						return;
					} catch {
						// Alternative also failed, throw original error
					}
				}
			}

			throw error;
		}
	}

	private async doHandshake(endpointUrl: string): Promise<void> {
		const url = new URL(endpointUrl);
		url.searchParams.set('type', 'stb');
		url.searchParams.set('action', 'handshake');
		url.searchParams.set('token', this.token);
		url.searchParams.set('prehash', generatePrehash(this.config.macAddress));
		url.searchParams.set('JsHttpRequest', '1-xml');

		const text = await this.httpRequest(url.toString(), false);

		let data: StalkerResponse<HandshakeResponse>;
		try {
			data = JSON.parse(text) as StalkerResponse<HandshakeResponse>;
		} catch {
			throw new Error(`Invalid JSON from handshake: ${text.substring(0, 200)}`);
		}

		if (data.js?.token && data.js.token !== '') {
			logger.debug('[StalkerPortal] Server provided new token');
			this.token = data.js.token;
		} else {
			logger.debug('[StalkerPortal] Token accepted');
		}
	}

	/**
	 * Authenticate with username/password credentials
	 */
	async authenticate(): Promise<void> {
		if (!this.config.username || !this.config.password) {
			throw new Error('Username and password required for credential authentication');
		}

		logger.debug('[StalkerPortal] Authenticating with credentials');

		const result = await this.request<boolean>(
			'stb',
			'do_auth',
			{
				login: this.config.username,
				password: this.config.password,
				device_id: this.config.deviceId,
				device_id2: this.config.deviceId2
			},
			true
		);

		if (!result) {
			throw new Error('Authentication failed: invalid credentials');
		}

		logger.debug('[StalkerPortal] Credential authentication successful');
	}

	/**
	 * Authenticate using device IDs (alternative to username/password).
	 * Also caches the profile response to avoid a redundant get_profile call later.
	 */
	async authenticateWithDeviceIds(): Promise<void> {
		logger.debug('[StalkerPortal] Authenticating with device IDs');

		const result = await this.request<StalkerRawProfile>(
			'stb',
			'get_profile',
			{
				hd: '1',
				sn: this.config.serialNumber,
				stb_type: this.config.model,
				device_id: this.config.deviceId,
				device_id2: this.config.deviceId2,
				auth_second_step: '1'
			},
			true
		);

		if (!result?.id) {
			throw new Error('Authentication failed: device ID auth rejected');
		}

		// Cache the full profile from auth — avoids redundant get_profile calls
		this.lastProfile = result;

		logger.debug(
			{
				userId: String(result.id),
				name: result.fname
			},
			'[StalkerPortal] Device ID authentication successful'
		);
	}

	/**
	 * Ensure client is authenticated
	 */
	private async ensureAuthenticated(): Promise<void> {
		if (!this.authenticated) {
			await this.start();
		}
	}

	/**
	 * Create a stream link for a channel.
	 * Returns a URL with a single-use play_token — each URL can only be used once.
	 * Does NOT use _retryWithBackoff because each create_link call returns a fresh
	 * token; retrying the same request just wastes time on non-retryable errors.
	 *
	 * @param cmd - The channel CMD value (e.g., "ffmpeg http://...")
	 * @param retry - Whether to retry with re-authentication on failure
	 * @returns The playable stream URL (single-use)
	 */
	async createLink(cmd: string, retry: boolean = true): Promise<string> {
		await this.ensureAuthenticated();

		logger.debug({ cmd }, '[StalkerPortal] Creating link');

		let result: CreateLinkResponse;
		try {
			result = await this.request<CreateLinkResponse>('itv', 'create_link', {
				cmd: cmd
			});
		} catch (error) {
			// Non-retryable errors — don't attempt re-auth
			if (error instanceof StalkerAccountBlockedError) throw error;
			if (error instanceof StalkerTokenUsedError) throw error;
			if (error instanceof StalkerMaxConnectionsError) throw error;

			// For other errors (session expired, transient failures), try re-auth once
			if (retry) {
				logger.debug(
					{
						error: error instanceof Error ? error.message : String(error)
					},
					'[StalkerPortal] create_link failed, attempting re-authentication'
				);
				this.authenticated = false;
				await this.start();
				return this.createLink(cmd, false);
			}
			throw error;
		}

		logger.debug({ result }, '[StalkerPortal] create_link response');

		if (!result?.cmd) {
			if (retry) {
				// Session may have expired, try re-authenticating
				logger.debug('[StalkerPortal] create_link returned empty, attempting re-authentication');
				this.authenticated = false;
				await this.start();
				return this.createLink(cmd, false);
			}
			throw new Error('create_link failed: empty response');
		}

		// Parse the URL from the response
		// Response format: "ffmpeg http://actual-stream-url" or just the URL
		const cmdStr = result.cmd.trim();
		const parts = cmdStr.split(/\s+/);
		const streamUrl = parts[parts.length - 1];

		if (!streamUrl || (!streamUrl.startsWith('http://') && !streamUrl.startsWith('https://'))) {
			throw new Error(`create_link returned invalid URL: ${cmdStr}`);
		}

		logger.info({ streamUrl }, '[StalkerPortal] createLink returning URL');

		return streamUrl;
	}

	/**
	 * Send watchdog keep-alive
	 */
	async watchdog(): Promise<void> {
		await this.ensureAuthenticated();

		await this.request<unknown>('watchdog', 'get_events', {
			event_active_id: '0',
			init: '0',
			cur_play_type: '1'
		});
	}

	/**
	 * Start periodic watchdog keepalive.
	 * Stalker portal sessions expire after inactivity. Both stalkerhek implementations
	 * send watchdog every ~2 minutes to keep the session alive.
	 */
	private startWatchdog(): void {
		this.stopWatchdog(); // Clear any existing interval

		this.watchdogInterval = setInterval(() => {
			this.watchdog().catch((err) => {
				logger.warn(
					{
						portalUrl: this.config.portalUrl,
						error: err instanceof Error ? err.message : String(err)
					},
					'[StalkerPortal] Watchdog keepalive failed'
				);
				// Session likely expired — mark as unauthenticated so next request re-auths
				this.authenticated = false;
				this.stopWatchdog();
			});
		}, StalkerPortalClient.WATCHDOG_INTERVAL_MS);

		// Don't block Node.js exit on the watchdog timer
		if (
			this.watchdogInterval &&
			typeof this.watchdogInterval === 'object' &&
			'unref' in this.watchdogInterval
		) {
			this.watchdogInterval.unref();
		}

		logger.debug(
			{
				portalUrl: this.config.portalUrl,
				intervalMs: StalkerPortalClient.WATCHDOG_INTERVAL_MS
			},
			'[StalkerPortal] Watchdog started'
		);
	}

	/**
	 * Stop the watchdog keepalive timer
	 */
	private stopWatchdog(): void {
		if (this.watchdogInterval) {
			clearInterval(this.watchdogInterval);
			this.watchdogInterval = null;
		}
	}

	/**
	 * Stop the client — clears watchdog timer and marks as unauthenticated.
	 * Should be called when the client is no longer needed.
	 */
	stop(): void {
		this.stopWatchdog();
		this.authenticated = false;
		logger.debug(
			{
				portalUrl: this.config.portalUrl
			},
			'[StalkerPortal] Client stopped'
		);
	}

	/**
	 * Get account profile information
	 */
	async getProfile(): Promise<StalkerRawProfile> {
		await this.ensureAuthenticated();
		return this.request<StalkerRawProfile>('stb', 'get_profile');
	}

	/**
	 * Get account info (contains expiry in phone field for many providers)
	 */
	async getAccountInfo(): Promise<AccountInfoResponse | null> {
		await this.ensureAuthenticated();
		try {
			return await this.request<AccountInfoResponse>('account_info', 'get_main_info');
		} catch {
			// Some portals don't support this endpoint
			return null;
		}
	}

	/**
	 * Get channel categories/genres
	 */
	async getGenres(): Promise<StalkerCategory[]> {
		await this.ensureAuthenticated();
		const genres = await this.request<GenresResponse[]>('itv', 'get_genres');

		return genres.map((g) => ({
			id: g.id,
			title: g.title,
			alias: g.alias,
			censored: g.censored === '1'
		}));
	}

	/**
	 * Get fresh stream URL for a channel by stalker_id.
	 * Always uses create_link with a normalized localhost cmd format.
	 * This is the format the portal expects — passing full URLs causes
	 * the portal to strip the stream ID, returning broken URLs.
	 */
	async getFreshStreamUrl(
		stalkerId: string,
		_urlType: 'direct' | 'create_link' | 'unknown' | null = 'unknown'
	): Promise<string> {
		// Always use the normalized localhost cmd format for create_link.
		// Portals expect: "ffmpeg http://localhost/ch/{channelId}_"
		// When full URLs are passed, many portals strip the stream ID (returning stream=&id=null).
		// The portal resolves the localhost template to the real streaming URL with a fresh token.
		const normalizedCmd = `ffmpeg http://localhost/ch/${stalkerId}_`;

		logger.debug(
			{
				stalkerId,
				normalizedCmd
			},
			'[StalkerPortal] Using create_link for fresh stream URL'
		);
		return this.createLink(normalizedCmd);
	}

	/**
	 * Get all channels
	 */
	async getChannels(): Promise<StalkerChannel[]> {
		await this.ensureAuthenticated();
		const result = await this.request<ChannelsResponse | ChannelData[]>('itv', 'get_all_channels');

		// Some portals return an array directly, others return {data: [], total_items: N}
		// A few portals return a dict keyed by channel ID: {"1": {id: "1", ...}, "2": {...}}
		let channels: ChannelData[] | undefined = Array.isArray(result)
			? result
			: (result as ChannelsResponse).data;

		// Handle dict-format: convert object values to array
		if (!Array.isArray(channels) && typeof channels === 'object' && channels !== null) {
			channels = Object.values(channels as Record<string, ChannelData>);
		}

		if (!channels || !Array.isArray(channels) || channels.length === 0) {
			return [];
		}

		return channels.map((ch) => ({
			id: ch.id,
			name: ch.name,
			number: ch.number,
			logo: ch.logo,
			genreId: ch.tv_genre_id,
			cmd: ch.cmd,
			tvArchive: ch.tv_archive === '1',
			archiveDuration: parseInt(ch.tv_archive_duration, 10) || 0
		}));
	}

	/**
	 * Get channel count (more efficient than fetching all channels)
	 */
	async getChannelCount(): Promise<number> {
		await this.ensureAuthenticated();
		const result = await this.request<ChannelsResponse | ChannelData[]>('itv', 'get_all_channels');

		// Some portals return an array directly, others return {data: [], total_items: N}
		// A few portals return a dict keyed by channel ID
		if (Array.isArray(result)) {
			return result.length;
		}
		const response = result as ChannelsResponse;
		if (response.total_items) {
			return response.total_items;
		}
		if (response.data) {
			if (Array.isArray(response.data)) {
				return response.data.length;
			}
			if (typeof response.data === 'object') {
				return Object.keys(response.data as Record<string, unknown>).length;
			}
		}
		return 0;
	}

	/**
	 * Get EPG (Electronic Program Guide) data for all channels.
	 * @param period - Number of hours of EPG data to fetch (default: 24)
	 * @returns Map of channel ID to array of programs
	 */
	async getEpgInfo(period: number = 24): Promise<Map<string, EpgProgramRaw[]>> {
		await this.ensureAuthenticated();

		logger.debug(
			{
				portalUrl: this.config.portalUrl,
				period
			},
			'[StalkerPortal] Fetching EPG info'
		);

		try {
			const result = await this.request<EpgInfoResponse | Record<string, EpgProgramData[]>>(
				'itv',
				'get_epg_info',
				{ period: period.toString() }
			);

			// Response can be either { data: { channelId: programs[] } } or just { channelId: programs[] }
			let epgData: Record<string, EpgProgramData[]>;
			if ('data' in result && typeof result.data === 'object' && result.data !== null) {
				epgData = result.data as Record<string, EpgProgramData[]>;
			} else {
				epgData = result as Record<string, EpgProgramData[]>;
			}

			const programMap = new Map<string, EpgProgramRaw[]>();

			for (const [channelId, programs] of Object.entries(epgData)) {
				if (!Array.isArray(programs)) continue;

				const mappedPrograms: EpgProgramRaw[] = programs.map((p) => ({
					id: p.id,
					ch_id: p.ch_id || channelId,
					time: p.time,
					time_to: p.time_to,
					duration: Math.abs(p.duration), // Duration can be negative in some responses
					name: p.name || '',
					descr: p.descr || '',
					category: p.category || '',
					director: p.director || '',
					actor: p.actor || '',
					start_timestamp: p.start_timestamp,
					stop_timestamp: p.stop_timestamp,
					mark_archive: p.mark_archive || 0
				}));

				if (mappedPrograms.length > 0) {
					programMap.set(channelId, mappedPrograms);
				}
			}

			logger.debug(
				{
					channelCount: programMap.size,
					totalPrograms: Array.from(programMap.values()).reduce((sum, arr) => sum + arr.length, 0)
				},
				'[StalkerPortal] EPG fetch complete'
			);

			return programMap;
		} catch (error) {
			logger.error(
				{
					portalUrl: this.config.portalUrl,
					error: error instanceof Error ? error.message : 'Unknown error'
				},
				'[StalkerPortal] EPG fetch failed'
			);
			return new Map();
		}
	}

	/**
	 * Get short EPG (current and next program) for a single channel.
	 * More efficient than getEpgInfo when you only need current/next for one channel.
	 * @param channelId - Stalker channel ID
	 * @returns Array of programs (typically 1-2 items for current and next)
	 */
	async getShortEpg(channelId: string): Promise<EpgProgramRaw[]> {
		await this.ensureAuthenticated();

		try {
			const result = await this.request<EpgProgramData[]>('itv', 'get_short_epg', {
				ch_id: channelId
			});

			if (!Array.isArray(result)) {
				return [];
			}

			return result.map((p) => ({
				id: p.id,
				ch_id: p.ch_id || channelId,
				time: p.time,
				time_to: p.time_to,
				duration: Math.abs(p.duration),
				name: p.name || '',
				descr: p.descr || '',
				category: p.category || '',
				director: p.director || '',
				actor: p.actor || '',
				start_timestamp: p.start_timestamp,
				stop_timestamp: p.stop_timestamp,
				mark_archive: p.mark_archive || 0
			}));
		} catch {
			return [];
		}
	}

	/**
	 * Parse expiration date from a string.
	 * Handles various formats like:
	 * - "January 19, 2027, 7:19 pm"
	 * - "2027-01-19 19:19:00"
	 * - "Jan 19, 2027"
	 */
	private parseExpiryFromString(value: string | null | undefined): string | null {
		if (!value || value === '0000-00-00 00:00:00' || value === '') {
			return null;
		}

		// Try direct parse first
		const parsed = new Date(value);
		if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 2000) {
			return parsed.toISOString();
		}

		// Try to extract date from string (e.g., "January 19, 2027, 7:19 pm" or "Expires: Jan 19, 2027")
		const dateMatch = value.match(
			/(\w+\s+\d{1,2},?\s+\d{4})|(\d{4}-\d{2}-\d{2})|(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/
		);
		if (dateMatch) {
			const extracted = new Date(dateMatch[0]);
			if (!isNaN(extracted.getTime()) && extracted.getFullYear() > 2000) {
				return extracted.toISOString();
			}
		}

		return null;
	}

	/**
	 * Parse expiration date from profile data and account info.
	 * Different portals store expiry in different fields/endpoints.
	 */
	private parseExpiryDate(
		profile: StalkerRawProfile,
		accountInfo: AccountInfoResponse | null
	): string | null {
		// Try account_info phone field first (most reliable for many providers)
		if (accountInfo?.phone) {
			const fromAccountInfo = this.parseExpiryFromString(accountInfo.phone);
			if (fromAccountInfo) return fromAccountInfo;
		}

		// Try profile fields
		const candidates = [profile.expire_billing_date, profile.tariff_expired_date, profile.phone];

		for (const candidate of candidates) {
			const parsed = this.parseExpiryFromString(candidate);
			if (parsed) return parsed;
		}

		return null;
	}

	/**
	 * Verify that a stream is actually reachable by picking a random channel,
	 * calling create_link, and making a HEAD request to the resulting URL.
	 * This is the real test — profile metadata flags are unreliable.
	 *
	 * @param channels - Array of channels to pick from (uses a random one)
	 * @returns true if a stream was successfully reached, false otherwise
	 */
	private async verifyStream(channels: StalkerChannel[]): Promise<boolean> {
		if (channels.length === 0) return false;

		// Pick a random channel to test
		const channel = channels[Math.floor(Math.random() * channels.length)];

		try {
			// create_link to get a playable URL (single-use play_token)
			const streamUrl = await this.createLink(channel.cmd);

			// Follow the redirect and verify the stream is reachable with a HEAD request.
			// We use manual redirect to capture the backend URL (302 from portal to stream server).
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 10000);

			try {
				const response = await fetch(streamUrl, {
					method: 'GET',
					headers: this.getStreamHeaders(),
					signal: controller.signal,
					redirect: 'follow'
				});

				// Read a tiny amount of data to confirm the stream is actually delivering content
				const reader = response.body?.getReader();
				if (reader) {
					try {
						const { done, value } = await reader.read();
						reader.cancel();
						// If we got any bytes at all, stream is working
						return !done && (value?.length ?? 0) > 0;
					} catch {
						reader.cancel();
						return false;
					}
				}

				// No body reader available — fall back to status check
				return response.ok || response.status === 200;
			} finally {
				clearTimeout(timeoutId);
			}
		} catch (error) {
			logger.debug(
				{
					channelName: channel.name,
					error: error instanceof Error ? error.message : String(error)
				},
				'[StalkerPortal] Stream verification failed'
			);
			return false;
		}
	}

	/**
	 * Test connection and fetch account metadata.
	 * Verifies the account works end-to-end: auth, channel list, and actual streaming.
	 * Does NOT rely on profile blocked/status flags — those are unreliable across portals.
	 */
	async testConnection(): Promise<StalkerAccountTestResult> {
		try {
			// Step 1: Start (handshake + auth, which caches profile for MAC-only auth)
			await this.start();

			// Step 2: Get profile (reuse cached profile from auth if available)
			const profile = this.lastProfile ?? (await this.getProfile());

			// Step 3: Get account info (for expiry date)
			const accountInfo = await this.getAccountInfo();

			// Step 4: Get genres (categories)
			const genres = await this.getGenres();

			// Step 5: Get all channels
			const channels = await this.getChannels();

			// No channels = useless account
			if (channels.length === 0) {
				return {
					success: false,
					error: 'No channels available (portal may block API access)'
				};
			}

			const expiresAt = this.parseExpiryDate(profile, accountInfo);

			// Step 6: Verify a random stream actually works (the real test)
			const streamVerified = await this.verifyStream(channels);

			return {
				success: true,
				profile: {
					playbackLimit: profile.playback_limit || 1,
					channelCount: channels.length,
					categoryCount: genres.length,
					expiresAt,
					serverTimezone: profile.default_timezone || 'UTC',
					streamVerified
				}
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			logger.error(
				{
					portalUrl: this.config.portalUrl,
					error: message
				},
				'[StalkerPortal] Connection test failed'
			);

			return {
				success: false,
				error: message
			};
		}
	}

	/**
	 * Fast connection test for scanning — uses fewer API calls (3 instead of 5-6).
	 * Only performs: handshake + get_profile (via auth) + get_all_channels.
	 * Skips: get_main_info, get_genres, stream verification (deferred to approval/full test).
	 * Expiry parsing uses only profile fields (no account_info phone field).
	 */
	async testConnectionFast(): Promise<StalkerAccountTestResult> {
		try {
			// Step 1: Start (handshake + auth via get_profile — caches profile)
			await this.start();

			// Step 2: Reuse profile from auth (no redundant get_profile call)
			const profile = this.lastProfile;
			if (!profile) {
				return { success: false, error: 'No profile data from authentication' };
			}

			// Step 3: Get channel count only (skip genres/account_info for speed)
			const channelCount = await this.getChannelCount();

			if (channelCount === 0) {
				return {
					success: false,
					error: 'No channels available'
				};
			}

			// Parse expiry from profile fields only (skip account_info for speed)
			const expiresAt = this.parseExpiryDate(profile, null);

			return {
				success: true,
				profile: {
					playbackLimit: profile.playback_limit || 1,
					channelCount,
					categoryCount: 0, // Unknown — deferred to approval
					expiresAt,
					serverTimezone: profile.default_timezone || 'UTC',
					streamVerified: false // Not verified during fast scan
				}
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return { success: false, error: message };
		}
	}
}

/**
 * Create a new Stalker Portal client instance
 */
export function createStalkerClient(config: StalkerPortalConfig): StalkerPortalClient {
	return new StalkerPortalClient(config);
}
