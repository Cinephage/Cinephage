/**
 * Base Subtitle Provider - Common functionality for all providers
 *
 * Based on Bazarr's subliminal_patch Provider pattern with lifecycle management.
 */

import type { ISubtitleProvider, ProviderTestResult } from './interfaces';
import type {
	SubtitleSearchCriteria,
	SubtitleSearchResult,
	SubtitleProviderConfig,
	ProviderSearchOptions,
	LanguageCode
} from '../types';
import { TimeoutError, ConnectionError } from '../errors/ProviderErrors';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'subtitles' as const });
import { normalizeLanguageCode } from '#lib/shared/languages.js';
import { languageSatisfies } from '../requirement-matcher';

/**
 * Provider state enum
 */
export enum ProviderState {
	/** Provider not yet initialized */
	UNINITIALIZED = 'uninitialized',
	/** Provider is initializing */
	INITIALIZING = 'initializing',
	/** Provider is ready for use */
	READY = 'ready',
	/** Provider is in error state */
	ERROR = 'error',
	/** Provider has been terminated */
	TERMINATED = 'terminated'
}

/**
 * Provider capability flags
 */
export interface ProviderCapabilities {
	/** Whether hash matches can be verified */
	hashVerifiable: boolean;
	/** Whether HI status can be verified */
	hearingImpairedVerifiable: boolean;
	/** Whether to skip wrong FPS subtitles */
	skipWrongFps: boolean;
	/** Whether this provider supports TV shows */
	supportsTvShows: boolean;
	/** Whether this provider supports movies */
	supportsMovies: boolean;
	/** Whether this provider supports anime */
	supportsAnime: boolean;
}

/**
 * Default provider capabilities
 */
export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
	hashVerifiable: false,
	hearingImpairedVerifiable: false,
	skipWrongFps: true,
	supportsTvShows: true,
	supportsMovies: true,
	supportsAnime: false
};

/**
 * Abstract base class for subtitle providers.
 * Implements common functionality, lifecycle management, and logging.
 *
 * Based on Bazarr's subliminal_patch/providers/__init__.py Provider class.
 */
export abstract class BaseSubtitleProvider implements ISubtitleProvider {
	protected config: SubtitleProviderConfig;

	/** Current provider state */
	protected _state: ProviderState = ProviderState.UNINITIALIZED;

	/** Provider capabilities */
	protected _capabilities: ProviderCapabilities = { ...DEFAULT_CAPABILITIES };

	/** Time when provider was initialized */
	protected _initializedAt?: Date;

	/** Last error that occurred */
	protected _lastError?: Error;

	/** Number of consecutive failures */
	protected _consecutiveFailures = 0;

	/** Maximum consecutive failures before auto-terminate */
	protected _maxConsecutiveFailures = 5;

	constructor(config: SubtitleProviderConfig) {
		this.config = config;
	}

	// ============================================================================
	// LIFECYCLE METHODS (Bazarr pattern)
	// ============================================================================

	/**
	 * Initialize the provider.
	 *
	 * Called before first use. Override in subclasses to:
	 * - Authenticate with API
	 * - Establish sessions
	 * - Load cached tokens
	 */
	async initialize(): Promise<void> {
		if (this._state === ProviderState.READY) {
			return; // Already initialized
		}

		this._state = ProviderState.INITIALIZING;
		try {
			await this.onInitialize();
			this._state = ProviderState.READY;
			this._initializedAt = new Date();
			this._consecutiveFailures = 0;
			logger.debug(`[${this.name}] Provider initialized`);
		} catch (error) {
			this._state = ProviderState.ERROR;
			this._lastError = error instanceof Error ? error : new Error(String(error));
			logger.error({ err: this._lastError }, `[${this.name}] Failed to initialize`);
			throw error;
		}
	}

	/**
	 * Override in subclasses to perform initialization
	 */
	protected async onInitialize(): Promise<void> {
		// Default: no-op
	}

