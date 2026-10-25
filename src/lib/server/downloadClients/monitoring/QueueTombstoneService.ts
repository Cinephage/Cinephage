import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import { db } from '#lib/server/db/index.js';
import { downloadQueue, downloadQueueTombstones } from '#lib/server/db/schema.js';
import type { DownloadInfo } from '../core/interfaces';

const logger = createChildLogger({ logDomain: 'monitoring' as const });

const DEFAULT_SUPPRESSION_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_EXPIRY_GRACE_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function getPositiveIntEnv(name: string, fallback: number): number {
	const envValue = process.env[name];
	if (!envValue) {
		return fallback;
	}

	const parsed = Number(envValue);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}

	return Math.round(parsed);
}

const TOMBSTONE_SUPPRESSION_MS = getPositiveIntEnv(
	'QUEUE_TOMBSTONE_SUPPRESSION_MS',
	DEFAULT_SUPPRESSION_MS
);
const TOMBSTONE_EXPIRY_GRACE_MS = getPositiveIntEnv(
	'QUEUE_TOMBSTONE_EXPIRY_GRACE_MS',
	DEFAULT_EXPIRY_GRACE_MS
);
const TOMBSTONE_CLEANUP_INTERVAL_MS = getPositiveIntEnv(
	'QUEUE_TOMBSTONE_CLEANUP_INTERVAL_MS',
	DEFAULT_CLEANUP_INTERVAL_MS
);

function normalizeProtocol(protocol?: string | null): string {
	if (protocol === 'usenet') return 'usenet';
	if (protocol === 'torrent') return 'torrent';
	return protocol || 'torrent';
}

function normalizeRemoteId(remoteId?: string | null): string | null {
	if (!remoteId) return null;
	const normalized = remoteId.trim().toLowerCase();
	return normalized.length > 0 ? normalized : null;
}

