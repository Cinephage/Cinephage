/**
 * Stalker Portal Manager
 *
 * Manages Stalker Portal URLs for scanning and account discovery.
 * Handles CRUD operations, portal type detection, and connection testing.
 */

import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { stalkerPortals, type StalkerPortalRecord } from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { BackgroundService, ServiceStatus } from '#lib/server/services/background-service.js';
import { ValidationError, NotFoundError } from '#lib/errors/index.js';
import { STB_USER_AGENT_PROBE } from './StalkerPortalClient.js';

const logger = createChildLogger({ module: 'StalkerPortalManager' });

export interface StalkerPortal {
	id: string;
	name: string;
	url: string;
	endpoint: string | null;
	serverTimezone: string | null;
	lastScannedAt: string | null;
	lastScanResults: PortalScanSummary | null;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface PortalScanSummary {
	totalTested: number;
	totalFound: number;
	lastScanType: 'random' | 'sequential' | 'import';
	lastScanDate: string;
}

export interface CreatePortalInput {
	name: string;
	url: string;
	enabled?: boolean;
}

export interface UpdatePortalInput {
	name?: string;
	url?: string;
	enabled?: boolean;
}

export interface PortalDetectionResult {
	success: boolean;
	endpoint?: string;
	serverTimezone?: string;
	error?: string;
}

export interface PortalTestResult {
	success: boolean;
	endpoint?: string;
	serverTimezone?: string;
	error?: string;
}

/**
 * Convert database record to API response type
 */
function recordToPortal(record: StalkerPortalRecord): StalkerPortal {
	let scanResults: PortalScanSummary | null = null;
	if (record.lastScanResults) {
		try {
			scanResults = JSON.parse(record.lastScanResults);
		} catch {
			// Invalid JSON, ignore
		}
	}

	return {
		id: record.id,
		name: record.name,
		url: record.url,
		endpoint: record.endpoint,
		serverTimezone: record.serverTimezone,
		lastScannedAt: record.lastScannedAt,
		lastScanResults: scanResults,
		enabled: record.enabled ?? true,
		createdAt: record.createdAt ?? new Date().toISOString(),
		updatedAt: record.updatedAt ?? new Date().toISOString()
	};
}

/**
 * Normalize a portal URL to a consistent format
 */
function normalizePortalUrl(url: string): string {
	// Remove trailing slashes
	let normalized = url.trim().replace(/\/+$/, '');

	// Remove common path suffixes that users might include
	normalized = normalized
		.replace(/\/portal\.php.*$/i, '')
		.replace(/\/stalker_portal\/server\/load\.php.*$/i, '')
		.replace(/\/server.*$/i, '');

	// Only strip /c when it is at the root path level (e.g. http://host/c).
	// Preserve /c when preceded by /stalker_portal/ (e.g. http://host/stalker_portal/c)
	// because those portals use /stal ker_portal/c/portal.php as their API endpoint.
	normalized = normalized.replace(/^(https?:\/\/[^/]+)\/c\/?$/, '$1');

	// Ensure http:// or https://
	if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
		normalized = `http://${normalized}`;
	}

	return normalized;
}

export class StalkerPortalManager implements BackgroundService {
	readonly name = 'StalkerPortalManager';
	private _status: ServiceStatus = 'pending';
	private _error?: Error;

	get status(): ServiceStatus {
		return this._status;
	}

	get error(): Error | undefined {
		return this._error;
	}

	/**
	 * Start the service (non-blocking)
	 * Implements BackgroundService.start()
	 */
	start(): void {
		if (this._status === 'ready' || this._status === 'starting') {
			logger.debug('StalkerPortalManager already running');
			return;
		}

		this._status = 'starting';
		logger.info('Starting StalkerPortalManager');

		// Service initialization is synchronous for this manager
		setImmediate(() => {
			this._status = 'ready';
			logger.info('StalkerPortalManager ready');
		});
	}

	/**
	 * Stop the service gracefully
	 * Implements BackgroundService.stop()
	 */
	async stop(): Promise<void> {
		if (this._status === 'pending') {
			return;
		}

		logger.info('Stopping StalkerPortalManager');
		this._status = 'pending';
		logger.info('StalkerPortalManager stopped');
	}

	/**
	 * Get all portals
	 */
	async getPortals(): Promise<StalkerPortal[]> {
		const records = db.select().from(stalkerPortals).all();
		return records.map(recordToPortal);
	}

	/**
	 * Get enabled portals only
	 */
	async getEnabledPortals(): Promise<StalkerPortal[]> {
		const records = db.select().from(stalkerPortals).where(eq(stalkerPortals.enabled, true)).all();
		return records.map(recordToPortal);
	}

