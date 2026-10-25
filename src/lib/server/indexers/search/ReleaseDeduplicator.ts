import type { ReleaseResult, EnhancedReleaseResult } from '../types';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'indexers' as const });
import { extractInfoHash } from '#lib/server/downloadClients/utils/hashUtils.js';

/**
 * Result of deduplication operation.
 */
export interface DeduplicationResult {
	releases: ReleaseResult[];
	removed: number;
}

/**
 * Result of enhanced deduplication operation (post-enrichment).
 */
export interface EnhancedDeduplicationResult {
	releases: EnhancedReleaseResult[];
	removed: number;
}

/**
 * Pre-compiled regex patterns for title normalization.
 * Less aggressive than before to avoid false positive deduplication.
 */
const RELEASE_GROUP_PATTERN = /-\s*[a-z0-9]+$/i;
const BRACKET_PATTERN = /\[.*?\]/g;
const PAREN_PATTERN = /\(.*?\)/g;
const EXTRA_WHITESPACE_PATTERN = /\s+/g;

/**
 * Maximum size for title normalization cache.
 */
const MAX_NORMALIZE_CACHE_SIZE = 5000;

/**
 * Deduplicates releases using a single-pass approach with smart key generation.
 * Handles both basic and enhanced releases efficiently.
 */
export class ReleaseDeduplicator {
	/** Cache for normalized titles to avoid redundant operations */
	private normalizeCache: Map<string, string> = new Map();

	/**
	 * Deduplicates releases using infoHash, GUID, or normalized title as keys.
	 * Prefers releases with more seeders, then larger size, then newer date.
	 */
	deduplicate(releases: ReleaseResult[]): DeduplicationResult {
		const seen = new Map<string, ReleaseResult>();

		for (const release of releases) {
			const key = this.getDedupeKey(release);
			const existing = seen.get(key);

			if (!existing) {
				// First time seeing this release - initialize sourceIndexers
				const releaseWithSources = {
					...release,
					sourceIndexers: [release.indexerName]
				};
				seen.set(key, releaseWithSources);
			} else {
				// Duplicate found - track this indexer as another source
				const currentSources = existing.sourceIndexers ?? [existing.indexerName];
				if (!currentSources.includes(release.indexerName)) {
					currentSources.push(release.indexerName);
				}

				if (this.shouldPrefer(release, existing)) {
					// Prefer the new release but keep all source indexers
					const releaseWithSources = {
						...release,
						sourceIndexers: currentSources
					};
					seen.set(key, releaseWithSources);
				} else {
					// Keep existing but update its sourceIndexers
					existing.sourceIndexers = currentSources;
				}
			}
		}

		const result = Array.from(seen.values());

		// Log multi-source releases for debugging
		const multiSourceReleases = result.filter(
			(r) => r.sourceIndexers && r.sourceIndexers.length > 1
		);
		if (multiSourceReleases.length > 0) {
			logger.debug(
				{
					count: multiSourceReleases.length,
					samples: multiSourceReleases.slice(0, 5).map((r) => ({
						title: r.title,
						sources: r.sourceIndexers
					}))
				},
				'[Deduplicator] Releases from multiple indexers'
			);
		}

		return {
			releases: result,
			removed: releases.length - seen.size
		};
	}

