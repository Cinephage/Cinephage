import { db } from '#lib/server/db/index.js';
import { blocklist } from '#lib/server/db/schema.js';
import { eq, or, and, gt, isNull, lte, inArray, count } from 'drizzle-orm';

export type BlocklistReason =
	| 'download_failed'
	| 'import_failed'
	| 'quality_mismatch'
	| 'manual'
	| 'duplicate'
	| 'bad_release'
	| 'blocked_extension';

export interface BlocklistCheckRelease {
	title: string;
	score?: number;
	size?: number;
	quality?: {
		resolution?: string;
		source?: string;
		codec?: string;
		hdr?: string;
	};
	indexerId?: string;
	infoHash?: string;
	downloadUrl?: string;
	magnetUrl?: string;
	protocol?: 'torrent' | 'usenet' | 'streaming' | string;
}

export interface BlocklistCheckOptions {
	movieId?: string;
	seriesId?: string;
}

export interface BlocklistCheckResult {
	blocked: boolean;
	reason?: string;
}

export interface BlocklistAddRelease {
	title: string;
	infoHash?: string;
	indexerId?: string;
	quality?: {
		resolution?: string;
		source?: string;
		codec?: string;
		hdr?: string;
	};
	size?: number;
	protocol?: string;
}

export interface BlocklistAddOptions {
	movieId?: string;
	seriesId?: string;
	episodeIds?: string[];
	reason: BlocklistReason;
	message?: string;
	expiresInHours?: number;
}

export interface BlocklistQueryOptions {
	movieId?: string;
	seriesId?: string;
	reason?: string;
	protocol?: string;
	activeOnly?: boolean;
	search?: string;
	limit?: number;
	offset?: number;
}

export interface BlocklistCountOptions {
	movieId?: string;
	seriesId?: string;
	reason?: string;
	protocol?: string;
	activeOnly?: boolean;
	search?: string;
}

class BlocklistService {
	private static instance: BlocklistService;

	static getInstance(): BlocklistService {
		if (!BlocklistService.instance) {
			BlocklistService.instance = new BlocklistService();
		}
		return BlocklistService.instance;
	}

	async isBlocklisted(
		release: BlocklistCheckRelease,
		options: BlocklistCheckOptions
	): Promise<BlocklistCheckResult> {
		const now = new Date().toISOString();

		const conditions = [];

		if (release.infoHash) {
			conditions.push(eq(blocklist.infoHash, release.infoHash));
		}

		if (release.title) {
			conditions.push(eq(blocklist.sourceTitle, release.title));
		}

		if (conditions.length === 0) {
			return { blocked: false };
		}

		const entries = await db.query.blocklist.findMany({
			where: and(
				or(...conditions),
				options.movieId ? eq(blocklist.movieId, options.movieId) : undefined,
				options.seriesId ? eq(blocklist.seriesId, options.seriesId) : undefined,
				or(isNull(blocklist.expiresAt), gt(blocklist.expiresAt, now)),
				release.indexerId
					? or(isNull(blocklist.indexerId), eq(blocklist.indexerId, release.indexerId))
					: undefined
			),
			limit: 1
		});

		if (entries.length > 0) {
			const entry = entries[0];
			return {
				blocked: true,
				reason: `Blocklisted: ${entry.reason}${entry.message ? ` - ${entry.message}` : ''}`
			};
		}

		return { blocked: false };
	}

	async getBlockedIdentifiers(
		movieId?: string,
		seriesId?: string
	): Promise<{ blockedHashes: Set<string>; blockedTitles: Set<string> }> {
		const now = new Date().toISOString();

		const entries = await db.query.blocklist.findMany({
			where: and(
				movieId ? eq(blocklist.movieId, movieId) : undefined,
				seriesId ? eq(blocklist.seriesId, seriesId) : undefined,
				or(isNull(blocklist.expiresAt), gt(blocklist.expiresAt, now))
			),
			columns: { infoHash: true, sourceTitle: true }
		});

		const blockedHashes = new Set(entries.map((e) => e.infoHash).filter(Boolean) as string[]);
		const blockedTitles = new Set(entries.map((e) => e.sourceTitle).filter(Boolean) as string[]);

		return { blockedHashes, blockedTitles };
	}

