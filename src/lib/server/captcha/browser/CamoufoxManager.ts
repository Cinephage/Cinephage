/**
 * Camoufox Browser Manager
 *
 * Manages on-demand Camoufox browser lifecycle for challenge solving.
 * Camoufox is a Firefox-based anti-detect browser that handles fingerprinting
 * at the C++ level, making it highly effective against Cloudflare and similar protections.
 */

import { Camoufox, type NewBrowserOptions } from 'camoufox';
import type { Browser, BrowserContext, Page, Cookie } from 'playwright-core';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });
import type { ProxyConfig } from '../types';

/**
 * Camoufox's `virtual` headless mode spawns Xvfb with a 1x1 screen by default.
 * A 1x1 viewport/screen is a well-known Cloudflare bot signal: the fingerprint
 * reports a real device screen while the actual window is clamped to 1x1, so
 * client-side challenge scoring flags the browser and the challenge never
 * clears (camoufox issues #311 / #574: "works locally, stuck in challenge loop
 * in Docker"). The paired launcher reads CAMOUFOX_VIRTUAL_DISPLAY_SIZE (it
 * validates the value against 1920x1080 / 1920x1080x24), so set it once here
 * unless the operator already chose a size.
 */
if (!process.env.CAMOUFOX_VIRTUAL_DISPLAY_SIZE) {
	process.env.CAMOUFOX_VIRTUAL_DISPLAY_SIZE = '1920x1080';
}

/**
 * Resolve the filesystem path to the shadow-unlock Camoufox addon.
 *
 * The addon is not an imported module (Firefox loads it from disk), so it must
 * be found across dev (module-relative src) and prod (copied into the image).
 * Checked in priority order; result cached. Returns null if not found.
 */
let cachedAddonPath: string | null | undefined;
function resolveAddonPath(): string | null {
	if (cachedAddonPath !== undefined) return cachedAddonPath;

	const candidates: string[] = [];
	if (process.env.CAPTCHA_ADDON_PATH) candidates.push(process.env.CAPTCHA_ADDON_PATH);
	try {
		candidates.push(join(dirname(fileURLToPath(import.meta.url)), 'addon'));
	} catch {
		// import.meta.url unavailable (unexpected) — fall through to other candidates
	}
	// Bare-metal deployments run from a source checkout, where the build output
	// does not include the addon (Docker copies it to /app/camoufox-addon).
	candidates.push(join(process.cwd(), 'src/lib/server/captcha/browser/addon'));
	candidates.push('/app/camoufox-addon');
	candidates.push(join(process.cwd(), 'camoufox-addon'));

	for (const candidate of candidates) {
		try {
			if (existsSync(join(candidate, 'manifest.json'))) {
				cachedAddonPath = candidate;
				logger.debug({ addonPath: candidate }, '[CamoufoxManager] Shadow-unlock addon located');
				return candidate;
			}
		} catch {
			// ignore and try next candidate
		}
	}

	cachedAddonPath = null;
	logger.warn(
		'[CamoufoxManager] Shadow-unlock addon not found; interactive Turnstile solving degraded'
	);
	return null;
}

/**
 * Managed browser instance
 */
export interface ManagedBrowser {
	/** Internal tracking ID */
	id: string;
	browser: Browser;
	context: BrowserContext;
	page: Page;
	createdAt: Date;
	/** Whether this browser has been closed (prevents double-close) */
	isClosed: boolean;
	/** Whether the concurrency slot for this browser has been released (prevents double-release) */
	slotReleased: boolean;
}

/**
 * A queued caller waiting for a browser concurrency slot.
 */
interface SlotWaiter {
	grant: (acquired: boolean) => void;
}

/**
 * Resolve the hard cap on concurrent Camoufox browsers.
 *
 * Each Camoufox browser is a full headless Firefox (300MB-1GB+ RSS), so an
 * uncapped fan-out (many Cloudflare-protected indexers searched at once) OOM-kills
 * the container. Default is intentionally low; override with CAPTCHA_MAX_BROWSERS.
 */
function resolveMaxBrowsers(): number {
	const raw = parseInt(process.env.CAPTCHA_MAX_BROWSERS || '2', 10);
	return Number.isFinite(raw) && raw >= 1 ? raw : 2;
}