	/**
	 * Deduplicates enhanced releases using quality-aware preference logic.
	 * Called AFTER enrichment when we have rejection counts and scores.
	 *
	 * Preference order:
	 * 1. Fewer rejections wins (non-rejected preferred over rejected)
	 * 2. Higher indexer priority wins (lower priority number = higher preference)
	 * 3. Higher quality score wins
	 * 4. Fallback to legacy logic (seeders > size > age)
	 */
	deduplicateEnhanced(releases: EnhancedReleaseResult[]): EnhancedDeduplicationResult {
		const seen = new Map<string, EnhancedReleaseResult>();

		for (const release of releases) {
			const key = this.getDedupeKey(release);
			const existing = seen.get(key);

			if (!existing) {
				// First time seeing this release - initialize sourceIndexers
				const releaseWithSources = {
					...release,
					sourceIndexers: [release.indexerName]
				};
				seen.set(key, releaseWithSources);
			} else {
				// Duplicate found - track this indexer as another source
				const currentSources = existing.sourceIndexers ?? [existing.indexerName];
				if (!currentSources.includes(release.indexerName)) {
					currentSources.push(release.indexerName);
				}

				if (this.shouldPreferEnhanced(release, existing)) {
					// Prefer the new release but keep all source indexers
					const releaseWithSources = {
						...release,
						sourceIndexers: currentSources
					};
					seen.set(key, releaseWithSources);
				} else {
					// Keep existing but update its sourceIndexers
					existing.sourceIndexers = currentSources;
				}
			}
		}

		const result = Array.from(seen.values());

		// Log deduplication stats
		const removed = releases.length - seen.size;
		if (removed > 0) {
			logger.debug(
				{
					input: releases.length,
					output: result.length,
					removed,
					multiSourceCount: result.filter((r) => r.sourceIndexers && r.sourceIndexers.length > 1)
						.length
				},
				'[Deduplicator] Enhanced deduplication completed'
			);
		}

		return {
			releases: result,
			removed
		};
	}

	/**
	 * Gets the deduplication key for a release.
	 * Priority: infoHash > magnet URL hash > streaming guid > normalized title
	 *
	 * The key is designed to:
	 * - Match identical torrents across different indexers (via infoHash)
	 * - Match the same content from streaming sources (via GUID)
	 * - Match similar releases with minor title variations (via normalized title)
	 */
	private getDedupeKey(release: ReleaseResult): string {
		// Use infoHash if available (most reliable for torrents)
		if (release.infoHash) {
			return `hash:${release.infoHash.toLowerCase()}`;
		}

		// Try to extract infoHash from magnet URL if available
		if (release.magnetUrl) {
			const hashFromMagnet = extractInfoHash(release.magnetUrl);
			if (hashFromMagnet) {
				return `hash:${hashFromMagnet.toLowerCase()}`;
			}
		}

		// For streaming, use guid to create a separate dedup namespace
		// Streaming GUIDs are already unique per content (e.g., stream-movie-{tmdbId})
		// This prevents streaming releases from colliding with torrent/usenet releases
		if (release.protocol === 'streaming') {
			return `streaming:${release.guid}`;
		}

		// For usenet, use GUID since NZBs don't have infoHashes
		if (release.protocol === 'usenet') {
			return `usenet:${release.guid}`;
		}

		// Fallback to normalized title for torrents without infoHash or magnet
		// This is less reliable but better than nothing.
		// Include the release year: otherwise "Movie (1994)" and "Movie (2019)"
		// normalize identically (parenthetical years are stripped) and distinct
		// films/editions get merged — the survivor may not be the wanted one.
		const yearMatch =
			release.title.match(/\((19|20)\d{2}\)/) ?? release.title.match(/\b(?:19|20)\d{2}\b/);
		const yearSuffix = yearMatch ? `:${yearMatch[0].replace(/[()]/g, '')}` : '';
		return `title:${this.normalizeTitle(release.title)}${yearSuffix}`;
	}

