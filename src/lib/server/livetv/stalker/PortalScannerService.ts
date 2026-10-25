/**
 * Portal Scanner Service
 *
 * Manages portal scanning operations and scan results.
 * Provides interfaces for starting scans and managing discovered accounts.
 */

import { eq, and, inArray, desc } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import {
	portalScanResults,
	portalScanHistory,
	livetvAccounts,
	type PortalScanResultRecord,
	type PortalScanHistoryRecord
} from '#lib/server/db/schema.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'livetv' as const });
import {
	workerManager,
	PortalScanWorker,
	type PortalScanOptions
} from '#lib/server/workers/index.js';
import { getStalkerPortalManager } from './StalkerPortalManager';
import { getLiveTvAccountManager } from '../LiveTvAccountManager';
import { getLiveTvChannelService } from '../LiveTvChannelService';
import { MacGenerator } from './MacGenerator';

export interface ScanResult {
	id: string;
	portalId: string;
	macAddress: string;
	status: 'pending' | 'approved' | 'ignored' | 'expired';
	channelCount: number | null;
	categoryCount: number | null;
	expiresAt: string | null;
	accountStatus: 'active' | 'expired' | null;
	playbackLimit: number | null;
	serverTimezone: string | null;
	rawProfile: Record<string, unknown> | null;
	discoveredAt: string;
	processedAt: string | null;
}

export interface ScanHistoryEntry {
	id: string;
	portalId: string;
	workerId: string | null;
	scanType: 'random' | 'sequential' | 'import';
	macPrefix: string | null;
	macRangeStart: string | null;
	macRangeEnd: string | null;
	macsToTest: number | null;
	macsTested: number;
	macsFound: number;
	status: 'running' | 'completed' | 'cancelled' | 'failed';
	error: string | null;
	startedAt: string;
	completedAt: string | null;
}

export interface RandomScanOptions {
	macPrefix?: string;
	macCount: number;
	rateLimit?: number;
}

export interface SequentialScanOptions {
	macRangeStart: string;
	macRangeEnd: string;
	rateLimit?: number;
}

export interface ImportScanOptions {
	macs: string[];
	rateLimit?: number;
}

function recordToScanResult(record: PortalScanResultRecord): ScanResult {
	let rawProfile: Record<string, unknown> | null = null;
	if (record.rawProfile) {
		try {
			rawProfile = JSON.parse(record.rawProfile);
		} catch {
			// Invalid JSON
		}
	}

	return {
		id: record.id,
		portalId: record.portalId,
		macAddress: record.macAddress,
		status: (record.status as ScanResult['status']) || 'pending',
		channelCount: record.channelCount,
		categoryCount: record.categoryCount,
		expiresAt: record.expiresAt,
		accountStatus: record.accountStatus as ScanResult['accountStatus'],
		playbackLimit: record.playbackLimit,
		serverTimezone: record.serverTimezone,
		rawProfile,
		discoveredAt: record.discoveredAt,
		processedAt: record.processedAt
	};
}

function recordToScanHistory(record: PortalScanHistoryRecord): ScanHistoryEntry {
	return {
		id: record.id,
		portalId: record.portalId,
		workerId: record.workerId,
		scanType: (record.scanType as ScanHistoryEntry['scanType']) || 'random',
		macPrefix: record.macPrefix,
		macRangeStart: record.macRangeStart,
		macRangeEnd: record.macRangeEnd,
		macsToTest: record.macsToTest,
		macsTested: record.macsTested || 0,
		macsFound: record.macsFound || 0,
		status: (record.status as ScanHistoryEntry['status']) || 'running',
		error: record.error,
		startedAt: record.startedAt,
		completedAt: record.completedAt
	};
}

export class PortalScannerService {
	/**
	 * Start a random MAC scan
	 */
	async startRandomScan(portalId: string, options: RandomScanOptions): Promise<PortalScanWorker> {
		const portalManager = getStalkerPortalManager();
		const portal = await portalManager.getPortal(portalId);

		if (!portal) {
			throw new Error(`Portal not found: ${portalId}`);
		}

		const scanOptions: PortalScanOptions = {
			portalId: portal.id,
			portalName: portal.name,
			portalUrl: portal.url,
			portalEndpoint: portal.endpoint || undefined,
			scanType: 'random',
			macPrefix: options.macPrefix || '00:1A:79',
			macCount: options.macCount,
			rateLimit: options.rateLimit || 500
		};

		const worker = new PortalScanWorker(scanOptions);

		try {
			workerManager.spawnInBackground(worker);
			logger.info(
				{
					portalId,
					portalName: portal.name,
					macPrefix: scanOptions.macPrefix,
					macCount: options.macCount,
					workerId: worker.id
				},
				'[PortalScanner] Started random scan'
			);
		} catch (error) {
			logger.error(
				{
					portalId,
					error: error instanceof Error ? error.message : String(error)
				},
				'[PortalScanner] Failed to start random scan'
			);
			throw error;
		}

		return worker;
	}

