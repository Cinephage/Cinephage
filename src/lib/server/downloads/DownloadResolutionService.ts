/**
 * DownloadResolutionService
 *
 * Resolves release download URLs to actual torrent data or magnet links.
 * Following the Radarr/Prowlarr pattern, this service fetches torrent files
 * server-side through the indexer (with proper auth/cookies).
 *
 * CRITICAL: We always prefer torrent files over magnet links, especially for
 * private trackers like nCore. Torrent files contain the private tracker
 * announce URL which is required for the torrent to work. Magnet links built
 * from info hashes only contain public trackers, which breaks private trackers.
 */

import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import {
	parseTorrentFile,
	extractInfoHashFromMagnet,
	buildMagnetFromInfoHash
} from '#lib/server/downloadClients/utils/torrentParser.js';
import { createChildLogger } from '#lib/logging/index.js';
import { redactUrl } from '#lib/server/utils/urlSecurity.js';

const logger = createChildLogger({ module: 'DownloadResolutionService' });

/**
 * Input for resolving a download.
 */
export interface ResolveDownloadInput {
	/** Download URL (torrent file URL) */
	downloadUrl?: string | null;
	/** Magnet URL if already known */
	magnetUrl?: string | null;
	/** Info hash if already known */
	infoHash?: string | null;
	/** Indexer ID that provided the release */
	indexerId?: string | null;
	/** Release title (for building magnet links) */
	title: string;
	/** URL to the release details/comments page (needed by some indexers for download resolution) */
	commentsUrl?: string | null;
}

/**
 * Result of resolving a download.
 */
export interface ResolvedDownload {
	/** Whether resolution was successful */
	success: boolean;
	/** Magnet URL to use (only for public trackers without torrent file) */
	magnetUrl?: string;
	/** Torrent file data (preferred - contains private tracker announce URLs) */
	torrentFile?: Buffer;
	/** Info hash (always extracted if possible) */
	infoHash?: string;
	/** Error message if resolution failed */
	error?: string;
	/** Whether we fell back to original URL */
	usedFallback?: boolean;
}

/**
 * Service for resolving download URLs to actual download data.
 */
