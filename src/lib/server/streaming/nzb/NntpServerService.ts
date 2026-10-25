/**
 * NntpServerService - Manages NNTP server configurations for NZB streaming.
 * Provides CRUD operations and sync with download clients.
 */

import { db } from '#lib/server/db/index.js';
import {
	nntpServers,
	type NntpServerRecord,
	type NewNntpServerRecord
} from '#lib/server/db/schema.js';
import { eq, asc } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { randomUUID } from 'node:crypto';

const logger = createChildLogger({ logDomain: 'streams' as const });
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import type { NntpServerCreate, NntpServerUpdate } from '#lib/validation/schemas.js';
import {
	decryptCredential,
	encryptCredential,
	isEncryptedCredential
} from '#lib/server/crypto/credentialsCrypto.js';

/** AAD purpose for NNTP credentials at rest. */
const NNTP_CRED_PURPOSE = 'nntp-server';

function encryptNntpCredential(serverId: string, value: string | null): string | null {
	if (value && !isEncryptedCredential(value)) {
		return encryptCredential(NNTP_CRED_PURPOSE, serverId, value);
	}
	return value;
}

function decryptNntpCredential(
	serverId: string,
	value: string | null,
	field: string
): string | null {
	if (value && isEncryptedCredential(value)) {
		return decryptCredential(
			NNTP_CRED_PURPOSE,
			serverId,
			value,
			`nntp-server:${serverId}:${field}`
		);
	}
	return value;
}

/** Decrypt a stored record's credentials in place (plaintext-tolerant). */
function decryptRecord(record: NntpServerRecord): NntpServerRecord {
	record.username = decryptNntpCredential(record.id, record.username, 'username');
	record.password = decryptNntpCredential(record.id, record.password, 'password');
	return record;
}

/**
 * Public NNTP server info (password redacted).
 */
export interface NntpServerInfo {
	id: string;
	name: string;
	host: string;
	port: number;
	useSsl: boolean;
	username: string | null;
	hasPassword: boolean;
	maxConnections: number;
	priority: number;
	enabled: boolean;
	downloadClientId: string | null;
	autoFetched: boolean;
	lastTestedAt: string | null;
	testResult: string | null;
	testError: string | null;
	createdAt: string | null;
	updatedAt: string | null;
}

/**
 * Convert database record to public info (redact password; username stays
 * visible but is encrypted at rest, so decrypt for the response).
 */
function toPublicInfo(record: NntpServerRecord): NntpServerInfo {
	return {
		id: record.id,
		name: record.name,
		host: record.host,
		port: record.port,
		useSsl: record.useSsl ?? true,
		username: decryptNntpCredential(record.id, record.username, 'username'),
		hasPassword: !!record.password,
		maxConnections: record.maxConnections ?? 10,
		priority: record.priority ?? 1,
		enabled: record.enabled ?? true,
		downloadClientId: record.downloadClientId,
		autoFetched: record.autoFetched ?? false,
		lastTestedAt: record.lastTestedAt,
		testResult: record.testResult,
		testError: record.testError,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt
	};
}

class NntpServerService {
	/**
	 * Get all NNTP servers (passwords redacted).
	 */
	async getServers(): Promise<NntpServerInfo[]> {
		const records = await db.select().from(nntpServers).orderBy(asc(nntpServers.priority));
		return records.map(toPublicInfo);
	}

	/**
	 * Get a single NNTP server by ID (passwords redacted).
	 */
	async getServer(id: string): Promise<NntpServerInfo | null> {
		const records = await db.select().from(nntpServers).where(eq(nntpServers.id, id));
		return records.length > 0 ? toPublicInfo(records[0]) : null;
	}

	/**
	 * Get server with password (for internal use only).
	 */
	async getServerWithPassword(id: string): Promise<NntpServerRecord | null> {
		const records = await db.select().from(nntpServers).where(eq(nntpServers.id, id));
		return records.length > 0 ? decryptRecord(records[0]) : null;
	}

	/**
	 * Get all enabled servers ordered by priority (for streaming).
	 */
	async getEnabledServers(): Promise<NntpServerRecord[]> {
		const records = await db
			.select()
			.from(nntpServers)
			.where(eq(nntpServers.enabled, true))
			.orderBy(asc(nntpServers.priority));
		return records.map(decryptRecord);
	}