	/**
	 * Terminate the provider.
	 *
	 * Called when provider is being shut down. Override in subclasses to:
	 * - Close sessions
	 * - Save cached tokens
	 * - Clean up resources
	 */
	async terminate(): Promise<void> {
		if (this._state === ProviderState.TERMINATED) {
			return; // Already terminated
		}

		try {
			await this.onTerminate();
			logger.debug(`[${this.name}] Provider terminated`);
		} catch (error) {
			logger.warn(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				`[${this.name}] Error during termination`
			);
		} finally {
			this._state = ProviderState.TERMINATED;
		}
	}

	/**
	 * Override in subclasses to perform cleanup
	 */
	protected async onTerminate(): Promise<void> {
		// Default: no-op
	}

	/**
	 * Check if the provider is alive/healthy.
	 *
	 * Quick health check - should be fast and not count against rate limits.
	 */
	async ping(): Promise<boolean> {
		if (this._state !== ProviderState.READY) {
			return false;
		}

		try {
			return await this.onPing();
		} catch {
			return false;
		}
	}

	/**
	 * Override in subclasses for custom health check
	 */
	protected async onPing(): Promise<boolean> {
		// Default: provider is alive if in READY state
		return this._state === ProviderState.READY;
	}

	/**
	 * Reinitialize provider after error.
	 *
	 * Terminates and re-initializes the provider.
	 */
	async reinitialize(): Promise<void> {
		logger.info(`[${this.name}] Reinitializing provider`);
		await this.terminate();
		await this.initialize();
	}

	// ============================================================================
	// STATE ACCESSORS
	// ============================================================================

	/** Get current provider state */
	get state(): ProviderState {
		return this._state;
	}

	/** Check if provider is ready for use */
	get isReady(): boolean {
		return this._state === ProviderState.READY;
	}

	/** Get provider capabilities */
	get capabilities(): ProviderCapabilities {
		return this._capabilities;
	}

	/** Get last error */
	get lastError(): Error | undefined {
		return this._lastError;
	}

	/** Get consecutive failure count */
	get consecutiveFailures(): number {
		return this._consecutiveFailures;
	}

	/**
	 * Record a failure.
	 * If max consecutive failures reached, auto-terminate.
	 */
	protected recordFailure(error: Error): void {
		this._consecutiveFailures++;
		this._lastError = error;

		if (this._consecutiveFailures >= this._maxConsecutiveFailures) {
			logger.warn(`[${this.name}] Max consecutive failures reached, terminating`);
			this.terminate().catch(() => {});
		}
	}

	/**
	 * Record a success (resets failure counter)
	 */
	protected recordSuccess(): void {
		this._consecutiveFailures = 0;
	}

	/** Provider ID from config */
	get id(): string {
		return this.config.id;
	}

	/** Provider display name */
	get name(): string {
		return this.config.name;
	}

	/** Provider implementation type */
	abstract get implementation(): string;

	/** Request priority (lower runs first); defaults to 25 when unset. */
	get priority(): number {
		return this.config.priority ?? 25;
	}

	/** Languages supported by this provider */
	abstract get supportedLanguages(): LanguageCode[];

	/** Whether this provider supports hash-based matching */
	abstract get supportsHashSearch(): boolean;

	/**
	 * Search for subtitles - to be implemented by subclasses
	 */
	abstract search(
		criteria: SubtitleSearchCriteria,
		options?: ProviderSearchOptions
	): Promise<SubtitleSearchResult[]>;

	/**
	 * Download a subtitle - to be implemented by subclasses
	 */
	abstract download(result: SubtitleSearchResult): Promise<Buffer>;

	/**
	 * Test provider connectivity - to be implemented by subclasses
	 */
	abstract test(): Promise<ProviderTestResult>;