	/**
	 * Get a portal by ID
	 */
	async getPortal(id: string): Promise<StalkerPortal | null> {
		const record = db.select().from(stalkerPortals).where(eq(stalkerPortals.id, id)).get();

		if (!record) {
			return null;
		}

		return recordToPortal(record);
	}

	/**
	 * Get a portal by URL
	 */
	async getPortalByUrl(url: string): Promise<StalkerPortal | null> {
		const normalized = normalizePortalUrl(url);
		const record = db.select().from(stalkerPortals).where(eq(stalkerPortals.url, normalized)).get();

		if (!record) {
			return null;
		}

		return recordToPortal(record);
	}

	/**
	 * Create a new portal
	 * Optionally detects the portal type before saving
	 */
	async createPortal(input: CreatePortalInput, detectType: boolean = true): Promise<StalkerPortal> {
		const now = new Date().toISOString();
		const normalizedUrl = normalizePortalUrl(input.url);

		// Check for duplicates
		const existing = await this.getPortalByUrl(normalizedUrl);
		if (existing) {
			throw new ValidationError(`Portal already exists: ${existing.name}`);
		}

		// Detect portal type if requested
		let endpoint: string | undefined;
		let serverTimezone: string | undefined;

		if (detectType) {
			const detection = await this.detectPortalType(normalizedUrl);
			if (detection.success) {
				endpoint = detection.endpoint;
				serverTimezone = detection.serverTimezone;
			}
			// Don't fail on detection failure - we can still save the portal
		}

		const insertData: typeof stalkerPortals.$inferInsert = {
			name: input.name,
			url: normalizedUrl,
			endpoint: endpoint ?? null,
			serverTimezone: serverTimezone ?? null,
			enabled: input.enabled ?? true,
			createdAt: now,
			updatedAt: now
		};

		const record = db.insert(stalkerPortals).values(insertData).returning().get();

		logger.info(
			{
				id: record.id,
				name: record.name,
				url: record.url,
				endpoint: record.endpoint
			},
			'Created portal'
		);

		return recordToPortal(record);
	}

	/**
	 * Update a portal
	 */
	async updatePortal(id: string, updates: UpdatePortalInput): Promise<StalkerPortal> {
		const existing = await this.getPortal(id);
		if (!existing) {
			throw new NotFoundError('Portal', id);
		}

		const now = new Date().toISOString();
		const updateData: Partial<typeof stalkerPortals.$inferInsert> = {
			updatedAt: now
		};

		if (updates.name !== undefined) {
			updateData.name = updates.name;
		}

		if (updates.url !== undefined) {
			const normalizedUrl = normalizePortalUrl(updates.url);

			// Check for duplicates (excluding self)
			const duplicate = await this.getPortalByUrl(normalizedUrl);
			if (duplicate && duplicate.id !== id) {
				throw new ValidationError(`Portal URL already exists: ${duplicate.name}`);
			}

			updateData.url = normalizedUrl;

			// Re-detect portal type when URL changes
			const detection = await this.detectPortalType(normalizedUrl);
			if (detection.success) {
				updateData.endpoint = detection.endpoint;
				updateData.serverTimezone = detection.serverTimezone;
			}
		}

		if (updates.enabled !== undefined) {
			updateData.enabled = updates.enabled;
		}

		const record = db
			.update(stalkerPortals)
			.set(updateData)
			.where(eq(stalkerPortals.id, id))
			.returning()
			.get();

		logger.info(
			{
				id: record.id,
				name: record.name
			},
			'Updated portal'
		);

		return recordToPortal(record);
	}

	/**
	 * Delete a portal
	 * Also deletes associated scan results and history (via CASCADE)
	 */
	async deletePortal(id: string): Promise<void> {
		const existing = await this.getPortal(id);
		if (!existing) {
			throw new NotFoundError('Portal', id);
		}

		db.delete(stalkerPortals).where(eq(stalkerPortals.id, id)).run();

		logger.info(
			{
				id,
				name: existing.name
			},
			'Deleted portal'
		);
	}