function parseTimestamp(value?: string | null): number | null {
	if (!value) {
		return null;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function resolveQueueRemoteId(params: {
	protocol?: string | null;
	downloadId?: string | null;
	infoHash?: string | null;
}): string | null {
	const protocol = normalizeProtocol(params.protocol);
	if (protocol === 'torrent') {
		return normalizeRemoteId(params.infoHash || params.downloadId);
	}
	return normalizeRemoteId(params.downloadId || params.infoHash);
}

async function upsertTombstone(params: {
	downloadClientId: string;
	protocol: string;
	remoteId: string;
	reason?: string;
	suppressionMs?: number;
	lastSeenAt?: string | null;
}): Promise<void> {
	const now = new Date();
	const nowIso = now.toISOString();
	const suppressionMs = params.suppressionMs ?? TOMBSTONE_SUPPRESSION_MS;
	const suppressedUntil = new Date(now.getTime() + suppressionMs).toISOString();

	await db
		.insert(downloadQueueTombstones)
		.values({
			id: randomUUID(),
			downloadClientId: params.downloadClientId,
			protocol: normalizeProtocol(params.protocol),
			remoteId: params.remoteId,
			reason: params.reason ?? null,
			suppressedUntil,
			lastSeenAt: params.lastSeenAt ?? nowIso,
			createdAt: nowIso,
			updatedAt: nowIso
		})
		.onConflictDoUpdate({
			target: [
				downloadQueueTombstones.downloadClientId,
				downloadQueueTombstones.protocol,
				downloadQueueTombstones.remoteId
			],
			set: {
				createdAt: nowIso,
				reason: params.reason ?? null,
				suppressedUntil,
				lastSeenAt: params.lastSeenAt ?? nowIso,
				updatedAt: nowIso
			}
		});
}

export async function upsertQueueTombstoneFromQueueItem(
	queueItem: typeof downloadQueue.$inferSelect,
	reason = 'local_remove_client_unavailable'
): Promise<boolean> {
	const remoteId = resolveQueueRemoteId(queueItem);
	if (!remoteId) {
		return false;
	}

	await upsertTombstone({
		downloadClientId: queueItem.downloadClientId,
		protocol: normalizeProtocol(queueItem.protocol),
		remoteId,
		reason
	});

	return true;
}

export async function isQueueItemSuppressed(params: {
	downloadClientId: string;
	protocol?: string | null;
	downloadId?: string | null;
	infoHash?: string | null;
}): Promise<boolean> {
	const remoteId = resolveQueueRemoteId(params);
	if (!remoteId) {
		return false;
	}

	const nowIso = new Date().toISOString();
	const existing = await db
		.select({ id: downloadQueueTombstones.id })
		.from(downloadQueueTombstones)
		.where(
			and(
				eq(downloadQueueTombstones.downloadClientId, params.downloadClientId),
				eq(downloadQueueTombstones.protocol, normalizeProtocol(params.protocol)),
				eq(downloadQueueTombstones.remoteId, remoteId),
				gt(downloadQueueTombstones.suppressedUntil, nowIso)
			)
		)
		.limit(1);

	return existing.length > 0;
}

export async function extendQueueTombstonesFromDownloads(params: {
	downloadClientId: string;
	protocol?: string | null;
	downloads: DownloadInfo[];
}): Promise<void> {
	const protocol = normalizeProtocol(params.protocol);
	const hasTombstones = await db
		.select({ id: downloadQueueTombstones.id })
		.from(downloadQueueTombstones)
		.where(
			and(
				eq(downloadQueueTombstones.downloadClientId, params.downloadClientId),
				eq(downloadQueueTombstones.protocol, protocol)
			)
		)
		.limit(1);
	if (hasTombstones.length === 0) {
		return;
	}

	const remoteIds = Array.from(
		new Set(
			params.downloads
				.map((download) => normalizeRemoteId(download.hash))
				.filter((value): value is string => value !== null)
		)
	);

	if (remoteIds.length === 0) {
		return;
	}

	const now = new Date();
	const nowIso = now.toISOString();
	const nowPlusSuppressionMs = now.getTime() + TOMBSTONE_SUPPRESSION_MS;

	// SQLite has a limit on bound params; update in chunks for large download lists.
	const chunkSize = 500;
	for (let i = 0; i < remoteIds.length; i += chunkSize) {
		const chunk = remoteIds.slice(i, i + chunkSize);
		const rows = await db
			.select({
				id: downloadQueueTombstones.id,
				createdAt: downloadQueueTombstones.createdAt
			})
			.from(downloadQueueTombstones)
			.where(
				and(
					eq(downloadQueueTombstones.downloadClientId, params.downloadClientId),
					eq(downloadQueueTombstones.protocol, protocol),
					inArray(downloadQueueTombstones.remoteId, chunk)
				)
			);

		for (const row of rows) {
			const createdAtMs = parseTimestamp(row.createdAt);
			const hardMaxMs =
				createdAtMs !== null ? createdAtMs + TOMBSTONE_SUPPRESSION_MS : nowPlusSuppressionMs;
			const nextSuppressedUntil = new Date(Math.min(nowPlusSuppressionMs, hardMaxMs)).toISOString();

			await db
				.update(downloadQueueTombstones)
				.set({
					suppressedUntil: nextSuppressedUntil,
					lastSeenAt: nowIso,
					updatedAt: nowIso
				})
				.where(eq(downloadQueueTombstones.id, row.id));
		}
	}
}

export async function cleanupExpiredQueueTombstones(
	graceMs = TOMBSTONE_EXPIRY_GRACE_MS
): Promise<number> {
	const cutoffIso = new Date(Date.now() - graceMs).toISOString();
	const expired = await db
		.select({ id: downloadQueueTombstones.id })
		.from(downloadQueueTombstones)
		.where(lt(downloadQueueTombstones.suppressedUntil, cutoffIso));

	if (expired.length === 0) {
		return 0;
	}

	await db
		.delete(downloadQueueTombstones)
		.where(lt(downloadQueueTombstones.suppressedUntil, cutoffIso));

	logger.info(
		{
			deleted: expired.length
		},
		'Cleaned up expired queue tombstones'
	);

	return expired.length;
}

export function getQueueTombstoneCleanupIntervalMs(): number {
	return TOMBSTONE_CLEANUP_INTERVAL_MS;
}