	/**
	 * Default implementation - checks if any requested language is supported.
	 *
	 * Languages are compared with the shared `languageSatisfies` rule (the same
	 * base/region semantics the requirement matcher uses) instead of exact array
	 * membership:
	 * - a provider that supports a bare base tag (`pt`) can serve a regional
	 *   requirement (`pt-BR`) because the provider may return a regional variant;
	 * - a provider that supports a regional tag (`pt-BR`) can serve a bare base
	 *   requirement (`pt`) because a base requirement accepts any region;
	 * - disjoint regions/scripts (`pt-BR` vs `pt-PT`, `zh-Hans` vs `zh-Hant`)
	 *   are rejected.
	 */
	canSearch(criteria: SubtitleSearchCriteria): boolean {
		// Check if we support at least one of the requested languages.
		const hasLanguageSupport = criteria.languages.some((lang) =>
			this.supportedLanguages.some(
				(supported) => languageSatisfies(supported, lang) || languageSatisfies(lang, supported)
			)
		);

		// Need at least a title or hash to search
		const hasSearchableInfo = criteria.title || criteria.videoHash;

		return hasLanguageSupport && !!hasSearchableInfo;
	}

	/**
	 * Helper: Log search operation
	 */
	protected logSearch(criteria: SubtitleSearchCriteria, resultCount: number): void {
		logger.debug(
			{
				provider: this.name,
				title: criteria.title,
				languages: criteria.languages,
				resultCount
			},
			`[${this.name}] Search completed`
		);
	}

	/**
	 * Helper: Log error
	 */
	protected logError(operation: string, error: unknown): void {
		logger.error(
			{
				provider: this.name,
				error: error instanceof Error ? error.message : String(error)
			},
			`[${this.name}] ${operation} failed`
		);
	}

	/**
	 * Helper: Make HTTP request with error handling
	 * Converts network errors to typed ProviderErrors for proper throttling
	 */
	protected async fetchWithTimeout(
		url: string,
		options: RequestInit & { timeout?: number } = {}
	): Promise<Response> {
		const { timeout = 30000, ...fetchOptions } = options;

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		try {
			const response = await fetch(url, {
				...fetchOptions,
				signal: controller.signal
			});
			return response;
		} catch (error) {
			// Convert network errors to typed errors for proper throttling
			if (error instanceof Error) {
				// AbortError from timeout
				if (error.name === 'AbortError') {
					throw new TimeoutError(this.implementation, timeout);
				}
				// Network errors (DNS, connection refused, etc.)
				if (
					error.message.includes('fetch failed') ||
					error.message.includes('ECONNREFUSED') ||
					error.message.includes('ENOTFOUND') ||
					error.message.includes('network')
				) {
					throw new ConnectionError(this.implementation, error.message);
				}
			}
			throw error;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/**
	 * Helper: Normalize language code to ISO 639-1
	 */
	protected normalizeLanguage(code: string): LanguageCode {
		return normalizeLanguageCode(code);
	}

	/**
	 * Helper: Detect subtitle format from filename/content
	 */
	protected detectFormat(filename: string): 'srt' | 'ass' | 'sub' | 'vtt' | 'ssa' | 'unknown' {
		const ext = filename.toLowerCase().split('.').pop();
		switch (ext) {
			case 'srt':
				return 'srt';
			case 'ass':
				return 'ass';
			case 'ssa':
				return 'ssa';
			case 'sub':
				return 'sub';
			case 'vtt':
				return 'vtt';
			default:
				return 'unknown';
		}
	}

	/**
	 * Helper: Check if subtitle is forced based on filename
	 */
	protected isForced(filename: string): boolean {
		const lower = filename.toLowerCase();
		return (
			lower.includes('.forced.') ||
			lower.includes('.force.') ||
			lower.includes('forced') ||
			lower.includes('.pgs.') // PGS subtitles are often forced
		);
	}

	/**
	 * Helper: Check if subtitle is for hearing impaired
	 */
	protected isHearingImpaired(filename: string): boolean {
		const lower = filename.toLowerCase();
		return (
			lower.includes('.hi.') ||
			lower.includes('.sdh.') ||
			lower.includes('.cc.') ||
			lower.includes('hearing') ||
			lower.includes('impaired')
		);
	}
}
