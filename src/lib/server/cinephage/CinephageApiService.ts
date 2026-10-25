import { createChildLogger } from '#lib/logging/index.js';
import type { ServiceStatus } from '#lib/server/services/background-service.js';
import type { CinephageSettingsService } from './settings/CinephageSettingsService.js';
import { getCinephageSettingsService } from './settings/CinephageSettingsService.js';
import type { CinephageCore } from './core/CinephageCore.js';
import { getCinephageCore } from './core/CinephageCore.js';
import type { CinephageModuleRegistry } from './registry/CinephageModuleRegistry.js';
import { getCinephageModuleRegistry } from './registry/CinephageModuleRegistry.js';
import type { CinephageModuleContext } from './modules/types.js';
import { registerBuiltinModules } from './modules/index.js';

/**
 * CinephageApiService — the top-level background service for the CinephageAPI
 * subsystem. Implements BackgroundService so the existing ServiceManager
 * (src/lib/server/services/) owns its lifecycle.
 *
 * Responsibilities:
 *   - Resolve subsystem config (enabled, baseUrl, overrides) from settings
 *   - Initialize the module registry (init() every registered module)
 *   - Tear down the registry on stop()
 *
 * Phase 1: ships with zero registered modules — no behavior change.
 * Modules (library-streaming, remote-streaming) land in subsequent phases
 * and register themselves via static imports at module load time.
 */
const logger = createChildLogger({ module: 'CinephageApiService', logDomain: 'system' });

export class CinephageApiService {
	readonly name = 'cinephage-api';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;

	private readonly settings: CinephageSettingsService;
	private readonly core: CinephageCore;
	private readonly registry: CinephageModuleRegistry;

	constructor(
		settings: CinephageSettingsService = getCinephageSettingsService(),
		core: CinephageCore = getCinephageCore(),
		registry: CinephageModuleRegistry = getCinephageModuleRegistry()
	) {
		this.settings = settings;
		this.core = core;
		this.registry = registry;
	}

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	/**
	 * Start the subsystem. Per the BackgroundService contract, this MUST
	 * return immediately and defer real work via setImmediate.
	 */
	start(): void {
		if (this._status === 'starting' || this._status === 'ready') {
			logger.warn({ service: this.name }, 'CinephageApiService already started, ignoring');
			return;
		}

		this._status = 'starting';
		setImmediate(() => {
			this.initialize().catch((error) => {
				this._error = error instanceof Error ? error : new Error(String(error));
				this._status = 'error';
				logger.error(
					{ err: error, service: this.name },
					'CinephageApiService initialization failed'
				);
			});
		});
	}

	private async initialize(): Promise<void> {
		const config = await this.settings.getConfig();
		logger.info(
			{ enabled: config.enabled, baseUrl: config.baseUrl },
			'CinephageAPI subsystem starting'
		);

		// Keep the gateway identity fresh: the api.cinephage.net gateway only
		// accepts the newest release pair, so sync to the latest at boot.
		// Best-effort and non-blocking — readiness does not wait on GitHub.
		if (config.enabled) {
			void this.core.refreshLatestIdentity().then(() => {
				logger.debug('Cinephage identity sync completed at boot');
			});
		}

		// Register built-in feature modules (library-streaming, future modules).
		// Idempotent — skips modules that are already registered.
		registerBuiltinModules(this.registry);

		const ctx: CinephageModuleContext = {
			getSubsystemConfig: async () => {
				const current = await this.settings.getConfig();
				return {
					enabled: current.enabled,
					baseUrl: current.baseUrl,
					versionOverride: current.versionOverride,
					commitOverride: current.commitOverride
				};
			}
		};

		// initializeAll() is best-effort — failing modules are logged but
		// don't block the rest. Subsystem reaches ready either way.
		await this.registry.initializeAll(ctx);

		this._status = 'ready';
		logger.info('CinephageAPI subsystem ready');
	}

	async stop(): Promise<void> {
		await this.registry.destroyAll();
		this._status = 'pending';
		logger.info('CinephageAPI subsystem stopped');
	}
}

// Singleton management (matches codebase convention)
let _instance: CinephageApiService | null = null;

export function getCinephageApiService(): CinephageApiService {
	if (!_instance) {
		_instance = new CinephageApiService();
	}
	return _instance;
}

export function resetCinephageApiService(): void {
	_instance = null;
}