class DownloadResolutionService {
	/**
	 * Resolve a release to downloadable data (torrent file or magnet link).
	 *
	 * Resolution priority (torrent files are ALWAYS preferred):
	 * 1. Fetch torrent file through indexer (preferred - contains private tracker info)
	 * 2. Use existing magnet URL (for public trackers without direct torrent)
	 * 3. Build magnet from info hash (fallback for public trackers)
	 *
	 * CRITICAL: We never build magnet links from fetched torrent files, as this
	 * would lose private tracker announce URLs and break private trackers.
	 *
	 * @param input - Release download info
	 * @returns Resolved download with torrent file or magnet URL
	 */
	async resolve(input: ResolveDownloadInput): Promise<ResolvedDownload> {
		const { downloadUrl, magnetUrl, infoHash, indexerId, title, commentsUrl } = input;

		logger.debug(
			{
				title,
				hasMagnetUrl: !!magnetUrl,
				hasDownloadUrl: !!downloadUrl,
				hasInfoHash: !!infoHash,
				indexerId
			},
			'Resolving download'
		);

		// Strategy 0: Public trackers — the API-provided infohash/magnet is the canonical
		// download method. Their torrent-file endpoints are frequently bot-protected (e.g. YTS
		// behind Cloudflare) and offer no benefit over a magnet for a public swarm: there is no
		// private announce URL to preserve. Private/semi-private trackers skip this and fetch the
		// actual .torrent below so their announce URL is kept intact.
		if (indexerId && (magnetUrl || infoHash) && (await this.isPublicIndexer(indexerId))) {
			if (magnetUrl) {
				const extractedHash = (await extractInfoHashFromMagnet(magnetUrl)) || infoHash || undefined;
				logger.debug({ title, infoHash: extractedHash }, 'Public tracker: using magnet URL');
				return { success: true, magnetUrl, infoHash: extractedHash };
			}
			if (infoHash) {
				const builtMagnet = buildMagnetFromInfoHash(infoHash, title);
				logger.debug({ title, infoHash }, 'Public tracker: built magnet from infoHash');
				return { success: true, magnetUrl: builtMagnet, infoHash };
			}
		}

		// Strategy 1: Fetch torrent file through indexer (preferred)
		// This is the primary method - it gets the actual .torrent file which
		// contains the private tracker announce URL needed for private trackers
		if (downloadUrl && indexerId) {
			return this.fetchThroughIndexer(downloadUrl, indexerId, title, commentsUrl ?? undefined);
		}

		// Strategy 2: Use existing magnet URL
		// Only used when we don't have an indexer (e.g., public torrents)
		if (magnetUrl) {
			const extractedHash = (await extractInfoHashFromMagnet(magnetUrl)) || infoHash || undefined;
			logger.debug({ infoHash: extractedHash }, 'Using provided magnet URL');
			return {
				success: true,
				magnetUrl,
				infoHash: extractedHash
			};
		}

		// Strategy 3: Build magnet from info hash
		// Fallback for cases where we only have an info hash (rare)
		if (infoHash) {
			const builtMagnet = buildMagnetFromInfoHash(infoHash, title);
			logger.debug({ infoHash }, 'Built magnet from infoHash');
			return {
				success: true,
				magnetUrl: builtMagnet,
				infoHash
			};
		}

		// Strategy 4: Fallback - return the URL as-is and let download client handle it
		if (downloadUrl) {
			logger.warn(
				{
					title,
					downloadUrl: redactUrl(downloadUrl)
				},
				'No indexer available, using downloadUrl as fallback'
			);

			// Check if downloadUrl is already a magnet
			if (downloadUrl.startsWith('magnet:')) {
				const extractedHash = await extractInfoHashFromMagnet(downloadUrl);
				return {
					success: true,
					magnetUrl: downloadUrl,
					infoHash: extractedHash,
					usedFallback: true
				};
			}

			// Return as downloadUrl (download client will try to fetch it)
			return {
				success: true,
				magnetUrl: downloadUrl, // Not actually a magnet, but we pass it through
				usedFallback: true
			};
		}

		return {
			success: false,
			error: 'No download URL, magnet URL, or info hash provided'
		};
	}

	/**
	 * Determine whether an indexer is a public tracker. For public trackers the API-provided
	 * magnet/infohash is the canonical download method — there is no private announce URL to
	 * preserve, so we avoid their (often bot-protected) torrent-file endpoints.
	 */
	private async isPublicIndexer(indexerId: string): Promise<boolean> {
		try {
			const indexerManager = await getIndexerManager();
			const indexer = await indexerManager.getIndexerInstance(indexerId);
			return indexer?.accessType === 'public';
		} catch (error) {
			logger.debug({ err: error, indexerId }, 'Failed to resolve indexer access type');
			return false;
		}
	}

