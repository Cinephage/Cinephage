import { createIndexerHttp } from '#lib/server/indexers/http/index.js';
import type { IndexerHttp } from '#lib/server/indexers/http/index.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { CinephageSettingsService } from '../settings/CinephageSettingsService.js';
import { getCinephageSettingsService } from '../settings/CinephageSettingsService.js';
import { getServerIdentity, type CinephageServerIdentity } from './version.js';

/**
 * CinephageCore — the single owner of the api.cinephage.net connection.
 *
 * Responsibilities:
 *   - Hold the shared IndexerHttp instance (rate-limited, retrying)
 *   - Resolve the running server's identity (version + commit) for headers
 *   - Auto-sync the identity to the latest published release, because the
 *     api.cinephage.net gateway only accepts the newest release pair
 *   - Expose request() that auto-injects base URL + X-Cinephage-* headers
 *
 * This is the canonical replacement for the four duplicated API clients that
 * existed before (CinephageApiService, CinephageBackendClient, the IPTV
 * provider's inline fetcher, the cinephage-iptv/countries route's inline
 * fetcher). All api.cinephage.net traffic in the codebase should route
 * through this object.
 */
const logger = createChildLogger({ module: 'CinephageCore', logDomain: 'system' });

export class CinephageCore {
	private readonly http: IndexerHttp;
	private readonly settings: CinephageSettingsService;
	private readonly githubApiBase: string;

	/** Keep the identity within this window before refreshing it again. */
	static readonly IDENTITY_SYNC_TTL_MS = 6 * 60 * 60 * 1000;
	/** Minimum gap between forced refreshes (e.g. 401 self-heal) to avoid hammering GitHub. */
	static readonly IDENTITY_SYNC_MIN_INTERVAL_MS = 60 * 1000;

	private lastSyncAttempt = 0;
	private syncInFlight: Promise<void> | null = null;

	constructor(
		settings: CinephageSettingsService = getCinephageSettingsService(),
		options: { githubApiBase?: string } = {}
	) {
		this.settings = settings;
		this.githubApiBase = options.githubApiBase ?? 'https://api.github.com';
		// Synthetic indexerId for rate-limit keying — this client is shared
		// across all modules and doesn't correspond to a real indexer row.
		this.http = createIndexerHttp({
			indexerId: 'cinephage-api',
			indexerName: 'Cinephage API',
			baseUrl: 'https://api.cinephage.net',
			rateLimit: { requests: 60, periodMs: 60_000 },
			defaultTimeout: 30_000,
			retry: { maxRetries: 2, initialDelayMs: 500 }
		});
	}

	/** The shared HTTP client. Modules use this directly for non-trivial requests. */
	getHttpClient(): IndexerHttp {
		return this.http;
	}

	/** Subsystem enabled state from settings. */
	async isEnabled(): Promise<boolean> {
		const config = await this.settings.getConfig();
		return config.enabled;
	}

	/** Configured base URL (defaults to https://api.cinephage.net). */
	async getBaseUrl(): Promise<string> {
		const config = await this.settings.getConfig();
		return config.baseUrl;
	}

	/**
	 * Resolved server identity (version + commit). Resolution per field:
	 * manual override → auto-synced latest release → APP_VERSION/APP_COMMIT.
	 */
	async getIdentity(): Promise<CinephageServerIdentity> {
		const config = await this.settings.getConfig();
		return getServerIdentity({
			versionOverride: config.versionOverride,
			commitOverride: config.commitOverride,
			latestVersion: config.autoUpdate ? config.latestVersion : null,
			latestCommit: config.autoUpdate ? config.latestCommit : null
		});
	}

	/**
	 * Build the X-Cinephage-* auth headers. Empty object when identity is
	 * not fully resolvable (e.g. APP_COMMIT missing in a dev checkout).
	 */
	async getAuthHeaders(): Promise<Record<string, string>> {
		const identity = await this.getIdentity();
		if (!identity.isConfigured || !identity.commit) {
			logger.debug(
				{ version: identity.version, commit: identity.commit },
				'CinephageCore identity not fully configured — omitting auth headers'
			);
			return {};
		}
		return {
			'X-Cinephage-Version': identity.version,
			'X-Cinephage-Commit': identity.commit
		};
	}

