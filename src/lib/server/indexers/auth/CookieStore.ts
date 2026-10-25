/**
 * Cookie store for persisting indexer authentication cookies.
 *
 * Now includes:
 * - Per-cookie expiration tracking
 * - Automatic cleanup of expired cookies
 * - Expiration warning callbacks for proactive refresh
 * - Database persistence across server restarts (NEW!)
 */

import { createChildLogger } from '#lib/logging/index.js';
import { db } from '#lib/server/db/index.js';
import { indexerStatus } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import {
	decryptCredential,
	encryptCredential,
	isEncryptedCredential
} from '#lib/server/crypto/credentialsCrypto.js';

/** AAD purpose for the encrypted indexer session-cookie blob. */
const INDEXER_COOKIES_PURPOSE = 'indexer-cookies';

/** Cookies are session credentials: encrypt the whole map as one envelope. */
function encryptCookieBlob(indexerId: string, cookies: Record<string, string>): string {
	return encryptCredential(INDEXER_COOKIES_PURPOSE, indexerId, JSON.stringify(cookies));
}

function decryptCookieBlob(indexerId: string, stored: unknown): Record<string, string> | null {
	if (stored === null || stored === undefined) return null;
	if (typeof stored === 'string' && isEncryptedCredential(stored)) {
		const plaintext = decryptCredential(
			INDEXER_COOKIES_PURPOSE,
			indexerId,
			stored,
			`indexer-cookies:${indexerId}`
		);
		if (plaintext === null) return null;
		try {
			return JSON.parse(plaintext) as Record<string, string>;
		} catch {
			return null;
		}
	}
	// Plain map (pre-migration rows).
	return stored as Record<string, string>;
}

const log = createChildLogger({ module: 'CookieStore' });

/** Individual cookie with expiration */
export interface CookieEntry {
	name: string;
	value: string;
	expires?: Date;
	domain?: string;
	path?: string;
	secure?: boolean;
	httpOnly?: boolean;
}

export interface StoredCookies {
	cookies: Record<string, string>;
	/** Per-cookie expiration times */
	expirations: Record<string, Date>;
	/** Overall session expiry (fallback) */
	expiry: Date;
	/** When cookies were last updated */
	updatedAt: Date;
}

/** Callback for when cookies are about to expire */
export type ExpirationWarningCallback = (
	indexerId: string,
	expiringCookies: string[],
	timeUntilExpiryMs: number
) => void;

/**
 * In-memory cookie storage (per process)
 */
const cookieMemoryStore = new Map<string, StoredCookies>();

/** Warning threshold before expiration (5 minutes) */
const EXPIRATION_WARNING_MS = 5 * 60 * 1000;

/** Registered expiration warning callbacks */
const expirationCallbacks: ExpirationWarningCallback[] = [];

export class CookieStore {
	private checkIntervalId: ReturnType<typeof setInterval> | null = null;

	/**
	 * Start periodic expiration checking.
	 */
	startExpirationChecks(intervalMs: number = 60_000): void {
		if (this.checkIntervalId) return;

		this.checkIntervalId = setInterval(() => {
			this.checkExpirations();
		}, intervalMs);
	}

	/**
	 * Stop periodic expiration checking.
	 */
	stopExpirationChecks(): void {
		if (this.checkIntervalId) {
			clearInterval(this.checkIntervalId);
			this.checkIntervalId = null;
		}
	}

	/**
	 * Register a callback for expiration warnings.
	 */
	onExpirationWarning(callback: ExpirationWarningCallback): void {
		expirationCallbacks.push(callback);
	}

