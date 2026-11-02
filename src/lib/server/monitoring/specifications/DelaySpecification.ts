/**
 * DelaySpecification
 *
 * Manages release delay logic similar to Radarr/Sonarr's delay profiles.
 * Allows waiting for better releases before automatically grabbing.
 *
 * Features:
 * - Protocol-based delays (torrent vs usenet)
 * - Quality-based delays (wait longer for lower qualities)
 * - Bypass conditions (immediate grab for high scores or best quality)
 * - Pending release tracking and superseding
 */

import { db } from '#lib/server/db/index.js';
import { delayProfiles, pendingReleases, movies, series } from '#lib/server/db/schema.js';
import { eq, and, lte, desc } from 'drizzle-orm';
import { createChildLogger } from '#lib/logging/index.js';
import type { ReleaseCandidate } from './types.js';

const logger = createChildLogger({ module: 'DelaySpecification', logDomain: 'monitoring' });

/**
 * Result of delay calculation
 */
export interface DelayResult {
	shouldDelay: boolean;
	delayMinutes: number;
	processAt?: Date;
	reason?: string;
	bypassReason?: string;
}

/**
 * Pending release for later processing
 */
export interface PendingReleaseInfo {
	id: string;
	title: string;
	score: number;
	processAt: Date;
	status: string;
}

/**
 * DelayProfileService
 *
 * Singleton service for managing delay profiles and pending releases
 */
class DelayProfileService {
	private static instance: DelayProfileService;

	static getInstance(): DelayProfileService {
		if (!DelayProfileService.instance) {
			DelayProfileService.instance = new DelayProfileService();
		}
		return DelayProfileService.instance;
	}

	/**
	 * Calculate delay for a release based on delay profiles.
	 * Uses publishDate to determine remaining delay (Sonarr-style: delay is from when
	 * the release was published, not from when we first saw it).
	 */
	async calculateDelay(
		release: ReleaseCandidate & { protocol: string; publishDate?: Date },
		options: {
			movieId?: string;
			seriesId?: string;
		}
	): Promise<DelayResult> {
		const profile = await this.getApplicableProfile(options);

		if (!profile || !profile.enabled) {
			return { shouldDelay: false, delayMinutes: 0, reason: 'No delay profile' };
		}

		// Bypass: preferred protocol grabs immediately
		if (profile.preferredProtocol && release.protocol === profile.preferredProtocol) {
			return {
				shouldDelay: false,
				delayMinutes: 0,
				bypassReason: `Preferred protocol: ${profile.preferredProtocol}`
			};
		}

		// Bypass: 4K grabs immediately if configured
		if (profile.bypassIfHighestQuality && release.quality?.resolution === '2160p') {
			return {
				shouldDelay: false,
				delayMinutes: 0,
				bypassReason: 'Highest quality (4K) - immediate grab'
			};
		}

		// Bypass: score above threshold grabs immediately
		if (profile.bypassIfAboveScore && release.score >= profile.bypassIfAboveScore) {
			return {
				shouldDelay: false,
				delayMinutes: 0,
				bypassReason: `Score ${release.score} >= bypass threshold ${profile.bypassIfAboveScore}`
			};
		}

		// Determine total delay from protocol and optional quality-specific override
		let delayMinutes = release.protocol === 'usenet' ? profile.usenetDelay : profile.torrentDelay;

		if (profile.qualityDelays && release.quality?.resolution) {
			const qualityDelay = profile.qualityDelays[release.quality.resolution];
			if (qualityDelay !== undefined) {
				delayMinutes = Math.max(delayMinutes, qualityDelay);
			}
		}

		if (delayMinutes <= 0) {
			return { shouldDelay: false, delayMinutes: 0, reason: 'Zero delay configured' };
		}

		// Calculate remaining delay from the release publish date (Sonarr-style).
		// If no publishDate is available, delay from now.
		const referenceTime = release.publishDate ?? new Date();
		const elapsedMs = Date.now() - referenceTime.getTime();
		const totalDelayMs = delayMinutes * 60 * 1000;
		const remainingMs = totalDelayMs - elapsedMs;

		if (remainingMs <= 0) {
			return {
				shouldDelay: false,
				delayMinutes: 0,
				reason: 'Delay already elapsed since publish date'
			};
		}

		const processAt = new Date(Date.now() + remainingMs);
		const remainingMinutes = Math.ceil(remainingMs / 60_000);
		return {
			shouldDelay: true,
			delayMinutes: remainingMinutes,
			processAt,
			reason: `Delay profile "${profile.name}": waiting ${remainingMinutes} more minutes`
		};
	}

