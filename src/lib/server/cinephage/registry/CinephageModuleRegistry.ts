import { createChildLogger } from '#lib/logging/index.js';
import type {
	CinephageModule,
	CinephageModuleCapabilities,
	CinephageModuleContext
} from '../modules/types.js';

const logger = createChildLogger({ module: 'CinephageModuleRegistry', logDomain: 'system' });

type CapabilityKey = keyof CinephageModuleCapabilities;

/**
 * CinephageModuleRegistry — holds registered feature modules, indexed by id.
 *
 * Mechanics mirror the subtitles ProviderRegistry pattern in this codebase:
 * in-memory Map keyed by module id, multi-index bookkeeping optional, single
 * instance per process via getCinephageModuleRegistry(). Modules register
 * themselves statically (no auto-discovery — we control all modules).
 *
 * Unlike the subtitle registry (which holds interchangeable backends of the
 * same function), this registry holds distinct features that share the
 * CinephageAPI subsystem's HTTP client and identity headers.
 */
export class CinephageModuleRegistry {
	private readonly modules = new Map<string, CinephageModule>();

	/** Register a module. Replaces any existing module with the same id. */
	register(module: CinephageModule): void {
		if (this.modules.has(module.id)) {
			logger.warn({ moduleId: module.id }, 'Cinephage module already registered, replacing');
		}
		this.modules.set(module.id, module);
	}

	/** Remove a module by id. No-op if not registered. */
	unregister(id: string): void {
		this.modules.delete(id);
	}

	/** Get a module by id, or undefined. */
	getById(id: string): CinephageModule | undefined {
		return this.modules.get(id);
	}

	/** All registered modules. Order is insertion order, not sorted. */
	getAll(): CinephageModule[] {
		return Array.from(this.modules.values());
	}

	/**
	 * Modules advertising a given capability. Used by callers that need to
	 * route operations (e.g. IndexerManager queries providesIndexer to find
	 * modules that seed virtual indexer rows).
	 */
	getByCapability<K extends CapabilityKey>(capability: K): CinephageModule[] {
		return this.getAll().filter((m) => m.capabilities[capability] !== undefined);
	}

	/** Modules whose isEnabled() returns true. */
	getEnabledModules(): CinephageModule[] {
		return this.getAll().filter((m) => m.isEnabled());
	}

	/**
	 * Initialize every registered module in insertion order. A throwing
	 * module is logged but does not block other modules from initializing.
	 */
	async initializeAll(ctx: CinephageModuleContext): Promise<void> {
		for (const module of this.modules.values()) {
			try {
				await module.init(ctx);
			} catch (error) {
				logger.error(
					{ err: error, moduleId: module.id },
					`Cinephage module ${module.id} failed to initialize`
				);
			}
		}
	}

	/**
	 * Destroy every registered module. Best-effort: errors are logged but
	 * do not prevent other modules from being destroyed.
	 */
	async destroyAll(): Promise<void> {
		for (const module of this.modules.values()) {
			try {
				await module.destroy?.();
			} catch (error) {
				logger.error(
					{ err: error, moduleId: module.id },
					`Cinephage module ${module.id} failed to destroy`
				);
			}
		}
	}
}

// Singleton management (matches codebase convention)
let _instance: CinephageModuleRegistry | null = null;

export function getCinephageModuleRegistry(): CinephageModuleRegistry {
	if (!_instance) {
		_instance = new CinephageModuleRegistry();
	}
	return _instance;
}

export function resetCinephageModuleRegistry(): void {
	_instance = null;
}