	/**
	 * Detect the portal type by checking known endpoints.
	 * Stalker portals can use different API endpoints.
	 */
	async detectPortalType(url: string): Promise<PortalDetectionResult> {
		const normalizedUrl = normalizePortalUrl(url);

		// Determine if the URL already has a subpath (e.g. /stalker_portal/c)
		// to avoid constructing doubled paths like /stalker_portal/c/stalker_portal/c/version.js
		const hasSubpath = normalizedUrl.includes('/stalker_portal/c');

		// Try different portal endpoints, ordered by likelihood
		const probes: Array<{ path: string; endpoint: string }> = hasSubpath
			? [
					// For subpath portals (e.g. /stalker_portal/c), probe version.js at the subpath
					{ path: '/version.js', endpoint: 'portal.php' },
					// Also try the handshake probe directly
					{ path: '/portal.php?type=stb&action=handshake&token=', endpoint: 'portal.php' }
				]
			: [
					{ path: '/c/version.js', endpoint: 'portal.php' },
					{ path: '/stalker_portal/c/version.js', endpoint: 'stalker_portal/server/load.php' }
				];

		for (const { path, endpoint } of probes) {
			try {
				const testUrl = `${normalizedUrl}${path}`;
				const response = await fetch(testUrl, {
					method: 'GET',
					signal: AbortSignal.timeout(10000),
					headers: {
						'User-Agent': STB_USER_AGENT_PROBE
					}
				});

				if (response.ok || (endpoint === 'portal.php' && response.status === 403)) {
					const text = await response.text();
					// Check for version string pattern (skip for handshake endpoint)
					if (path.includes('portal.php') || text.includes('var ver') || text.includes('version')) {
						logger.debug(
							{
								url: normalizedUrl,
								endpoint
							},
							'Detected portal type'
						);

						return {
							success: true,
							endpoint
						};
					}
				}
			} catch {
				// Try next endpoint
				continue;
			}
		}

		// Try direct portal.php access as fallback
		try {
			const testUrl = `${normalizedUrl}/portal.php?action=handshake&type=stb&token=`;
			const response = await fetch(testUrl, {
				method: 'GET',
				signal: AbortSignal.timeout(10000),
				headers: {
					'User-Agent': STB_USER_AGENT_PROBE
				}
			});

			if (response.ok || response.status === 403) {
				// 403 often means the portal exists but needs proper auth
				return {
					success: true,
					endpoint: 'portal.php'
				};
			}
		} catch {
			// Fallback failed
		}

		// Try stalker_portal path as final fallback
		try {
			const testUrl = `${normalizedUrl}/stalker_portal/server/load.php?action=handshake&type=stb&token=`;
			const response = await fetch(testUrl, {
				method: 'GET',
				signal: AbortSignal.timeout(10000),
				headers: {
					'User-Agent': STB_USER_AGENT_PROBE
				}
			});

			if (response.ok || response.status === 403) {
				return {
					success: true,
					endpoint: 'stalker_portal/server/load.php'
				};
			}
		} catch {
			// Final fallback failed
		}

		return {
			success: false,
			error: 'Could not detect portal type. The URL may be incorrect or the portal is offline.'
		};
	}

	/**
	 * Test portal connection
	 */
	async testPortalConnection(url: string): Promise<PortalTestResult> {
		const detection = await this.detectPortalType(url);

		if (!detection.success) {
			return {
				success: false,
				error: detection.error || 'Failed to detect portal type'
			};
		}

		return {
			success: true,
			endpoint: detection.endpoint,
			serverTimezone: detection.serverTimezone
		};
	}

	/**
	 * Update the last scan results for a portal
	 */
	async updateScanResults(id: string, results: PortalScanSummary): Promise<void> {
		const now = new Date().toISOString();

		db.update(stalkerPortals)
			.set({
				lastScannedAt: now,
				lastScanResults: JSON.stringify(results),
				updatedAt: now
			})
			.where(eq(stalkerPortals.id, id))
			.run();
	}

	/**
	 * Re-detect portal type and update
	 */
	async refreshPortalDetection(id: string): Promise<StalkerPortal> {
		const existing = await this.getPortal(id);
		if (!existing) {
			throw new NotFoundError('Portal', id);
		}

		const detection = await this.detectPortalType(existing.url);
		const now = new Date().toISOString();

		const updateData: Partial<typeof stalkerPortals.$inferInsert> = {
			updatedAt: now
		};

		if (detection.success) {
			updateData.endpoint = detection.endpoint;
			updateData.serverTimezone = detection.serverTimezone;
		}

		const record = db
			.update(stalkerPortals)
			.set(updateData)
			.where(eq(stalkerPortals.id, id))
			.returning()
			.get();

		return recordToPortal(record);
	}
}

// Singleton instance
let portalManager: StalkerPortalManager | null = null;

export function getStalkerPortalManager(): StalkerPortalManager {
	if (!portalManager) {
		portalManager = new StalkerPortalManager();
	}
	return portalManager;
}