	/**
	 * Start a sequential MAC scan
	 */
	async startSequentialScan(
		portalId: string,
		options: SequentialScanOptions
	): Promise<PortalScanWorker> {
		const portalManager = getStalkerPortalManager();
		const portal = await portalManager.getPortal(portalId);

		if (!portal) {
			throw new Error(`Portal not found: ${portalId}`);
		}

		// Validate MAC range
		const rangeSize = MacGenerator.getRangeSize(options.macRangeStart, options.macRangeEnd);
		if (rangeSize > 1000000) {
			throw new Error(`MAC range too large: ${rangeSize}. Maximum: 1,000,000`);
		}

		const scanOptions: PortalScanOptions = {
			portalId: portal.id,
			portalName: portal.name,
			portalUrl: portal.url,
			portalEndpoint: portal.endpoint || undefined,
			scanType: 'sequential',
			macRangeStart: options.macRangeStart,
			macRangeEnd: options.macRangeEnd,
			rateLimit: options.rateLimit || 500
		};

		const worker = new PortalScanWorker(scanOptions);

		try {
			workerManager.spawnInBackground(worker);
			logger.info(
				{
					portalId,
					portalName: portal.name,
					macRangeStart: options.macRangeStart,
					macRangeEnd: options.macRangeEnd,
					rangeSize,
					workerId: worker.id
				},
				'[PortalScanner] Started sequential scan'
			);
		} catch (error) {
			logger.error(
				{
					portalId,
					error: error instanceof Error ? error.message : String(error)
				},
				'[PortalScanner] Failed to start sequential scan'
			);
			throw error;
		}

		return worker;
	}

	/**
	 * Start an import scan with a list of MACs
	 */
	async startImportScan(portalId: string, options: ImportScanOptions): Promise<PortalScanWorker> {
		const portalManager = getStalkerPortalManager();
		const portal = await portalManager.getPortal(portalId);

		if (!portal) {
			throw new Error(`Portal not found: ${portalId}`);
		}

		// Parse and validate MACs
		const macs = MacGenerator.parseImportedMacs(options.macs.join('\n'));
		if (macs.length === 0) {
			throw new Error('No valid MAC addresses found in import list');
		}

		const scanOptions: PortalScanOptions = {
			portalId: portal.id,
			portalName: portal.name,
			portalUrl: portal.url,
			portalEndpoint: portal.endpoint || undefined,
			scanType: 'import',
			importedMacs: macs,
			rateLimit: options.rateLimit || 500
		};

		const worker = new PortalScanWorker(scanOptions);

		try {
			workerManager.spawnInBackground(worker);
			logger.info(
				{
					portalId,
					portalName: portal.name,
					macCount: macs.length,
					workerId: worker.id
				},
				'[PortalScanner] Started import scan'
			);
		} catch (error) {
			logger.error(
				{
					portalId,
					error: error instanceof Error ? error.message : String(error)
				},
				'[PortalScanner] Failed to start import scan'
			);
			throw error;
		}

		return worker;
	}

	/**
	 * Get scan results for a portal
	 */
	async getScanResults(portalId: string, status?: ScanResult['status']): Promise<ScanResult[]> {
		let query = db.select().from(portalScanResults).where(eq(portalScanResults.portalId, portalId));

		if (status) {
			query = db
				.select()
				.from(portalScanResults)
				.where(and(eq(portalScanResults.portalId, portalId), eq(portalScanResults.status, status)));
		}

		const records = query.orderBy(desc(portalScanResults.discoveredAt)).all();
		return records.map(recordToScanResult);
	}

	/**
	 * Get a single scan result
	 */
	async getScanResult(resultId: string): Promise<ScanResult | null> {
		const record = db
			.select()
			.from(portalScanResults)
			.where(eq(portalScanResults.id, resultId))
			.get();

		if (!record) {
			return null;
		}

		return recordToScanResult(record);
	}