/**
 * Resolve how long a browser may live before the reaper force-closes it.
 * Safety net for browsers that wedge (crash without firing 'disconnected',
 * or upstream close() bugs). Must comfortably exceed the solve timeout.
 */
function resolveBrowserMaxAgeMs(): number {
	const raw = parseInt(process.env.CAPTCHA_BROWSER_MAX_AGE_MS || '120000', 10);
	return Number.isFinite(raw) && raw >= 10000 ? raw : 120000;
}

/**
 * Resolve the max time to wait for a browser to launch before giving up.
 * `geoip: true` performs a live IP-geolocation lookup that can hang if the
 * lookup service is unreachable/rate-limited; without a bound, a hung launch
 * would hold a semaphore slot forever and eventually deadlock all solving.
 */
function resolveLaunchTimeoutMs(): number {
	const raw = parseInt(process.env.CAPTCHA_LAUNCH_TIMEOUT_MS || '45000', 10);
	return Number.isFinite(raw) && raw >= 5000 ? raw : 45000;
}

/**
 * Camoufox Browser Manager for anti-detect browsing
 */
export class CamoufoxManager {
	private activeBrowsers: Map<string, ManagedBrowser> = new Map();
	private isAvailable = false;
	private availabilityError: string | undefined;
	private availabilityChecked = false;
	private availabilityPromise: Promise<void> | null = null;

	// Global concurrency semaphore. `acquiredSlots` is the number of slots
	// currently held (including in-flight launches); waiters queue FIFO.
	private readonly maxBrowsers: number;
	private readonly maxBrowserAgeMs: number;
	private readonly launchTimeoutMs: number;
	private acquiredSlots = 0;
	private waiters: SlotWaiter[] = [];
	private reaperInterval: ReturnType<typeof setInterval> | null = null;

	constructor(options?: {
		maxBrowsers?: number;
		maxBrowserAgeMs?: number;
		launchTimeoutMs?: number;
	}) {
		this.maxBrowsers = options?.maxBrowsers ?? resolveMaxBrowsers();
		this.maxBrowserAgeMs = options?.maxBrowserAgeMs ?? resolveBrowserMaxAgeMs();
		this.launchTimeoutMs = options?.launchTimeoutMs ?? resolveLaunchTimeoutMs();
		// Start async availability check
		this.availabilityPromise = this.checkAvailability();
	}

	/**
	 * Check if Camoufox is available
	 */
	private async checkAvailability(): Promise<void> {
		try {
			// Try to launch a quick browser to verify availability
			// Use "virtual" headless mode which spawns an internal Xvfb display
			const browser = await Camoufox({
				headless: 'virtual',
				geoip: false
			});
			await browser.close();
			this.isAvailable = true;
			this.availabilityError = undefined;
			logger.info('[CamoufoxManager] Camoufox is available');
		} catch (error) {
			this.isAvailable = false;
			this.availabilityError = error instanceof Error ? error.message : String(error);
			logger.warn(
				{
					error: this.availabilityError
				},
				'[CamoufoxManager] Camoufox is not available'
			);
		} finally {
			this.availabilityChecked = true;
		}
	}

	/**
	 * Wait for availability check to complete
	 */
	async waitForAvailabilityCheck(): Promise<void> {
		if (this.availabilityPromise) {
			await this.availabilityPromise;
		}
	}

	/**
	 * Check if browser is available for use
	 */
	browserAvailable(): boolean {
		return this.isAvailable;
	}

	/**
	 * Check if availability has been determined yet
	 */
	availabilityDetermined(): boolean {
		return this.availabilityChecked;
	}

	/**
	 * Get availability error message
	 */
	getAvailabilityError(): string | undefined {
		return this.availabilityError;
	}