	/**
	 * Get the applicable delay profile for content.
	 * Looks up the delay profile assigned directly to the movie or series,
	 * falling back to the first enabled profile if none is assigned.
	 */
	private async getApplicableProfile(options: {
		movieId?: string;
		seriesId?: string;
	}): Promise<typeof delayProfiles.$inferSelect | null> {
		// Try media-specific assignment first
		let delayProfileId: string | null | undefined;

		if (options.movieId) {
			const movie = await db.query.movies.findFirst({
				where: eq(movies.id, options.movieId),
				columns: { delayProfileId: true }
			});
			delayProfileId = movie?.delayProfileId;
		} else if (options.seriesId) {
			const show = await db.query.series.findFirst({
				where: eq(series.id, options.seriesId),
				columns: { delayProfileId: true }
			});
			delayProfileId = show?.delayProfileId;
		}

		if (delayProfileId) {
			const profile = await db.query.delayProfiles.findFirst({
				where: and(eq(delayProfiles.id, delayProfileId), eq(delayProfiles.enabled, true))
			});
			if (profile) return profile;
		}

		// No media-specific profile — use the first enabled profile (global default)
		const profiles = await db.query.delayProfiles.findMany({
			where: eq(delayProfiles.enabled, true),
			orderBy: [delayProfiles.sortOrder],
			limit: 1
		});
		return profiles[0] ?? null;
	}

	/**
	 * Add a release to pending (delay queue)
	 */
	async addToPending(
		release: ReleaseCandidate & {
			protocol: string;
			downloadUrl?: string;
			magnetUrl?: string;
			indexerId?: string;
			publishDate?: Date;
		},
		options: {
			movieId?: string;
			seriesId?: string;
			episodeIds?: string[];
			processAt: Date;
			delayProfileId?: string;
		}
	): Promise<string> {
		// Check if there's an existing pending release for this content
		const existing = await this.getPendingForContent(options);

		// If new release is better, supersede the old one
		if (existing && release.score > existing.score) {
			await this.supersedePending(existing.id, release.title);
		}

		const [entry] = await db
			.insert(pendingReleases)
			.values({
				title: release.title,
				infoHash: release.infoHash ?? null,
				indexerId: release.indexerId ?? null,
				downloadUrl: release.downloadUrl ?? null,
				magnetUrl: release.magnetUrl ?? null,
				movieId: options.movieId ?? null,
				seriesId: options.seriesId ?? null,
				episodeIds: options.episodeIds ?? null,
				score: release.score,
				size: release.size ?? null,
				protocol: release.protocol,
				quality: release.quality ?? null,
				delayProfileId: options.delayProfileId ?? null,
				publishDate: release.publishDate?.toISOString() ?? null,
				processAt: options.processAt.toISOString(),
				status: 'pending'
			})
			.returning();

		logger.info(
			{
				id: entry.id,
				title: release.title,
				processAt: options.processAt.toISOString()
			},
			'[DelayService] Added release to pending queue'
		);

		return entry.id;
	}

	/**
	 * Get pending release for content
	 */
	private async getPendingForContent(options: {
		movieId?: string;
		seriesId?: string;
	}): Promise<typeof pendingReleases.$inferSelect | null> {
		const query = options.movieId
			? and(eq(pendingReleases.movieId, options.movieId), eq(pendingReleases.status, 'pending'))
			: options.seriesId
				? and(eq(pendingReleases.seriesId, options.seriesId), eq(pendingReleases.status, 'pending'))
				: undefined;

		if (!query) return null;

		const results = await db.query.pendingReleases.findMany({
			where: query,
			orderBy: [desc(pendingReleases.score)],
			limit: 1
		});

		return results[0] ?? null;
	}

	/**
	 * Mark a pending release as superseded by a better one
	 */
	private async supersedePending(id: string, supersededBy: string): Promise<void> {
		await db
			.update(pendingReleases)
			.set({
				status: 'superseded',
				supersededBy
			})
			.where(eq(pendingReleases.id, id));
	}

	/**
	 * Get releases ready to be processed (delay expired)
	 */
	async getReadyReleases(): Promise<(typeof pendingReleases.$inferSelect)[]> {
		const now = new Date().toISOString();

		return db.query.pendingReleases.findMany({
			where: and(eq(pendingReleases.status, 'pending'), lte(pendingReleases.processAt, now)),
			orderBy: [desc(pendingReleases.score)]
		});
	}

