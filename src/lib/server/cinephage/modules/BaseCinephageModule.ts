import type { CinephageModule, ConnectionTestResult, CinephageModuleContext } from './types.js';

/**
 * BaseCinephageModule - shared defaults for Cinephage feature modules.
 *
 * Subclasses set the readonly identity fields (id, name, etc.) in their
 * constructor and override methods as needed. Mirrors the BaseAuthProvider /
 * BaseProvider pattern in this codebase.
 *
 * The `_enabled` flag is an in-memory default; production modules typically
 * override isEnabled() to consult CinephageSettingsService instead.
 */
export abstract class BaseCinephageModule implements CinephageModule {
	abstract readonly id: string;
	abstract readonly name: string;
	abstract readonly description: string;
	abstract readonly maturity: 'stable' | 'beta';
	abstract readonly capabilities: CinephageModule['capabilities'];

	/** In-memory enable flag, used by the default isEnabled(). */
	protected _enabled = true;

	/** Test-only helper to flip the in-memory flag. Production code should override isEnabled(). */
	setEnabled(value: boolean): void {
		this._enabled = value;
	}

	/**
	 * Default: returns the in-memory flag. Override to consult settings.
	 * Subsystem-disabled state is enforced by CinephageApiService, not here.
	 */
	isEnabled(): boolean {
		return this._enabled;
	}

	/** Default no-op. Override to seed rows, register routes, etc. */
	async init(_ctx: CinephageModuleContext): Promise<void> {
		// no-op by default
	}

	/** Default no-op. Override for cleanup. */
	async destroy(): Promise<void> {
		// no-op by default
	}

	/** Default: reports success without making any network call. */
	async test(): Promise<ConnectionTestResult> {
		return { success: true };
	}
}