	/**
	 * Create a new Camoufox browser for solving.
	 *
	 * Blocks until a concurrency slot is available (bounded by acquireTimeoutMs).
	 * Throws if no slot becomes available in time, so callers degrade gracefully
	 * instead of piling up browsers.
	 */
	async createBrowser(options: {
		headless: boolean;
		proxy?: ProxyConfig;
		acquireTimeoutMs?: number;
		/** Aborting while queued gives up the slot wait instead of launching. */
		signal?: AbortSignal;
		/**
		 * Load the shadow-unlock addon (default true).
		 *
		 * The addon patches Element.prototype.attachShadow in the page MAIN world,
		 * which Cloudflare's Turnstile can detect as DOM tampering and respond to
		 * with an unwinnable managed-challenge loop. Callers should solve passively
		 * without it first and only opt in for genuinely interactive challenges.
		 */
		shadowUnlockAddon?: boolean;
	}): Promise<ManagedBrowser> {
		// Wait for availability check to complete before checking isAvailable
		await this.waitForAvailabilityCheck();

		if (!this.isAvailable) {
			throw new Error(`Camoufox not available: ${this.availabilityError || 'unknown error'}`);
		}

		// Gate on the global semaphore before launching anything.
		const acquired = await this.acquireSlot(options.acquireTimeoutMs, options.signal);
		if (!acquired) {
			if (options.signal?.aborted) {
				throw new Error('Aborted');
			}
			throw new Error(
				`Timed out waiting for a browser slot (max ${this.maxBrowsers} concurrent browsers)`
			);
		}

		const id = crypto.randomUUID();
		const startTime = Date.now();
		let launchedBrowser: Browser | null = null;

		try {
			// Build Camoufox options.
			// Use "virtual" headless mode which spawns an internal Xvfb display,
			// satisfying Firefox's display requirements in Docker.
			//
			// The extra flags mirror Byparr's proven Cloudflare-solving config:
			//  - disable_coop: lets us click checkboxes inside cross-origin Turnstile iframes
			//  - main_world_eval + config.forceScopeAccess: needed by the solving helpers
			//  - locale en-US: avoids fingerprint/locale inconsistency (seen as localized
			//    "Un momento…" challenge loops when geoip picks a mismatched locale)
			const camoufoxOptions: NewBrowserOptions = {
				headless: options.headless ? 'virtual' : false,
				geoip: true, // Auto-detect IP and set matching timezone
				humanize: true, // Human-like mouse movements
				locale: 'en-US',
				disable_coop: true,
				main_world_eval: true,
				i_know_what_im_doing: true,
				config: { forceScopeAccess: true }
			};

			// Load the shadow-unlock addon so interactive Turnstile checkboxes
			// (in closed shadow DOM) are reachable and clickable. Opt-out when the
			// caller is making a clean passive attempt (see option docs).
			if (options.shadowUnlockAddon !== false) {
				const addonPath = resolveAddonPath();
				if (addonPath) {
					camoufoxOptions.addons = [addonPath];
				}
			}

			// Add proxy if provided
			if (options.proxy) {
				camoufoxOptions.proxy = {
					server: options.proxy.url,
					username: options.proxy.username,
					password: options.proxy.password
				};
			}

			// Launch Camoufox with a hard timeout. If the geoip lookup hangs
			// (or the launch otherwise stalls), fall back once to a launch without
			// geoip so solving degrades gracefully instead of deadlocking.
			let browser: Browser;
			try {
				browser = await this.launchWithTimeout(camoufoxOptions);
			} catch (launchError) {
				if (camoufoxOptions.geoip) {
					logger.warn(
						{ error: launchError instanceof Error ? launchError.message : String(launchError) },
						'[CamoufoxManager] Launch failed/timed out; retrying without geoip'
					);
					browser = await this.launchWithTimeout({ ...camoufoxOptions, geoip: false });
				} else {
					throw launchError;
				}
			}
			launchedBrowser = browser;

			// Get the default context (Camoufox creates one)
			const contexts = browser.contexts();
			const context = contexts[0] || (await browser.newContext());

			// Create page
			const page = await context.newPage();

			// Pin a realistic viewport. Camoufox defaults to `viewport: null`
			// (window-measured), which was clamped to the old 1x1 Xvfb surface;
			// with the patched real-resolution display this guarantees the window
			// is a normal size consistent with the spoofed screen fingerprint.
			if (typeof page.setViewportSize === 'function') {
				await page.setViewportSize({ width: 1366, height: 768 }).catch(() => {});
			}

			const managed: ManagedBrowser = {
				id,
				browser,
				context,
				page,
				createdAt: new Date(),
				isClosed: false,
				slotReleased: false
			};

			this.activeBrowsers.set(id, managed);
			this.startReaper();

			// Handle browser disconnect (crash, external kill, etc.)
			// This prevents stale entries in activeBrowsers map and frees the slot.
			browser.on('disconnected', () => {
				if (!managed.isClosed) {
					managed.isClosed = true;
					this.activeBrowsers.delete(id);
					this.releaseSlotFor(managed);
					this.stopReaperIfIdle();
					logger.debug({ id }, '[CamoufoxManager] Browser disconnected externally');
				}
			});

			logger.debug(
				{
					id,
					headless: options.headless,
					activeBrowsers: this.activeBrowsers.size,
					timeMs: Date.now() - startTime
				},
				'[CamoufoxManager] Created browser'
			);

			return managed;
		} catch (error) {
			// Launch failed after acquiring a slot: release it and best-effort close
			// any partially-created browser so we never leak a Firefox.
			this.releaseSlot();
			if (launchedBrowser) {
				try {
					await launchedBrowser.close().catch(() => {});
				} catch {
					// ignore
				}
			}
			logger.error(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				'[CamoufoxManager] Failed to create browser'
			);
			throw error;
		}
	}