	/**
	 * Mark a pending release as grabbed
	 */
	async markAsGrabbed(id: string): Promise<void> {
		await db.update(pendingReleases).set({ status: 'grabbed' }).where(eq(pendingReleases.id, id));
	}

	/**
	 * Mark a pending release as expired
	 */
	async markAsExpired(id: string): Promise<void> {
		await db.update(pendingReleases).set({ status: 'expired' }).where(eq(pendingReleases.id, id));
	}

	/**
	 * Clean up old pending releases
	 */
	async cleanupOldReleases(maxAgeHours: number = 72): Promise<number> {
		const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

		// Mark old pending as expired
		await db
			.update(pendingReleases)
			.set({ status: 'expired' })
			.where(and(eq(pendingReleases.status, 'pending'), lte(pendingReleases.addedAt, cutoff)));

		// Delete very old entries (superseded, grabbed, expired older than maxAge)
		await db.delete(pendingReleases).where(lte(pendingReleases.addedAt, cutoff));

		return 0; // SQLite doesn't return affected count easily
	}

	/**
	 * Get all delay profiles
	 */
	async getProfiles(): Promise<(typeof delayProfiles.$inferSelect)[]> {
		return db.query.delayProfiles.findMany({
			orderBy: [delayProfiles.sortOrder]
		});
	}

	/**
	 * Create a delay profile
	 */
	async createProfile(profile: {
		name: string;
		usenetDelay?: number;
		torrentDelay?: number;
		qualityDelays?: Record<string, number>;
		preferredProtocol?: string;
		bypassIfHighestQuality?: boolean;
		bypassIfAboveScore?: number;
	}): Promise<string> {
		// Get max sort order
		const existing = await db.query.delayProfiles.findMany({
			orderBy: [desc(delayProfiles.sortOrder)],
			limit: 1
		});

		const sortOrder = (existing[0]?.sortOrder ?? 0) + 1;

		const [entry] = await db
			.insert(delayProfiles)
			.values({
				name: profile.name,
				sortOrder,
				usenetDelay: profile.usenetDelay ?? 0,
				torrentDelay: profile.torrentDelay ?? 0,
				qualityDelays: profile.qualityDelays ?? null,
				preferredProtocol: profile.preferredProtocol ?? null,
				bypassIfHighestQuality: profile.bypassIfHighestQuality ?? true,
				bypassIfAboveScore: profile.bypassIfAboveScore ?? null
			})
			.returning();

		return entry.id;
	}

	/**
	 * Update a delay profile
	 */
	async updateProfile(
		id: string,
		updates: Partial<{
			name: string;
			enabled: boolean;
			usenetDelay: number;
			torrentDelay: number;
			qualityDelays: Record<string, number>;
			preferredProtocol: string | null;
			bypassIfHighestQuality: boolean;
			bypassIfAboveScore: number | null;
		}>
	): Promise<void> {
		await db
			.update(delayProfiles)
			.set({
				...updates,
				updatedAt: new Date().toISOString()
			})
			.where(eq(delayProfiles.id, id));
	}

	/**
	 * Delete a delay profile
	 */
	async deleteProfile(id: string): Promise<void> {
		// Don't allow deleting the default profile
		if (id === 'default') {
			throw new Error('Cannot delete default delay profile');
		}

		await db.delete(delayProfiles).where(eq(delayProfiles.id, id));
	}

	/**
	 * Get pending releases for UI display
	 */
	async getPendingReleases(options?: {
		movieId?: string;
		seriesId?: string;
		limit?: number;
	}): Promise<PendingReleaseInfo[]> {
		const conditions = [eq(pendingReleases.status, 'pending')];

		if (options?.movieId) {
			conditions.push(eq(pendingReleases.movieId, options.movieId));
		}
		if (options?.seriesId) {
			conditions.push(eq(pendingReleases.seriesId, options.seriesId));
		}

		const results = await db.query.pendingReleases.findMany({
			where: and(...conditions),
			orderBy: [pendingReleases.processAt],
			limit: options?.limit ?? 50
		});

		return results.map((r) => ({
			id: r.id,
			title: r.title,
			score: r.score,
			processAt: new Date(r.processAt),
			status: r.status
		}));
	}
}

/**
 * Export singleton instance
 */
export const delayProfileService = DelayProfileService.getInstance();
