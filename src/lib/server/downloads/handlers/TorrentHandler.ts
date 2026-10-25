import parseTorrent from 'parse-torrent';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { extractLanguagesFromFileName } from '#lib/server/indexers/parser/patterns/language.js';
import type { QueueQualityInfo } from '#lib/types/queue.js';
import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';
import { getDownloadResolutionService } from '../DownloadResolutionService.js';
import {
	buildEpisodePointerFileSelection,
	parseEpisodePointerFromGuid,
	parseEpisodePointerFromTitle
} from '../episode-pointer.js';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { blocklistService } from '#lib/server/monitoring/specifications/BlocklistSpecification.js';
import { acquisitionService } from '#lib/server/acquisition/AcquisitionService.js';
import { createChildLogger } from '#lib/logging/index.js';
import type { GrabRequest, ResolvedContext, HandlerResult } from '../grab-types.js';
import type { DownloadInfo } from '#lib/server/downloadClients/core/interfaces.js';

const logger = createChildLogger({ module: 'TorrentHandler' });
const parser = new ReleaseParser();

export class TorrentHandler {
	async handle(request: GrabRequest, resolved: ResolvedContext): Promise<HandlerResult> {
		const { release, options } = request;
		const { movieId, seriesId, episodeIds, seasonNumber, mediaType } = resolved;

		const clientManager = getDownloadClientManager();
		const clientResult = await clientManager.getClientForProtocol('torrent');

		if (!clientResult) {
			logger.warn({ title: release.title }, 'No enabled torrent download client configured');
			return { success: false, error: 'No enabled torrent download client configured' };
		}

		const { client: clientConfig, instance: clientInstance } = clientResult;

		const category = mediaType === 'movie' ? clientConfig.movieCategory : clientConfig.tvCategory;
		const paused = clientConfig.initialState === 'pause';

		const parsed = parser.parse(release.title);
		const quality: QueueQualityInfo = {
			resolution: parsed.resolution ?? undefined,
			source: parsed.source ?? undefined,
			codec: parsed.codec ?? undefined,
			hdr: parsed.hdr ?? undefined,
			languages: parsed.languages.length > 0 ? parsed.languages : undefined
		};

		let indexerSeedRatio: number | undefined;
		let indexerSeedTime: number | undefined;

		if (release.indexerId) {
			const indexerManager = await getIndexerManager();
			const indexer = await indexerManager.getIndexer(release.indexerId);
			if (indexer) {
				indexerSeedRatio = indexer.seedRatio ? parseFloat(indexer.seedRatio) : undefined;
				indexerSeedTime = indexer.seedTime ?? undefined;
			}
		}

		const seedRatioLimit =
			indexerSeedRatio ??
			(clientConfig.seedRatioLimit ? parseFloat(clientConfig.seedRatioLimit) : undefined);
		const seedTimeLimit = indexerSeedTime ?? clientConfig.seedTimeLimit ?? undefined;

		const resolutionService = getDownloadResolutionService();
		const resolvedDownload = await resolutionService.resolve({
			downloadUrl: release.downloadUrl,
			magnetUrl: release.magnetUrl,
			infoHash: release.infoHash,
			indexerId: release.indexerId,
			title: release.title,
			commentsUrl: release.commentsUrl
		});

		if (!resolvedDownload.success) {
			logger.error(
				{ title: release.title, error: resolvedDownload.error },
				'Download resolution failed'
			);
			return { success: false, error: `Failed to resolve download: ${resolvedDownload.error}` };
		}

		const episodePointerTarget =
			parseEpisodePointerFromGuid(release.guid) ?? parseEpisodePointerFromTitle(release.title);
		let pointerFileSelection:
			| {
					fileIndices: number[];
					allFileIndices?: number[];
					filePaths?: string[];
			  }
			| undefined;

		if (episodePointerTarget) {
			const supportsFileSelection =
				clientInstance.implementation === 'qbittorrent' ||
				clientInstance.implementation === 'transmission';
			if (!supportsFileSelection) {
				return {
					success: false,
					error: `Download client "${clientInstance.implementation}" does not support episode pointer downloads`
				};
			}

			if (!resolvedDownload.torrentFile) {
				return {
					success: false,
					error:
						'Episode pointer download requires torrent metadata, but only a magnet/download URL was available'
				};
			}

			const selection = await buildEpisodePointerFileSelection(
				resolvedDownload.torrentFile,
				episodePointerTarget
			);
			if (selection.fileIndices.length === 0) {
				return {
					success: false,
					error: `Could not map ${episodePointerTarget.token} to files inside this season pack`
				};
			}

			pointerFileSelection = {
				fileIndices: selection.fileIndices,
				allFileIndices: selection.allFileIndices,
				filePaths: selection.filePaths
			};
		}

		if (resolvedDownload.torrentFile) {
			try {
				const parsedTorrent = await parseTorrent(Buffer.from(resolvedDownload.torrentFile));
				if (
					parsedTorrent &&
					'files' in parsedTorrent &&
					Array.isArray(parsedTorrent.files) &&
					parsedTorrent.files.length > 0
				) {
					const { resolveBlockedExtensionsForQueueItem } =
						await import('#lib/server/settings/blocked-extensions.js');
					const { DANGEROUS_EXTENSIONS, EXECUTABLE_EXTENSIONS } =
						await import('#lib/config/constants.js');
					const userBlocked = await resolveBlockedExtensionsForQueueItem({
						movieId: movieId ?? null,
						seriesId: seriesId ?? null
					});
					const blockedExtensions = [
						...userBlocked,
						...DANGEROUS_EXTENSIONS,
						...EXECUTABLE_EXTENSIONS
					];

					const parsedFiles = parsedTorrent.files as Array<{ path?: string; name?: string }>;

					// Tier-3 language evidence: tokens from the torrent's actual file
					// names (stronger than the release title; still not ffprobe proof).
					const fileLanguageSet = new Set<string>();
					for (const f of parsedFiles) {
						const name =
							String(f.path || f.name || '')
								.split(/[\\/]/)
								.pop() ?? '';
						for (const tag of extractLanguagesFromFileName(name).languages) {
							if (tag === 'multi' || tag === 'orig') continue;
							fileLanguageSet.add(tag);
						}
					}
					if (fileLanguageSet.size > 0) quality.fileLanguages = [...fileLanguageSet];

					const matchedFiles = parsedFiles.filter((f) => {
						const fileName = String(f.path || f.name || '');
						const dotIndex = fileName.lastIndexOf('.');
						if (dotIndex === -1) return false;
						const ext = fileName.slice(dotIndex).toLowerCase();
						return blockedExtensions.includes(ext);
					});

					if (matchedFiles.length > 0) {
						const fileList = matchedFiles
							.map((f) =>
								String(f.path || f.name || '')
									.split('/')
									.pop()
							)
							.join(', ');
						const errorMessage = `Blocked extension detected: ${fileList}`;

						logger.info(
							{
								title: release.title,
								matchedFiles: matchedFiles.map((f) => String(f.path || f.name || '')),
								blockedExtensions: userBlocked
							},
							'Rejecting release due to blocked extensions (pre-grab check)'
						);

						try {
							await blocklistService.addToBlocklist(
								{
									title: release.title,
									infoHash: resolvedDownload.infoHash ?? release.infoHash,
									indexerId: release.indexerId,
									quality,
									size: release.size,
									protocol: 'torrent'
								},
								{
									movieId: movieId ?? undefined,
									seriesId: seriesId ?? undefined,
									episodeIds: episodeIds ?? undefined,
									reason: 'blocked_extension',
									message: errorMessage
								}
							);
						} catch {
							// blocklist failure is non-critical
						}

						return { success: false, error: errorMessage };
					}
				}
			} catch (parseError) {
				logger.debug(
					{
						title: release.title,
						error: parseError instanceof Error ? parseError.message : String(parseError)
					},
					'Could not parse torrent for pre-grab extension check, continuing'
				);
			}
		}

		// Post-resolution identity recheck (acquisition redesign): the grab
		// pipeline ran before this hash was resolvable (.torrent URLs reveal
		// it only after metadata fetch). Now that it is known, re-verify
		// against active intents, the queue, and import history BEFORE
		// submitting to the download client. Magnet-carried hashes were
		// already checked by the pipeline and the intent's identity.
		if (options.intentId && resolvedDownload.infoHash) {
			const { recheckResolvedIdentity } = await import('../identity-recheck.js');
			const recheck = await recheckResolvedIdentity(options.intentId, resolvedDownload.infoHash);
			if (recheck.blocked) {
				acquisitionService.cancelIntent(options.intentId, recheck.reason);
				logger.info(
					{ title: release.title, infoHash: resolvedDownload.infoHash, reason: recheck.reason },
					'[TorrentHandler] Blocked duplicate after metadata resolution'
				);
				return { success: false, error: recheck.reason };
			}
		}

		let hash: string;
		let existingTorrent: DownloadInfo | null = null;

		try {
			hash = await clientInstance.addDownload({
				magnetUri: resolvedDownload.magnetUrl,
				torrentFile: resolvedDownload.torrentFile,
				infoHash: resolvedDownload.infoHash,
				category,
				paused,
				priority: clientConfig.recentPriority,
				seedRatioLimit,
				seedTimeLimit,
				fileSelection: pointerFileSelection
			});
		} catch (addError) {
			const isDuplicate = (addError as Error & { isDuplicate?: boolean }).isDuplicate;
			existingTorrent =
				(addError as Error & { existingTorrent?: DownloadInfo }).existingTorrent || null;

			if (isDuplicate && existingTorrent && episodePointerTarget) {
				return {
					success: false,
					error:
						'Episode pointer already exists in the client. Remove the existing torrent and retry to apply episode-only file selection.'
				};
			}

			if (isDuplicate && existingTorrent) {
				logger.info(
					{
						title: release.title,
						existingName: existingTorrent.name,
						existingStatus: existingTorrent.status,
						hash: existingTorrent.hash
					},
					'Handling duplicate torrent - linking to existing download'
				);
				hash = existingTorrent.hash;
			} else {
				throw addError;
			}
		}

		const infoHash = resolvedDownload.infoHash || hash;

		const queueItem = await downloadMonitor.addToQueue({
			downloadClientId: clientConfig.id,
			downloadId: hash || infoHash || resolvedDownload.magnetUrl || release.downloadUrl || '',
			infoHash: infoHash || undefined,
			title: release.title,
			indexerId: release.indexerId,
			indexerName: release.indexerName,
			downloadUrl: release.downloadUrl,
			magnetUrl: resolvedDownload.magnetUrl || release.magnetUrl,
			protocol: 'torrent',
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
				wasDuplicate: !!existingTorrent
			},
			'Torrent grab completed'
		);

		return {
			success: true,
			queueId: queueItem.id,
			hash: hash || infoHash,
			clientId: clientConfig.id,
			clientName: clientConfig.name,
			category,
			wasDuplicate: !!existingTorrent
		};
	}
}