	/**
	 * Create a new NNTP server.
	 */
	async createServer(input: NntpServerCreate): Promise<NntpServerInfo> {
		const now = new Date().toISOString();
		const id = randomUUID();
		const newServer: NewNntpServerRecord = {
			id,
			name: input.name,
			host: input.host,
			port: input.port ?? 563,
			useSsl: input.useSsl ?? true,
			username: encryptNntpCredential(id, input.username || null),
			password: encryptNntpCredential(id, input.password || null),
			maxConnections: input.maxConnections ?? 10,
			priority: input.priority ?? 1,
			enabled: input.enabled ?? true,
			downloadClientId: input.downloadClientId || null,
			autoFetched: false,
			createdAt: now,
			updatedAt: now
		};

		const [created] = await db.insert(nntpServers).values(newServer).returning();
		logger.info({ id: created.id, name: created.name }, '[NntpServerService] Created NNTP server');
		return toPublicInfo(created);
	}

	/**
	 * Update an NNTP server.
	 */
	async updateServer(id: string, input: NntpServerUpdate): Promise<NntpServerInfo | null> {
		const existing = await this.getServerWithPassword(id);
		if (!existing) {
			return null;
		}

		const updates: Partial<NntpServerRecord> = {
			updatedAt: new Date().toISOString()
		};

		if (input.name !== undefined) updates.name = input.name;
		if (input.host !== undefined) updates.host = input.host;
		if (input.port !== undefined) updates.port = input.port;
		if (input.useSsl !== undefined) updates.useSsl = input.useSsl;
		if (input.username !== undefined)
			updates.username = encryptNntpCredential(id, input.username || null);
		if (input.password !== undefined)
			updates.password = encryptNntpCredential(id, input.password || null);
		if (input.maxConnections !== undefined) updates.maxConnections = input.maxConnections;
		if (input.priority !== undefined) updates.priority = input.priority;
		if (input.enabled !== undefined) updates.enabled = input.enabled;
		if (input.downloadClientId !== undefined)
			updates.downloadClientId = input.downloadClientId || null;

		const [updated] = await db
			.update(nntpServers)
			.set(updates)
			.where(eq(nntpServers.id, id))
			.returning();

		logger.info({ id }, '[NntpServerService] Updated NNTP server');
		return toPublicInfo(updated);
	}

	/**
	 * Delete an NNTP server.
	 */
	async deleteServer(id: string): Promise<boolean> {
		const result = await db.delete(nntpServers).where(eq(nntpServers.id, id)).returning();
		const deleted = result.length > 0;
		if (deleted) {
			logger.info({ id }, '[NntpServerService] Deleted NNTP server');
		}
		return deleted;
	}

	/**
	 * Sync NNTP servers from all Usenet download clients.
	 * Creates new servers for ones not already synced.
	 */
	async syncFromDownloadClients(): Promise<{
		synced: number;
		skipped: number;
		errors: string[];
	}> {
		const manager = getDownloadClientManager();
		const clients = await manager.getEnabledClientsForProtocol('usenet');

		let synced = 0;
		let skipped = 0;
		const errors: string[] = [];

		for (const { client, instance } of clients) {
			if (!instance.getNntpServers) {
				continue;
			}

			try {
				const servers = await instance.getNntpServers();
				for (const server of servers) {
					// Check if already exists (by host + downloadClientId)
					const existing = await db
						.select()
						.from(nntpServers)
						.where(eq(nntpServers.host, server.host))
						.limit(1);

					if (existing.length > 0) {
						skipped++;
						continue;
					}

					// Create new server record
					const now = new Date().toISOString();
					const serverId = randomUUID();
					await db.insert(nntpServers).values({
						id: serverId,
						name: server.name,
						host: server.host,
						port: server.port,
						useSsl: server.useSsl,
						username: encryptNntpCredential(serverId, server.username || null),
						password: encryptNntpCredential(serverId, server.password || null),
						maxConnections: server.maxConnections,
						priority: server.priority,
						enabled: server.enabled,
						downloadClientId: client.id,
						autoFetched: true,
						createdAt: now,
						updatedAt: now
					});
					synced++;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Unknown error';
				errors.push(`${client.name}: ${message}`);
				logger.error(
					{
						clientId: client.id,
						error: message
					},
					'[NntpServerService] Failed to sync from download client'
				);
			}
		}

		logger.info({ synced, skipped, errors: errors.length }, '[NntpServerService] Sync completed');
		return { synced, skipped, errors };
	}

	/**
	 * Update test result for a server.
	 */
	async updateTestResult(id: string, result: 'success' | 'failed', error?: string): Promise<void> {
		await db
			.update(nntpServers)
			.set({
				lastTestedAt: new Date().toISOString(),
				testResult: result,
				testError: error || null,
				updatedAt: new Date().toISOString()
			})
			.where(eq(nntpServers.id, id));
	}
}

// Singleton instance
let instance: NntpServerService | null = null;

export function getNntpServerService(): NntpServerService {
	if (!instance) {
		instance = new NntpServerService();
	}
	return instance;
}
