/**
 * Portal Scan Worker
 *
 * Background worker that scans Stalker portals for valid MAC addresses.
 * Supports random, sequential, and imported MAC scanning.
 */

import { TaskWorker } from './TaskWorker';
import type { WorkerType, PortalScanWorkerMetadata } from './types';
import { db } from '#lib/server/db/index.js';
import { portalScanResults, portalScanHistory } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { MacGenerator } from '#lib/server/livetv/stalker/MacGenerator.js';
import { StalkerPortalClient } from '#lib/server/livetv/stalker/StalkerPortalClient.js';
import { randomUUID } from 'node:crypto';

export interface PortalScanOptions {
	portalId: string;
	portalName: string;
	portalUrl: string;
	portalEndpoint?: string;
	scanType: 'random' | 'sequential' | 'import';
	macPrefix?: string;
	macRangeStart?: string;
	macRangeEnd?: string;
	importedMacs?: string[];
	macCount?: number;
	rateLimit?: number;
}

/**
 * Generate device IDs from a MAC address (mimics MAG box behavior)
 */
function generateDeviceIds(mac: string): {
	serialNumber: string;
	deviceId: string;
	deviceId2: string;
} {
	// Simple hash-based generation (similar to MacAttack)
	const chars = 'ABCDEF0123456789';
	const seed = mac.replace(/:/g, '');

	let serialNumber = '';
	let deviceId = '';
	let deviceId2 = '';

	// Serial number: 12 chars
	for (let i = 0; i < 12; i++) {
		const idx = parseInt(seed.charAt(i % seed.length), 16) ^ (i * 7);
		serialNumber += chars[idx % chars.length];
	}

	// Device ID: 32 hex chars
	for (let i = 0; i < 32; i++) {
		const idx = parseInt(seed.charAt(i % seed.length), 16) ^ (i * 11);
		deviceId += chars[idx % chars.length];
	}

	// Device ID2: 32 hex chars (different seed multiplier)
	for (let i = 0; i < 32; i++) {
		const idx = parseInt(seed.charAt(i % seed.length), 16) ^ (i * 13);
		deviceId2 += chars[idx % chars.length];
	}

	return { serialNumber, deviceId, deviceId2 };
}

export class PortalScanWorker extends TaskWorker<PortalScanWorkerMetadata> {
	readonly type: WorkerType = 'portal-scan';

	private options: PortalScanOptions;
	private macGenerator: Generator<string> | null = null;
	private totalMacs: number = 0;

	constructor(options: PortalScanOptions) {
		super({
			portalId: options.portalId,
			portalName: options.portalName,
			portalUrl: options.portalUrl,
			scanType: options.scanType,
			macPrefix: options.macPrefix,
			macRangeStart: options.macRangeStart,
			macRangeEnd: options.macRangeEnd,
			totalMacs: 0,
			testedMacs: 0,
			foundMacs: 0,
			rateLimit: options.rateLimit || 500
		});

		this.options = options;
	}

	/**
	 * Initialize the MAC generator based on scan type
	 */
	private initializeMacGenerator(): void {
		const { scanType, macPrefix, macRangeStart, macRangeEnd, importedMacs, macCount } =
			this.options;

		switch (scanType) {
			case 'random': {
				const count = macCount || 100;
				const prefix = macPrefix || '00:1A:79';
				this.macGenerator = MacGenerator.generateRandom(prefix, count);
				this.totalMacs = count;
				this.log('info', `Initialized random scan: ${count} MACs with prefix ${prefix}`);
				break;
			}

			case 'sequential': {
				if (!macRangeStart || !macRangeEnd) {
					throw new Error('Sequential scan requires macRangeStart and macRangeEnd');
				}
				this.macGenerator = MacGenerator.generateSequential(macRangeStart, macRangeEnd);
				this.totalMacs = MacGenerator.getRangeSize(macRangeStart, macRangeEnd);
				this.log('info', `Initialized sequential scan: ${macRangeStart} to ${macRangeEnd}`);
				break;
			}

			case 'import': {
				if (!importedMacs || importedMacs.length === 0) {
					throw new Error('Import scan requires a list of MAC addresses');
				}
				// Create generator from imported list
				const macs = importedMacs;
				this.macGenerator = (function* () {
					for (const mac of macs) {
						yield mac;
					}
				})();
				this.totalMacs = importedMacs.length;
				this.log('info', `Initialized import scan: ${importedMacs.length} MACs`);
				break;
			}

			default:
				throw new Error(`Unknown scan type: ${scanType}`);
		}

		this.updateMetadata({ totalMacs: this.totalMacs });
	}

	/**
	 * Create a scan history record
	 */
	private createHistoryRecord(): string {
		const historyId = randomUUID();
		const now = new Date().toISOString();

		db.insert(portalScanHistory)
			.values({
				id: historyId,
				portalId: this.options.portalId,
				workerId: this.id,
				scanType: this.options.scanType,
				macPrefix: this.options.macPrefix,
				macRangeStart: this.options.macRangeStart,
				macRangeEnd: this.options.macRangeEnd,
				macsToTest: this.totalMacs,
				macsTested: 0,
				macsFound: 0,
				status: 'running',
				startedAt: now
			})
			.run();

		this.updateMetadata({ historyId });
		return historyId;
	}

	/**
	 * Update the scan history record with progress
	 */
	private updateHistoryProgress(tested: number, found: number): void {
		const historyId = this._metadata.historyId;
		if (!historyId) return;

		db.update(portalScanHistory)
			.set({
				macsTested: tested,
				macsFound: found
			})
			.where(eq(portalScanHistory.id, historyId))
			.run();
	}