	/**
	 * Save cookies for an indexer with per-cookie expiration tracking.
	 * Persists to database for survival across server restarts.
	 */
	async save(
		indexerId: string,
		cookies: Record<string, string>,
		expiry: Date,
		perCookieExpirations?: Record<string, Date>
	): Promise<void> {
		const existing = cookieMemoryStore.get(indexerId);

		// Merge with existing cookies
		const mergedCookies = existing ? { ...existing.cookies, ...cookies } : cookies;

		const mergedExpirations = existing
			? { ...existing.expirations, ...(perCookieExpirations ?? {}) }
			: (perCookieExpirations ?? {});

		// Update in-memory cache
		cookieMemoryStore.set(indexerId, {
			cookies: mergedCookies,
			expirations: mergedExpirations,
			expiry,
			updatedAt: new Date()
		});

		// Skip DB persist for ephemeral test indexers — they have no row in `indexers`
		// so inserting into `indexerStatus` would violate the FK constraint.
		if (indexerId.startsWith('test-')) return;

		// Persist to database
		try {
			// Check if record exists
			const existingRecord = await db.query.indexerStatus.findFirst({
				where: eq(indexerStatus.indexerId, indexerId)
			});

			if (existingRecord) {
				// Update existing record. The column is JSON-mode; the envelope is
				// stored as a JSON string value (cast for the Record-typed column).
				const blob = encryptCookieBlob(indexerId, mergedCookies) as unknown as Record<
					string,
					string
				>;
				await db
					.update(indexerStatus)
					.set({
						cookies: blob,
						cookiesExpirationDate: expiry.toISOString(),
						updatedAt: new Date().toISOString()
					})
					.where(eq(indexerStatus.indexerId, indexerId));
			} else {
				// Create new record
				const blob = encryptCookieBlob(indexerId, mergedCookies) as unknown as Record<
					string,
					string
				>;
				await db.insert(indexerStatus).values({
					indexerId,
					cookies: blob,
					cookiesExpirationDate: expiry.toISOString(),
					health: 'healthy',
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString()
				});
			}

			log.debug(
				{
					indexerId,
					cookieCount: Object.keys(mergedCookies).length,
					expiry: expiry.toISOString()
				},
				'Saved cookies to database'
			);
		} catch (error) {
			log.error(
				{
					indexerId,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to persist cookies to database'
			);
			// Still keep in memory even if DB fails
		}
	}

	/**
	 * Load cookies for an indexer, filtering out expired ones.
	 * First checks in-memory cache, then falls back to database.
	 */
	async load(indexerId: string): Promise<StoredCookies | null> {
		// First check in-memory cache
		let stored = cookieMemoryStore.get(indexerId);

		// If not in memory, try to load from database
		if (!stored) {
			try {
				const record = await db.query.indexerStatus.findFirst({
					where: eq(indexerStatus.indexerId, indexerId),
					columns: {
						cookies: true,
						cookiesExpirationDate: true,
						updatedAt: true
					}
				});

				if (record?.cookies && record.cookiesExpirationDate) {
					// Parse stored cookies (envelope at rest since schema 161).
					// A failed decrypt (rotated-away key) means no usable session —
					// the indexer re-authenticates.
					const cookies = decryptCookieBlob(indexerId, record.cookies);
					if (cookies) {
						const expiry = new Date(record.cookiesExpirationDate);

						// Create stored cookies object (without per-cookie expirations - stored as overall expiry)
						stored = {
							cookies,
							expirations: {},
							expiry,
							updatedAt: record.updatedAt ? new Date(record.updatedAt) : new Date()
						};

						// Populate cache
						cookieMemoryStore.set(indexerId, stored);

						log.debug(
							{
								indexerId,
								cookieCount: Object.keys(cookies).length,
								expiry: expiry.toISOString()
							},
							'Loaded cookies from database'
						);
					}
				}
			} catch (error) {
				log.error(
					{
						indexerId,
						error: error instanceof Error ? error.message : String(error)
					},
					'Failed to load cookies from database'
				);
			}
		}

		if (!stored) {
			return null;
		}

		const now = new Date();

		// Check if overall session has expired
		if (stored.expiry < now) {
			log.debug({ indexerId }, 'Session expired, clearing cookies');
			await this.clear(indexerId);
			return null;
		}

		// Filter out individually expired cookies
		const validCookies: Record<string, string> = {};
		const validExpirations: Record<string, Date> = {};
		let expiredCount = 0;

		for (const [name, value] of Object.entries(stored.cookies)) {
			const cookieExpiry = stored.expirations[name];
			if (cookieExpiry && cookieExpiry < now) {
				expiredCount++;
				continue;
			}
			validCookies[name] = value;
			if (cookieExpiry) {
				validExpirations[name] = cookieExpiry;
			}
		}

		if (expiredCount > 0) {
			log.debug({ indexerId, expiredCount }, 'Filtered expired cookies');

			// Update stored cookies
			stored.cookies = validCookies;
			stored.expirations = validExpirations;
		}

		// Check if all cookies are gone
		if (Object.keys(validCookies).length === 0) {
			await this.clear(indexerId);
			return null;
		}

		return {
			cookies: validCookies,
			expirations: validExpirations,
			expiry: stored.expiry,
			updatedAt: stored.updatedAt
		};
	}

	/**
	 * Get time until the earliest cookie expires (ms).
	 * Returns 0 if already expired, undefined if no expiration set.
	 */
	getTimeUntilExpiry(indexerId: string): number | undefined {
		const stored = cookieMemoryStore.get(indexerId);
		if (!stored) return undefined;

		const now = Date.now();
		let earliestExpiry = stored.expiry.getTime();

		// Check per-cookie expirations
		for (const expiry of Object.values(stored.expirations)) {
			if (expiry.getTime() < earliestExpiry) {
				earliestExpiry = expiry.getTime();
			}
		}

		const timeUntil = earliestExpiry - now;
		return Math.max(0, timeUntil);
	}

	/**
	 * Check if cookies need refresh (within warning threshold).
	 */
	needsRefresh(indexerId: string): boolean {
		const timeUntil = this.getTimeUntilExpiry(indexerId);
		return timeUntil !== undefined && timeUntil < EXPIRATION_WARNING_MS;
	}

	/**
	 * Check all stored cookies for expiration warnings.
	 */
	private checkExpirations(): void {
		const now = Date.now();

		for (const [indexerId, stored] of cookieMemoryStore) {
			const expiringCookies: string[] = [];
			let earliestExpiry = stored.expiry.getTime();

			// Check each cookie
			for (const [name, expiry] of Object.entries(stored.expirations)) {
				const timeUntil = expiry.getTime() - now;
				if (timeUntil > 0 && timeUntil < EXPIRATION_WARNING_MS) {
					expiringCookies.push(name);
				}
				if (expiry.getTime() < earliestExpiry) {
					earliestExpiry = expiry.getTime();
				}
			}

			// Check session expiry
			const sessionTimeUntil = stored.expiry.getTime() - now;
			if (sessionTimeUntil > 0 && sessionTimeUntil < EXPIRATION_WARNING_MS) {
				if (!expiringCookies.includes('__session__')) {
					expiringCookies.push('__session__');
				}
			}

			if (expiringCookies.length > 0) {
				const timeUntilExpiry = earliestExpiry - now;
				for (const callback of expirationCallbacks) {
					try {
						callback(indexerId, expiringCookies, timeUntilExpiry);
					} catch (error) {
						log.error('Expiration callback error', error);
					}
				}
			}
		}
	}

	/**
	 * Clear cookies for an indexer.
	 * Clears both in-memory cache and database.
	 */
	async clear(indexerId: string): Promise<void> {
		// Clear from memory
		cookieMemoryStore.delete(indexerId);

		// Clear from database
		try {
			await db
				.update(indexerStatus)
				.set({
					cookies: null,
					cookiesExpirationDate: null,
					updatedAt: new Date().toISOString()
				})
				.where(eq(indexerStatus.indexerId, indexerId));

			log.debug({ indexerId }, 'Cleared cookies from database');
		} catch (error) {
			log.error(
				{
					indexerId,
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to clear cookies from database'
			);
		}
	}

	/**
	 * Clear all stored cookies from both memory and database.
	 */
	async clearAll(): Promise<void> {
		// Clear from memory
		cookieMemoryStore.clear();

		// Clear from database - update all records that have cookies
		try {
			await db
				.update(indexerStatus)
				.set({
					cookies: null,
					cookiesExpirationDate: null,
					updatedAt: new Date().toISOString()
				})
				.where(eq(indexerStatus.indexerId, indexerStatus.indexerId)); // Update all rows

			log.debug('Cleared all cookies from database');
		} catch (error) {
			log.error(
				{
					error: error instanceof Error ? error.message : String(error)
				},
				'Failed to clear all cookies from database'
			);
		}
	}

	/**
	 * Get all indexer IDs with stored cookies.
	 */
	getStoredIndexerIds(): string[] {
		return Array.from(cookieMemoryStore.keys());
	}

	/**
	 * Parse Set-Cookie headers into cookie entries with expiration.
	 */
	static parseSetCookieHeadersWithExpiry(headers: string[]): CookieEntry[] {
		const cookies: CookieEntry[] = [];

		for (const header of headers) {
			const parts = header.split(';').map((p) => p.trim());
			if (parts.length === 0) continue;

			// First part is name=value
			const [nameValue, ...attributes] = parts;
			const eqIndex = nameValue.indexOf('=');
			if (eqIndex <= 0) continue;

			const entry: CookieEntry = {
				name: nameValue.substring(0, eqIndex).trim(),
				value: nameValue.substring(eqIndex + 1).trim()
			};

			// Parse attributes
			for (const attr of attributes) {
				const [attrName, ...attrValueParts] = attr.split('=');
				const attrValue = attrValueParts.join('=');
				const lowerAttrName = attrName.toLowerCase().trim();

				switch (lowerAttrName) {
					case 'expires':
						entry.expires = new Date(attrValue);
						break;
					case 'max-age': {
						const seconds = parseInt(attrValue, 10);
						if (!isNaN(seconds)) {
							entry.expires = new Date(Date.now() + seconds * 1000);
						}
						break;
					}
					case 'domain':
						entry.domain = attrValue;
						break;
					case 'path':
						entry.path = attrValue;
						break;
					case 'secure':
						entry.secure = true;
						break;
					case 'httponly':
						entry.httpOnly = true;
						break;
				}
			}

			cookies.push(entry);
		}

		return cookies;
	}

	/**
	 * Parse Set-Cookie headers into a cookie object (simple, no expiry).
	 */
	static parseSetCookieHeaders(headers: string[]): Record<string, string> {
		const cookies: Record<string, string> = {};

		for (const header of headers) {
			const parts = header.split(';');
			if (parts.length > 0) {
				const [nameValue] = parts;
				const eqIndex = nameValue.indexOf('=');
				if (eqIndex > 0) {
					const name = nameValue.substring(0, eqIndex).trim();
					const value = nameValue.substring(eqIndex + 1).trim();
					cookies[name] = value;
				}
			}
		}

		return cookies;
	}

	/**
	 * Parse Cookie header string into object.
	 */
	static parseCookieHeader(header: string): Record<string, string> {
		const cookies: Record<string, string> = {};

		if (!header) return cookies;

		const pairs = header.split(';');
		for (const pair of pairs) {
			const eqIndex = pair.indexOf('=');
			if (eqIndex > 0) {
				const name = pair.substring(0, eqIndex).trim();
				const value = pair.substring(eqIndex + 1).trim();
				cookies[name] = value;
			}
		}

		return cookies;
	}

	/**
	 * Build Cookie header string from object.
	 */
	static buildCookieHeader(cookies: Record<string, string>): string {
		return Object.entries(cookies)
			.map(([name, value]) => `${name}=${value}`)
			.join('; ');
	}

	/**
	 * Merge two cookie objects (new cookies override old).
	 */
	static mergeCookies(
		existing: Record<string, string>,
		newCookies: Record<string, string>
	): Record<string, string> {
		return { ...existing, ...newCookies };
	}

	/**
	 * Convert a flat name/value cookie map into Playwright Cookie objects for a domain.
	 * Used to inject stored tracker session cookies into the Camoufox browser context.
	 */
	static toPlaywrightCookies(
		cookies: Record<string, string>,
		domain: string
	): import('playwright-core').Cookie[] {
		const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
		return Object.entries(cookies).map(([name, value]) => ({
			name,
			value,
			domain,
			path: '/',
			expires,
			httpOnly: false,
			secure: true,
			sameSite: 'Lax' as const
		}));
	}

	/**
	 * Convert Playwright Cookie objects into a flat name/value map.
	 */
	static toCookieRecord(cookies: import('playwright-core').Cookie[]): Record<string, string> {
		const result: Record<string, string> = {};
		for (const cookie of cookies) {
			if (cookie.name && cookie.value !== undefined) {
				result[cookie.name] = cookie.value;
			}
		}
		return result;
	}

	/**
	 * Extract cookies from fetch Response with expiration info.
	 */
	static extractCookiesFromResponse(response: Response): {
		cookies: Record<string, string>;
		expirations: Record<string, Date>;
	} {
		const cookies: Record<string, string> = {};
		const expirations: Record<string, Date> = {};

		// Get Set-Cookie headers (may be multiple)
		const setCookieHeader = response.headers.get('set-cookie');
		if (setCookieHeader) {
			// Note: In Node.js, multiple Set-Cookie headers are joined with ', '
			const parts = setCookieHeader.split(/,(?=\s*\w+=)/);
			const entries = this.parseSetCookieHeadersWithExpiry(parts);

			for (const entry of entries) {
				cookies[entry.name] = entry.value;
				if (entry.expires) {
					expirations[entry.name] = entry.expires;
				}
			}
		}

		return { cookies, expirations };
	}

	/**
	 * Get default expiry (30 days from now).
	 */
	static getDefaultExpiry(): Date {
		const expiry = new Date();
		expiry.setDate(expiry.getDate() + 30);
		return expiry;
	}
}

/** Singleton instance */
let cookieStoreInstance: CookieStore | null = null;

/**
 * Get the singleton CookieStore instance.
 */
export function getCookieStore(): CookieStore {
	if (!cookieStoreInstance) {
		cookieStoreInstance = new CookieStore();
	}
	return cookieStoreInstance;
}

/**
 * Create a new CookieStore instance.
 */
export function createCookieStore(): CookieStore {
	return new CookieStore();
}