	/**
	 * Normalizes a title for comparison.
	 * Removes release group tags and extra whitespace but keeps quality/source indicators.
	 * This is less aggressive than before to avoid false positive deduplication.
	 *
	 * Examples:
	 * - "Movie.Name.2024.1080p.BluRay.x264-Group" -> "movie name 2024 1080p bluray x264"
	 * - "Movie.Name.2024.1080p.BluRay.x264-OtherGroup" -> "movie name 2024 1080p bluray x264" (same!)
	 */
	private normalizeTitle(title: string): string {
		// Check memoization cache first
		const cached = this.normalizeCache.get(title);
		if (cached !== undefined) {
			return cached;
		}

		const normalized = title
			.toLowerCase()
			// Remove release group at the end (e.g., "-Group", "-RARBG")
			.replace(RELEASE_GROUP_PATTERN, '')
			// Remove bracketed content (e.g., "[Freeleech]", "[HDR]")
			.replace(BRACKET_PATTERN, '')
			// Remove parenthetical content (e.g., "(2024)", "(4K)")
			.replace(PAREN_PATTERN, '')
			// Replace special characters with spaces (keep more than before)
			.replace(/[._-]/g, ' ')
			// Collapse multiple whitespace
			.replace(EXTRA_WHITESPACE_PATTERN, ' ')
			.trim();

		// LRU-style eviction: remove oldest entry if at capacity
		if (this.normalizeCache.size >= MAX_NORMALIZE_CACHE_SIZE) {
			const firstKey = this.normalizeCache.keys().next().value;
			if (firstKey !== undefined) {
				this.normalizeCache.delete(firstKey);
			}
		}

		// Cache the result
		this.normalizeCache.set(title, normalized);
		return normalized;
	}

	/**
	 * Clears the normalization cache.
	 * Useful for testing or when memory pressure is high.
	 */
	clearCache(): void {
		this.normalizeCache.clear();
	}

	/**
	 * Determines if the candidate release should be preferred over the existing one.
	 * Prefers: more seeders > larger size > newer date
	 */
	private shouldPrefer(candidate: ReleaseResult, existing: ReleaseResult): boolean {
		const candidateSeeders = candidate.seeders ?? 0;
		const existingSeeders = existing.seeders ?? 0;

		// Prefer release with more seeders
		if (candidateSeeders !== existingSeeders) {
			return candidateSeeders > existingSeeders;
		}

		// If same seeders, prefer larger file (likely better quality)
		if (candidate.size !== existing.size) {
			return candidate.size > existing.size;
		}

		// If still tied, prefer newer release
		return candidate.publishDate > existing.publishDate;
	}

	/**
	 * Determines if the candidate enhanced release should be preferred over the existing one.
	 * Preference order:
	 * 1. Fewer rejections wins (non-rejected preferred over rejected)
	 * 2. Higher indexer priority wins (lower number = higher preference)
	 * 3. Higher quality score wins
	 * 4. Fallback to legacy logic (seeders > size > age)
	 */
	private shouldPreferEnhanced(
		candidate: EnhancedReleaseResult,
		existing: EnhancedReleaseResult
	): boolean {
		const candidateRejections = candidate.rejectionCount ?? (candidate.rejected ? 1 : 0);
		const existingRejections = existing.rejectionCount ?? (existing.rejected ? 1 : 0);

		// 1. Prefer release with fewer rejections (non-rejected wins)
		if (candidateRejections !== existingRejections) {
			return candidateRejections < existingRejections;
		}

		// 2. Prefer higher priority indexer (lower number = higher priority)
		const candidatePriority = candidate.indexerPriority ?? 25;
		const existingPriority = existing.indexerPriority ?? 25;
		if (candidatePriority !== existingPriority) {
			return candidatePriority < existingPriority;
		}

		// 3. Prefer higher quality score
		const candidateScore = candidate.totalScore ?? 0;
		const existingScore = existing.totalScore ?? 0;
		if (candidateScore !== existingScore) {
			return candidateScore > existingScore;
		}

		// 4. Fallback to legacy logic: seeders > size > age
		const candidateSeeders = candidate.seeders ?? 0;
		const existingSeeders = existing.seeders ?? 0;
		if (candidateSeeders !== existingSeeders) {
			return candidateSeeders > existingSeeders;
		}

		if (candidate.size !== existing.size) {
			return candidate.size > existing.size;
		}

		return candidate.publishDate > existing.publishDate;
	}
}