	/**
	 * Create a browser for a specific domain
	 */
	async createBrowserForDomain(
		_domain: string,
		options: {
			headless: boolean;
			proxy?: ProxyConfig;
			acquireTimeoutMs?: number;
			signal?: AbortSignal;
			shadowUnlockAddon?: boolean;
		}
	): Promise<ManagedBrowser> {
		return this.createBrowser(options);
	}

	/**
	 * Close a managed browser
	 */
	async closeBrowser(managed: ManagedBrowser): Promise<void> {
		// Prevent double-close
		if (managed.isClosed) {
			return;
		}
		managed.isClosed = true;

		try {
			// Remove from active list using the stored ID (O(1) instead of O(n))
			this.activeBrowsers.delete(managed.id);

			// Close browser (this closes all contexts and pages). The launcher
			// wraps close() so the virtual display is torn down with it.
			await managed.browser.close().catch(() => {});

			logger.debug({ id: managed.id }, '[CamoufoxManager] Closed browser');
		} catch (error) {
			logger.warn(
				{
					id: managed.id,
					error: error instanceof Error ? error.message : String(error)
				},
				'[CamoufoxManager] Error closing browser'
			);
		} finally {
			// Always free the concurrency slot, even if close() threw.
			this.releaseSlotFor(managed);
			this.stopReaperIfIdle();
		}
	}

	/**
	 * Close all active browsers
	 */
	async closeAll(): Promise<void> {
		const browsers = Array.from(this.activeBrowsers.values());
		this.activeBrowsers.clear();
		this.stopReaper();

		await Promise.all(
			browsers.map(async (managed) => {
				// Skip already-closed browsers
				if (managed.isClosed) {
					return;
				}
				managed.isClosed = true;

				try {
					await managed.browser.close().catch(() => {});
				} catch {
					// Ignore errors during cleanup
				} finally {
					this.releaseSlotFor(managed);
				}
			})
		);

		logger.info({ count: browsers.length }, '[CamoufoxManager] Closed all browsers');
	}

	/**
	 * Get count of active browsers
	 */
	getActiveBrowserCount(): number {
		return this.activeBrowsers.size;
	}

	/**
	 * Get count of currently-held concurrency slots (in-flight launches + open browsers).
	 * Exposed primarily for tests and diagnostics.
	 */
	getAcquiredSlotCount(): number {
		return this.acquiredSlots;
	}

	/**
	 * Get the configured maximum number of concurrent browsers.
	 */
	getMaxBrowsers(): number {
		return this.maxBrowsers;
	}