	addToBlocklist(release: BlocklistAddRelease, options: BlocklistAddOptions): string {
		const expiresAt = options.expiresInHours
			? new Date(Date.now() + options.expiresInHours * 60 * 60 * 1000).toISOString()
			: null;

		const dedupConditions = [eq(blocklist.title, release.title)];
		if (options.movieId) dedupConditions.push(eq(blocklist.movieId, options.movieId));
		if (options.seriesId) dedupConditions.push(eq(blocklist.seriesId, options.seriesId));
		if (release.infoHash) dedupConditions.push(eq(blocklist.infoHash, release.infoHash));
		else if (release.indexerId)
			dedupConditions.push(
				or(eq(blocklist.indexerId, release.indexerId), isNull(blocklist.indexerId))!
			);

		db.delete(blocklist)
			.where(and(...dedupConditions))
			.run();

		const [entry] = db
			.insert(blocklist)
			.values({
				title: release.title,
				infoHash: release.infoHash ?? null,
				indexerId: release.indexerId ?? null,
				movieId: options.movieId ?? null,
				seriesId: options.seriesId ?? null,
				episodeIds: options.episodeIds ?? null,
				reason: options.reason,
				message: options.message ?? null,
				sourceTitle: release.title,
				quality: release.quality ?? null,
				size: release.size ?? null,
				protocol: release.protocol ?? null,
				expiresAt
			})
			.returning()
			.all();

		return entry.id;
	}

	async removeFromBlocklist(id: string): Promise<void> {
		await db.delete(blocklist).where(eq(blocklist.id, id));
	}

	async clearMovieBlocklist(movieId: string): Promise<void> {
		await db.delete(blocklist).where(eq(blocklist.movieId, movieId));
	}

	async clearSeriesBlocklist(seriesId: string): Promise<void> {
		await db.delete(blocklist).where(eq(blocklist.seriesId, seriesId));
	}

	async getBlocklist(options?: BlocklistQueryOptions): Promise<(typeof blocklist.$inferSelect)[]> {
		const conditions = [];

		if (options?.movieId) conditions.push(eq(blocklist.movieId, options.movieId));
		if (options?.seriesId) conditions.push(eq(blocklist.seriesId, options.seriesId));
		if (options?.reason) conditions.push(eq(blocklist.reason, options.reason));
		if (options?.protocol) conditions.push(eq(blocklist.protocol, options.protocol));
		if (options?.activeOnly) {
			const now = new Date().toISOString();
			conditions.push(or(isNull(blocklist.expiresAt), gt(blocklist.expiresAt, now)));
		}

		return db.query.blocklist.findMany({
			where: conditions.length > 0 ? and(...conditions) : undefined,
			limit: options?.limit ?? 100,
			offset: options?.offset ?? 0,
			orderBy: (blocklist, { desc }) => [desc(blocklist.createdAt)]
		});
	}

	async cleanExpiredEntries(): Promise<number> {
		const now = new Date().toISOString();
		await db.delete(blocklist).where(lte(blocklist.expiresAt, now));

		return 0;
	}

	async getBlocklistCount(options?: BlocklistCountOptions): Promise<number> {
		const conditions = [];

		if (options?.movieId) conditions.push(eq(blocklist.movieId, options.movieId));
		if (options?.seriesId) conditions.push(eq(blocklist.seriesId, options.seriesId));
		if (options?.reason) conditions.push(eq(blocklist.reason, options.reason));
		if (options?.protocol) conditions.push(eq(blocklist.protocol, options.protocol));
		if (options?.activeOnly) {
			const now = new Date().toISOString();
			conditions.push(or(isNull(blocklist.expiresAt), gt(blocklist.expiresAt, now)));
		}

		const [result] = await db
			.select({ count: count() })
			.from(blocklist)
			.where(conditions.length > 0 ? and(...conditions) : undefined);

		return result.count;
	}

	async removeFromBlocklistByIds(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		for (let i = 0; i < ids.length; i += 500) {
			await db.delete(blocklist).where(inArray(blocklist.id, ids.slice(i, i + 500)));
		}
	}

	async updateExpiry(id: string, expiresInHours: number | null): Promise<void> {
		const expiresAt =
			expiresInHours !== null
				? new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString()
				: null;
		await db.update(blocklist).set({ expiresAt }).where(eq(blocklist.id, id));
	}
}

export const blocklistService = BlocklistService.getInstance();
