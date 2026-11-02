import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { getNzbValidationService } from '../nzb/index.js';
import { checkNzbAvailability } from '../nzb/NzbAvailabilityChecker.js';
import { blocklistService } from '#lib/server/monitoring/specifications/BlocklistSpecification.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { GrabRequest, ResolvedContext, HandlerResult } from '../grab-types.js';

const logger = createChildLogger({ module: 'UsenetHandler' });
const parser = new ReleaseParser();

export class UsenetHandler {
	async handle(request: GrabRequest, resolved: ResolvedContext): Promise<HandlerResult> {
		const { release, options } = request;
		const { movieId, seriesId, episodeIds, seasonNumber, mediaType } = resolved;

		const clientManager = getDownloadClientManager();
		const usenetClient = await clientManager.getClientForProtocol('usenet');

		if (!usenetClient) {
			return { success: false, error: 'No enabled usenet download client configured' };
		}

		const { client: clientConfig, instance: clientInstance } = usenetClient;

		const category = mediaType === 'movie' ? clientConfig.movieCategory : clientConfig.tvCategory;
		const paused = clientConfig.initialState === 'pause';

		const parsed = parser.parse(release.title);
		const quality = {
			resolution: parsed.resolution ?? undefined,
			source: parsed.source ?? undefined,
			codec: parsed.codec ?? undefined,
			hdr: parsed.hdr ?? undefined,
			languages: parsed.languages.length > 0 ? parsed.languages : undefined
		};

		let nzbContent: Buffer | undefined;

		if (release.downloadUrl) {
			const indexerManager = await getIndexerManager();
			const indexer = release.indexerId
				? await indexerManager.getIndexerInstance(release.indexerId)
				: null;

			if (indexer && indexer.downloadTorrent) {
				try {
					const downloadResult = await indexer.downloadTorrent(release.downloadUrl, {
						releaseDetailsUrl: release.commentsUrl
					});
					if (downloadResult.success && downloadResult.data) {
						nzbContent = downloadResult.data;

						const nzbValidator = getNzbValidationService();
						const validation = nzbValidator.validate(nzbContent);
						if (!validation.valid) {
							return { success: false, error: `Invalid NZB: ${validation.error}` };
						}

						const availability = await checkNzbAvailability(nzbContent);
						if (availability.skipped) {
							logger.warn(
								{
									title: release.title,
									reason: availability.reason
								},
								'NZB availability check skipped - NNTP unavailable'
							);
						} else if (!availability.available) {
							logger.warn(
								{
									title: release.title,
									completionPercentage: availability.completionPercentage,
									checkedSegments: availability.checkedSegments,
									missingSegments: availability.missingSegments
								},
								'NZB availability check failed'
							);

							try {
								await blocklistService.addToBlocklist(
									{
										title: release.title,
										indexerId: release.indexerId,
										size: release.size,
										protocol: 'usenet'
									},
									{
										movieId,
										seriesId,
										episodeIds,
										reason: 'download_failed',
										message: `Unavailable on usenet: ${availability.completionPercentage}% articles found`,
										expiresInHours: 72
									}
								);
								logger.info(
									{
										title: release.title,
										indexer: release.indexerName,
										expiresInHours: 72
									},
									'Auto-blocklisted unavailable release'
								);
							} catch (blocklistError) {
								logger.warn(
									{
										title: release.title,
										err: blocklistError
									},
									'Failed to add to blocklist'
								);
							}

							return {
								success: false,
								error: `Release unavailable on usenet: ${availability.completionPercentage}% of articles found. Release may be incomplete or DMCA'd.`
							};
						}
					} else {
						logger.error(
							{
								title: release.title,
								indexerId: release.indexerId,
								error: downloadResult.error
							},
							'Indexer returned failure when fetching NZB'
						);
						return {
							success: false,
							error: `Failed to fetch NZB: ${downloadResult.error}`
						};
					}
				} catch (fetchError) {
					const message = fetchError instanceof Error ? fetchError.message : 'Unknown error';
					return { success: false, error: `Error fetching NZB: ${message}` };
				}
			} else {
				logger.debug('Using direct NZB URL (no indexer instance)');
			}
		}

		let nzoId: string;
		try {
			nzoId = await clientInstance.addDownload({
				nzbFile: nzbContent,
				downloadUrl: nzbContent ? undefined : release.downloadUrl,
				title: release.title,
				category,
				paused,
				priority: clientConfig.recentPriority
			});
		} catch (addError) {
			const message = addError instanceof Error ? addError.message : 'Unknown error';
			return { success: false, error: `Failed to add to ${clientConfig.name}: ${message}` };
		}

		const queueItem = await downloadMonitor.addToQueue({
			downloadClientId: clientConfig.id,
			downloadId: nzoId,
			title: release.title,
			indexerId: release.indexerId,
			indexerName: release.indexerName,
			downloadUrl: release.downloadUrl,
			protocol: 'usenet',
			movieId,
			seriesId,
			episodeIds,
			seasonNumber,
			quality,
			size: release.size,
			releaseGroup: parsed.releaseGroup ?? undefined,
			isAutomatic: options.isAutomatic ?? false,
			isUpgrade: options.isUpgrade ?? false
		});

		logger.info(
			{
				title: release.title,
				queueItemId: queueItem.id,
				nzoId,
				client: clientConfig.name
			},
			'Usenet grab completed'
		);

		return {
			success: true,
			queueId: queueItem.id,
			hash: nzoId,
			clientId: clientConfig.id,
			clientName: clientConfig.name,
			category
		};
	}
}