	/**
	 * Launch Camoufox, rejecting if it does not resolve within launchTimeoutMs.
	 *
	 * A timed-out launch promise is abandoned; in practice the stall is in the
	 * pre-launch geoip IP lookup (no browser process spawned yet), so nothing leaks.
	 */
	private async launchWithTimeout(options: NewBrowserOptions): Promise<Browser> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`Camoufox launch timed out after ${this.launchTimeoutMs}ms`)),
				this.launchTimeoutMs
			);
		});
		try {
			return (await Promise.race([Camoufox(options), timeoutPromise])) as Browser;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	// ---------------------------------------------------------------------------
	// Concurrency semaphore
	// ---------------------------------------------------------------------------

	/**
	 * Acquire a browser slot. Resolves true once a slot is held, or false if
	 * timeoutMs elapses first or the signal aborts while queued. Without a
	 * timeout, waits indefinitely.
	 */
	private async acquireSlot(timeoutMs?: number, signal?: AbortSignal): Promise<boolean> {
		if (this.acquiredSlots < this.maxBrowsers) {
			this.acquiredSlots++;
			return true;
		}

		if (signal?.aborted) {
			return false;
		}

		return new Promise<boolean>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			const grant = (acquired: boolean) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				if (signal) signal.removeEventListener('abort', onAbort);
				resolve(acquired);
			};

			const waiter: SlotWaiter = { grant };

			const onAbort = () => {
				const idx = this.waiters.indexOf(waiter);
				if (idx > -1) this.waiters.splice(idx, 1);
				grant(false);
			};
			if (signal) {
				signal.addEventListener('abort', onAbort, { once: true });
			}

			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					const idx = this.waiters.indexOf(waiter);
					if (idx > -1) this.waiters.splice(idx, 1);
					grant(false);
				}, timeoutMs);
			}

			this.waiters.push(waiter);
		});
	}

	/**
	 * Release a slot back to the pool. Hands it directly to the next waiter if
	 * one is queued (keeping the held-slot count constant on transfer).
	 */
	private releaseSlot(): void {
		const next = this.waiters.shift();
		if (next) {
			next.grant(true);
		} else {
			this.acquiredSlots = Math.max(0, this.acquiredSlots - 1);
		}
	}

	/**
	 * Release the slot associated with a managed browser exactly once.
	 */
	private releaseSlotFor(managed: ManagedBrowser): void {
		if (managed.slotReleased) return;
		managed.slotReleased = true;
		this.releaseSlot();
	}

	// ---------------------------------------------------------------------------
	// Stale-browser reaper
	// ---------------------------------------------------------------------------

	private startReaper(): void {
		if (this.reaperInterval) return;
		// Check often enough to bound orphan lifetime, but never faster than 5s.
		const period = Math.max(5000, Math.min(this.maxBrowserAgeMs, 30000));
		this.reaperInterval = setInterval(() => this.reapStaleBrowsers(), period);
		// Never keep the process alive just for the reaper.
		if (typeof this.reaperInterval.unref === 'function') {
			this.reaperInterval.unref();
		}
	}

	private stopReaper(): void {
		if (this.reaperInterval) {
			clearInterval(this.reaperInterval);
			this.reaperInterval = null;
		}
	}

	private stopReaperIfIdle(): void {
		if (this.activeBrowsers.size === 0) {
			this.stopReaper();
		}
	}

	private reapStaleBrowsers(): void {
		const now = Date.now();
		const stale: ManagedBrowser[] = [];
		for (const managed of this.activeBrowsers.values()) {
			if (!managed.isClosed && now - managed.createdAt.getTime() > this.maxBrowserAgeMs) {
				stale.push(managed);
			}
		}
		for (const managed of stale) {
			logger.warn(
				{ id: managed.id, ageMs: now - managed.createdAt.getTime() },
				'[CamoufoxManager] Reaping stale browser past max age'
			);
			void this.closeBrowser(managed);
		}
	}

	/**
	 * Extract cookies from context
	 */
	async extractCookies(context: BrowserContext, urls?: string[]): Promise<Cookie[]> {
		return context.cookies(urls);
	}

	/**
	 * Add cookies to context
	 */
	async addCookies(context: BrowserContext, cookies: Cookie[]): Promise<void> {
		await context.addCookies(cookies);
	}
}

// Singleton instance
let camoufoxManagerInstance: CamoufoxManager | null = null;

/**
 * Get the Camoufox manager instance
 */
export function getCamoufoxManager(): CamoufoxManager {
	if (!camoufoxManagerInstance) {
		camoufoxManagerInstance = new CamoufoxManager();
	}
	return camoufoxManagerInstance;
}

/**
 * Shutdown the Camoufox manager
 */
export async function shutdownCamoufoxManager(): Promise<void> {
	if (camoufoxManagerInstance) {
		await camoufoxManagerInstance.closeAll();
		camoufoxManagerInstance = null;
	}
}