	/**
	 * Fetch a torrent file through the indexer with proper authentication.
	 */
	private async fetchThroughIndexer(
		downloadUrl: string,
		indexerId: string,
		title: string,
		commentsUrl?: string
	): Promise<ResolvedDownload> {
		const normalizedCommentsUrl = this.normalizeRuTrackerForumUrl(commentsUrl);
		const normalizedDownloadUrl = this.normalizeRuTrackerForumUrl(downloadUrl) ?? downloadUrl;
		const fallbackDetailsUrl =
			normalizedCommentsUrl ?? this.deriveDetailsUrl(normalizedDownloadUrl);

		logger.debug(
			{
				indexerId,
				url: redactUrl(normalizedDownloadUrl),
				detailsUrl: fallbackDetailsUrl ? redactUrl(fallbackDetailsUrl) : undefined
			},
			'Fetching torrent through indexer'
		);

		try {
			const indexerManager = await getIndexerManager();
			const indexer = await indexerManager.getIndexerInstance(indexerId);

			if (!indexer) {
				logger.warn({ indexerId }, 'Indexer not found, falling back to direct download');
				return this.fetchDirectly(normalizedDownloadUrl, title);
			}

			// Check if indexer supports downloadTorrent method
			if (!indexer.downloadTorrent) {
				logger.warn(
					{
						indexerId
					},
					'Indexer does not support downloadTorrent, falling back to direct download'
				);
				return this.fetchDirectly(normalizedDownloadUrl, title);
			}
			const downloadTorrent = indexer.downloadTorrent.bind(indexer);

			const mapIndexerResult = (result: {
				success: boolean;
				magnetUrl?: string;
				infoHash?: string;
				data?: Buffer;
				error?: string;
			}): ResolvedDownload => {
				// If we got a magnet URL back (redirect)
				if (result.magnetUrl) {
					logger.debug({ infoHash: result.infoHash }, 'Indexer returned magnet URL');
					return {
						success: true,
						magnetUrl: result.magnetUrl,
						infoHash: result.infoHash
					};
				}

				// If we got torrent file data - ALWAYS use it directly
				// NEVER build a magnet link from the torrent file, as this would lose
				// private tracker announce URLs and break private trackers like nCore.
				if (result.data) {
					logger.debug(
						{
							infoHash: result.infoHash,
							dataSize: result.data.length
						},
						'Returning torrent file'
					);
					return {
						success: true,
						torrentFile: result.data,
						infoHash: result.infoHash
					};
				}

				return {
					success: false,
					error: result.error || 'Indexer returned empty result'
				};
			};

			const tryIndexer = async (
				url: string,
				releaseDetailsUrl: string | undefined,
				label: 'primary' | 'details-first' | 'details-retry'
			): Promise<ResolvedDownload> => {
				const result = await downloadTorrent(url, {
					releaseDetailsUrl
				});
				if (result.success) {
					return mapIndexerResult(result);
				}
				logger.debug(
					{
						indexerId,
						label,
						url: redactUrl(url),
						error: result.error
					},
					'Indexer download attempt failed'
				);
				return {
					success: false,
					error: result.error || 'Indexer download failed'
				};
			};

			// RuTracker-style links are often transient on /dl.php endpoints; prefer details page first.
			const preferDetailsFirst =
				!!fallbackDetailsUrl &&
				fallbackDetailsUrl !== normalizedDownloadUrl &&
				/rutracker\./i.test(normalizedDownloadUrl);
			if (preferDetailsFirst) {
				const detailsFirstResult = await tryIndexer(
					fallbackDetailsUrl,
					fallbackDetailsUrl,
					'details-first'
				);
				if (detailsFirstResult.success) {
					return detailsFirstResult;
				}
			}

			const primaryResult = await tryIndexer(normalizedDownloadUrl, fallbackDetailsUrl, 'primary');
			if (primaryResult.success) {
				return primaryResult;
			}

			if (
				fallbackDetailsUrl &&
				fallbackDetailsUrl !== normalizedDownloadUrl &&
				!preferDetailsFirst
			) {
				logger.debug(
					{
						indexerId,
						downloadUrl: redactUrl(normalizedDownloadUrl),
						commentsUrl: redactUrl(fallbackDetailsUrl),
						error: primaryResult.error
					},
					'Primary indexer download failed, retrying from details URL'
				);
				const detailsRetryResult = await tryIndexer(
					fallbackDetailsUrl,
					fallbackDetailsUrl,
					'details-retry'
				);
				if (detailsRetryResult.success) {
					return detailsRetryResult;
				}
			}

			logger.warn(
				{
					indexerId,
					error: primaryResult.error
				},
				'Indexer download failed, trying direct fetch'
			);
			return this.fetchDirectly(normalizedDownloadUrl, title);
		} catch (error) {
			logger.error({ err: error, indexerId }, 'Failed to fetch through indexer');

			// Try direct fetch as fallback
			return this.fetchDirectly(normalizedDownloadUrl, title);
		}
	}