	/**
	 * Approve a scan result - creates an account and triggers channel sync
	 */
	async approveResult(resultId: string, accountName?: string): Promise<string> {
		const result = await this.getScanResult(resultId);
		if (!result) {
			throw new Error(`Scan result not found: ${resultId}`);
		}

		if (result.status !== 'pending') {
			throw new Error(`Scan result already processed: ${result.status}`);
		}

		const portalManager = getStalkerPortalManager();
		const portal = await portalManager.getPortal(result.portalId);

		if (!portal) {
			throw new Error(`Portal not found: ${result.portalId}`);
		}

		// Create the account
		const accountManager = getLiveTvAccountManager();
		const account = await accountManager.createAccount(
			{
				name: accountName || `${portal.name} - ${result.macAddress}`,
				providerType: 'stalker',
				enabled: true,
				stalkerConfig: {
					portalUrl: portal.url,
					macAddress: result.macAddress
				}
			},
			false // Don't test again - we already know it works
		);

		// Update the account to link to the portal and mark as discovered
		// Note: portalId and discoveredFromScan are now stored in stalkerConfig
		const existingConfig = account.stalkerConfig || {
			portalUrl: portal.url,
			macAddress: result.macAddress
		};
		const updatedStalkerConfig = {
			...existingConfig,
			portalId: portal.id,
			discoveredFromScan: true
		};
		db.update(livetvAccounts)
			.set({
				stalkerConfig: updatedStalkerConfig
			})
			.where(eq(livetvAccounts.id, account.id))
			.run();

		// Mark result as approved
		const now = new Date().toISOString();
		db.update(portalScanResults)
			.set({
				status: 'approved',
				processedAt: now
			})
			.where(eq(portalScanResults.id, resultId))
			.run();

		// Trigger channel sync in background
		const channelService = getLiveTvChannelService();
		channelService.syncChannels(account.id).catch((error) => {
			logger.warn(
				{
					accountId: account.id,
					error: error instanceof Error ? error.message : String(error)
				},
				'[PortalScanner] Channel sync failed after approval'
			);
		});

		logger.info(
			{
				resultId,
				accountId: account.id,
				macAddress: result.macAddress
			},
			'[PortalScanner] Approved scan result'
		);

		return account.id;
	}

	/**
	 * Approve multiple scan results
	 */
	async approveMultiple(resultIds: string[]): Promise<string[]> {
		const accountIds: string[] = [];

		for (const resultId of resultIds) {
			try {
				const accountId = await this.approveResult(resultId);
				accountIds.push(accountId);
			} catch (error) {
				logger.warn(
					{
						resultId,
						error: error instanceof Error ? error.message : String(error)
					},
					'[PortalScanner] Failed to approve result'
				);
			}
		}

		return accountIds;
	}

	/**
	 * Ignore a scan result
	 */
	async ignoreResult(resultId: string): Promise<void> {
		const result = await this.getScanResult(resultId);
		if (!result) {
			throw new Error(`Scan result not found: ${resultId}`);
		}

		if (result.status !== 'pending') {
			throw new Error(`Scan result already processed: ${result.status}`);
		}

		const now = new Date().toISOString();
		db.update(portalScanResults)
			.set({
				status: 'ignored',
				processedAt: now
			})
			.where(eq(portalScanResults.id, resultId))
			.run();

		logger.info(
			{
				resultId,
				macAddress: result.macAddress
			},
			'[PortalScanner] Ignored scan result'
		);
	}

	/**
	 * Ignore multiple scan results
	 */
	async ignoreMultiple(resultIds: string[]): Promise<void> {
		const now = new Date().toISOString();

		db.update(portalScanResults)
			.set({
				status: 'ignored',
				processedAt: now
			})
			.where(inArray(portalScanResults.id, resultIds))
			.run();

		logger.info(
			{
				count: resultIds.length
			},
			'[PortalScanner] Ignored multiple scan results'
		);
	}

	/**
	 * Clear scan results for a portal
	 */
	async clearResults(portalId: string, status?: ScanResult['status']): Promise<number> {
		let deleted: number;

		if (status) {
			const result = db
				.delete(portalScanResults)
				.where(and(eq(portalScanResults.portalId, portalId), eq(portalScanResults.status, status)))
				.run();
			deleted = result.changes;
		} else {
			const result = db
				.delete(portalScanResults)
				.where(eq(portalScanResults.portalId, portalId))
				.run();
			deleted = result.changes;
		}

		logger.info(
			{
				portalId,
				status,
				deleted
			},
			'[PortalScanner] Cleared scan results'
		);

		return deleted;
	}

	/**
	 * Get scan history for a portal
	 */
	async getScanHistory(portalId: string, limit: number = 20): Promise<ScanHistoryEntry[]> {
		const records = db
			.select()
			.from(portalScanHistory)
			.where(eq(portalScanHistory.portalId, portalId))
			.orderBy(desc(portalScanHistory.startedAt))
			.limit(limit)
			.all();

		return records.map(recordToScanHistory);
	}

	/**
	 * Get active scans for a portal
	 */
	async getActiveScans(portalId: string): Promise<ScanHistoryEntry[]> {
		const records = db
			.select()
			.from(portalScanHistory)
			.where(and(eq(portalScanHistory.portalId, portalId), eq(portalScanHistory.status, 'running')))
			.all();

		return records.map(recordToScanHistory);
	}

	/**
	 * Cancel an active scan
	 */
	async cancelScan(workerId: string): Promise<boolean> {
		return workerManager.cancel(workerId);
	}
}

// Singleton instance
let scannerService: PortalScannerService | null = null;

export function getPortalScannerService(): PortalScannerService {
	if (!scannerService) {
		scannerService = new PortalScannerService();
	}
	return scannerService;
}