	/**
	 * Refresh the auto-synced identity to the latest published release.
	 *
	 * The api.cinephage.net gateway only accepts the newest release pair, so
	 * stale identities fail every authenticated call with HTTP 401. Call this
	 * with force=true from 401 handlers to self-heal; the regular TTL keeps
	 * the identity fresh in the background.
	 *
	 * Deduplicates concurrent runs; forced refreshes respect a minimum
	 * interval to avoid hammering the GitHub API.
	 */
	async refreshLatestIdentity(force = false): Promise<void> {
		if (this.syncInFlight) {
			return this.syncInFlight;
		}

		const config = await this.settings.getConfig();
		if (!config.enabled || !config.autoUpdate) {
			return;
		}

		const now = Date.now();
		if (!force && now - this.lastSyncAttempt < CinephageCore.IDENTITY_SYNC_TTL_MS) {
			return;
		}
		if (force && now - this.lastSyncAttempt < CinephageCore.IDENTITY_SYNC_MIN_INTERVAL_MS) {
			return;
		}
		this.lastSyncAttempt = now;

		this.syncInFlight = this.fetchAndPersistLatestIdentity().finally(() => {
			this.syncInFlight = null;
		});
		return this.syncInFlight;
	}

	/**
	 * Flip the stored auto-synced version between its 'v'-prefixed and bare
	 * forms. The api.cinephage.net gateway has historically validated the
	 * release pair in both formats, so a 401 can be healed by toggling and
	 * retrying before falling back to a full re-sync.
	 *
	 * Returns the identity using the toggled format, or null when no
	 * auto-synced identity exists (nothing to toggle).
	 */
	async toggleVersionFormat(): Promise<CinephageServerIdentity | null> {
		const config = await this.settings.getConfig();
		if (!config.autoUpdate || !config.latestVersion) {
			return null;
		}

		const toggled = config.latestVersion.startsWith('v')
			? config.latestVersion.slice(1)
			: `v${config.latestVersion}`;
		await this.settings.updateConfig({ latestVersion: toggled });
		return this.getIdentity();
	}

	/**
	 * Issue a GET request to a path under the configured base URL with the
	 * X-Cinephage-* auth headers automatically injected. Callers pass a path
	 * like '/api/v1/iptv/countries'; the base URL prefix is added here.
	 *
	 * For requests that need custom auth, query params, or non-GET methods,
	 * call getHttpClient() directly and assemble headers via getAuthHeaders().
	 */
	async get(path: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) {
		const baseUrl = await this.getBaseUrl();
		const authHeaders = await this.getAuthHeaders();
		const url = new URL(path, baseUrl + (baseUrl.endsWith('/') ? '' : '/')).toString();
		return this.http.get(url, {
			headers: { Accept: 'application/json', ...authHeaders, ...(init?.headers ?? {}) },
			signal: init?.signal
		});
	}

	/**
	 * Fetch the latest release from GitHub and persist it as the auto-synced
	 * identity (version without the 'v' prefix + 7-char commit short-SHA —
	 * exactly the format the api.cinephage.net gateway validates).
	 */
	private async fetchAndPersistLatestIdentity(): Promise<void> {
		try {
			const releaseResponse = await fetch(
				`${this.githubApiBase}/repos/cinephage/cinephage/releases/latest`,
				{
					headers: { Accept: 'application/vnd.github+json' },
					signal: AbortSignal.timeout(15_000)
				}
			);
			if (!releaseResponse.ok) {
				throw new Error(`GitHub releases/latest returned HTTP ${releaseResponse.status}`);
			}

			const release = (await releaseResponse.json()) as { tag_name?: string };
			const tagName = release.tag_name;
			if (!tagName) {
				throw new Error('GitHub releases/latest returned no tag_name');
			}

			const commitResponse = await fetch(
				`${this.githubApiBase}/repos/cinephage/cinephage/commits/${encodeURIComponent(tagName)}`,
				{
					headers: { Accept: 'application/vnd.github+json' },
					signal: AbortSignal.timeout(15_000)
				}
			);
			if (!commitResponse.ok) {
				throw new Error(`GitHub commits/${tagName} returned HTTP ${commitResponse.status}`);
			}

			const commitData = (await commitResponse.json()) as { sha?: string };
			const commitSha = commitData.sha;
			if (!commitSha) {
				throw new Error(`GitHub commits/${tagName} returned no sha`);
			}

			const version = tagName;
			const commit = commitSha.slice(0, 7);

			await this.settings.updateConfig({ latestVersion: version, latestCommit: commit });

			logger.info(
				{ version, commit, tag: tagName },
				'Cinephage identity auto-synced to latest release'
			);
		} catch (error) {
			logger.warn(
				{
					err: error instanceof Error ? error.message : String(error),
					lastSyncAttempt: this.lastSyncAttempt
				},
				'Cinephage identity sync failed — keeping last known identity'
			);
		}
	}
}

// Singleton management (matches codebase convention)
let _instance: CinephageCore | null = null;

export function getCinephageCore(): CinephageCore {
	if (!_instance) {
		_instance = new CinephageCore();
	}
	return _instance;
}

export function resetCinephageCore(): void {
	_instance = null;
}