	/**
	 * Derive a stable release details URL from ephemeral download links.
	 * Currently used for RuTracker links like /forum/dl.php?t=<id>.
	 */
	private deriveDetailsUrl(downloadUrl: string): string | undefined {
		try {
			const parsed = new URL(downloadUrl);
			const host = parsed.hostname.toLowerCase();
			const topicId = parsed.searchParams.get('t');
			const isRuTracker = host.includes('rutracker.');
			const isDlEndpoint = /(?:\/forum)?\/dl\.php$/i.test(parsed.pathname);

			if (isRuTracker && isDlEndpoint && topicId) {
				const details = new URL(parsed.toString());
				details.pathname = '/forum/viewtopic.php';
				details.search = '';
				details.searchParams.set('t', topicId);
				return details.toString();
			}
		} catch {
			// Best-effort only.
		}

		return undefined;
	}

	private normalizeRuTrackerForumUrl(url: string | undefined): string | undefined {
		if (!url) {
			return undefined;
		}

		try {
			const parsed = new URL(url);
			if (!parsed.hostname.toLowerCase().includes('rutracker.')) {
				return url;
			}

			if (/^\/viewtopic\.php$/i.test(parsed.pathname)) {
				parsed.pathname = '/forum/viewtopic.php';
				return parsed.toString();
			}

			if (/^\/dl\.php$/i.test(parsed.pathname)) {
				parsed.pathname = '/forum/dl.php';
				return parsed.toString();
			}
		} catch {
			// Best-effort only.
		}

		return url;
	}

	/**
	 * Fetch a torrent file directly (without indexer authentication).
	 * Used as a fallback when indexer is unavailable.
	 */
	private async fetchDirectly(downloadUrl: string, _title: string): Promise<ResolvedDownload> {
		logger.debug({ url: redactUrl(downloadUrl) }, 'Fetching torrent directly');

		// Check if it's already a magnet
		if (downloadUrl.startsWith('magnet:')) {
			const infoHash = await extractInfoHashFromMagnet(downloadUrl);
			return {
				success: true,
				magnetUrl: downloadUrl,
				infoHash,
				usedFallback: true
			};
		}

		try {
			const maxRedirects = 5;
			let currentUrl = downloadUrl;

			for (let i = 0; i < maxRedirects; i++) {
				const response = await fetch(currentUrl, {
					method: 'GET',
					headers: {
						Accept: 'application/x-bittorrent, */*',
						'User-Agent': 'Cinephage/1.0'
					},
					redirect: 'manual'
				});

				// Handle redirects
				if (
					response.status === 301 ||
					response.status === 302 ||
					response.status === 303 ||
					response.status === 307 ||
					response.status === 308
				) {
					const location = response.headers.get('location');
					if (!location) {
						return { success: false, error: 'Redirect without location', usedFallback: true };
					}

					if (location.startsWith('magnet:')) {
						const infoHash = await extractInfoHashFromMagnet(location);
						return {
							success: true,
							magnetUrl: location,
							infoHash,
							usedFallback: true
						};
					}

					currentUrl = new URL(location, currentUrl).toString();
					continue;
				}

				if (!response.ok) {
					return {
						success: false,
						error: `HTTP ${response.status}: ${response.statusText}`,
						usedFallback: true
					};
				}

				const data = Buffer.from(await response.arrayBuffer());
				const parseResult = await parseTorrentFile(data);

				if (!parseResult.success) {
					return {
						success: false,
						error: parseResult.error || 'Failed to parse torrent',
						usedFallback: true
					};
				}

				// Always return the torrent file data directly
				// Never build a magnet link from the torrent file, as this would lose
				// private tracker announce URLs and break private trackers.
				return {
					success: true,
					torrentFile: data,
					infoHash: parseResult.infoHash,
					usedFallback: true
				};
			}

			return { success: false, error: 'Too many redirects', usedFallback: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error({ err: error }, 'Direct fetch failed');
			return { success: false, error: message, usedFallback: true };
		}
	}
}

// Singleton instance
let serviceInstance: DownloadResolutionService | null = null;

/**
 * Get the DownloadResolutionService singleton.
 */
export function getDownloadResolutionService(): DownloadResolutionService {
	if (!serviceInstance) {
		serviceInstance = new DownloadResolutionService();
	}
	return serviceInstance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetDownloadResolutionService(): void {
	serviceInstance = null;
}