	/**
	 * Complete the scan history record
	 */
	private completeHistoryRecord(
		status: 'completed' | 'cancelled' | 'failed',
		error?: string
	): void {
		const historyId = this._metadata.historyId;
		if (!historyId) return;

		const now = new Date().toISOString();

		db.update(portalScanHistory)
			.set({
				status,
				error,
				macsTested: this._metadata.testedMacs,
				macsFound: this._metadata.foundMacs,
				completedAt: now
			})
			.where(eq(portalScanHistory.id, historyId))
			.run();
	}

	/**
	 * Test a single MAC address against the portal
	 */
	private async testMac(mac: string): Promise<boolean> {
		const { serialNumber, deviceId, deviceId2 } = generateDeviceIds(mac);

		const client = new StalkerPortalClient({
			portalUrl: this.options.portalUrl,
			macAddress: mac,
			serialNumber,
			deviceId,
			deviceId2,
			model: 'MAG254',
			timezone: 'Europe/London',
			endpoint: this.options.portalEndpoint
		});

		try {
			// Use fast test (3 API calls instead of 5-6) for scanning efficiency
			const testResult = await client.testConnectionFast();

			if (!testResult.success || !testResult.profile) {
				return false;
			}

			const profile = testResult.profile;

			// Save to scan results
			const now = new Date().toISOString();
			const resultId = randomUUID();

			db.insert(portalScanResults)
				.values({
					id: resultId,
					portalId: this.options.portalId,
					macAddress: mac,
					status: 'pending',
					channelCount: profile.channelCount,
					categoryCount: profile.categoryCount,
					expiresAt: profile.expiresAt,
					accountStatus: 'active',
					playbackLimit: profile.playbackLimit,
					serverTimezone: profile.serverTimezone,
					rawProfile: JSON.stringify(profile),
					discoveredAt: now
				})
				.onConflictDoUpdate({
					target: [portalScanResults.portalId, portalScanResults.macAddress],
					set: {
						channelCount: profile.channelCount,
						categoryCount: profile.categoryCount,
						expiresAt: profile.expiresAt,
						accountStatus: 'active',
						playbackLimit: profile.playbackLimit,
						serverTimezone: profile.serverTimezone,
						rawProfile: JSON.stringify(profile),
						discoveredAt: now,
						status: 'pending', // Reset status on rediscovery
						processedAt: null
					}
				})
				.run();

			this.log('info', `Found valid MAC: ${mac}`, {
				channelCount: profile.channelCount,
				categoryCount: profile.categoryCount,
				expiresAt: profile.expiresAt
			});

			return true;
		} catch {
			// MAC is invalid or portal returned error
			return false;
		}
	}

	/**
	 * Execute the portal scan
	 */
	protected async execute(): Promise<void> {
		const { portalName, portalUrl, rateLimit } = this._metadata;

		this.log('info', `Starting portal scan for ${portalName}`, { portalUrl });

		// Initialize MAC generator
		this.initializeMacGenerator();

		if (!this.macGenerator) {
			throw new Error('Failed to initialize MAC generator');
		}

		// Create history record
		this.createHistoryRecord();

		let testedMacs = 0;
		let foundMacs = 0;
		const rateLimitMs = rateLimit || 500;

		try {
			for (const mac of this.macGenerator) {
				// Check for cancellation
				this.throwIfCancelled();

				// Update current MAC
				this.updateMetadata({ currentMac: mac });

				// Test the MAC
				const isValid = await this.testMac(mac);

				testedMacs++;
				if (isValid) {
					foundMacs++;
				}

				// Update progress
				this.updateMetadata({
					testedMacs,
					foundMacs
				});

				const progress = this.totalMacs > 0 ? (testedMacs / this.totalMacs) * 100 : 0;
				this.setProgress(progress);

				// Update history every 10 MACs
				if (testedMacs % 10 === 0) {
					this.updateHistoryProgress(testedMacs, foundMacs);
				}

				// Log progress periodically
				if (testedMacs % 50 === 0) {
					this.log(
						'info',
						`Scan progress: ${testedMacs}/${this.totalMacs} tested, ${foundMacs} found`
					);
				}

				// Rate limiting
				if (rateLimitMs > 0) {
					await this.sleep(rateLimitMs);
				}
			}

			// Final update
			this.updateMetadata({ currentMac: undefined });
			this.completeHistoryRecord('completed');

			this.log('info', `Scan completed: ${testedMacs} tested, ${foundMacs} found`, {
				testedMacs,
				foundMacs,
				totalMacs: this.totalMacs
			});
		} catch (error) {
			if (this.signal.aborted) {
				this.completeHistoryRecord('cancelled');
				throw error;
			} else {
				this.completeHistoryRecord(
					'failed',
					error instanceof Error ? error.message : String(error)
				);
				throw error;
			}
		}
	}

	/**
	 * Sleep helper for rate limiting
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Get scan summary
	 */
	getSummary(): {
		portalId: string;
		portalName: string;
		scanType: string;
		testedMacs: number;
		foundMacs: number;
		totalMacs: number;
		duration: number;
	} {
		const duration = this._startedAt
			? (this._completedAt || new Date()).getTime() - this._startedAt.getTime()
			: 0;

		return {
			portalId: this._metadata.portalId,
			portalName: this._metadata.portalName,
			scanType: this._metadata.scanType,
			testedMacs: this._metadata.testedMacs,
			foundMacs: this._metadata.foundMacs,
			totalMacs: this._metadata.totalMacs,
			duration
		};
	}
}
