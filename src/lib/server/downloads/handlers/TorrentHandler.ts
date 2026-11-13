import parseTorrent from 'parse-torrent';
import { getDownloadClientManager } from '#lib/server/downloadClients/DownloadClientManager.js';
import { downloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { extractLanguagesFromFileName } from '#lib/server/indexers/parser/patterns/language.js';
import type { QueueQualityInfo } from '#lib/types/queue.js';
import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';
import { getDownloadResolutionService } from '../DownloadResolutionService.js';
import { parseEpisodePointerFromGuid, parseEpisodePointerFromTitle } from '../episode-pointer.js';
import type { EpisodePointerFileSelection } from '../episode-pointer.js';
import { resolveEpisodePackSelection } from '../episode-pack-selection.js';
import { resolveImportedScope } from '../imported-scope.js';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { declaredSeedLimits, maxSeedLimit } from '#lib/server/indexers/seedDefaults.js';
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
		let declaredSeedRatio: number | undefined;
		let declaredSeedTime: number | undefined;

		if (release.indexerId) {
			const indexerManager = await getIndexerManager();
			const indexer = await indexerManager.getIndexer(release.indexerId);
			if (indexer) {
				indexerSeedRatio = indexer.seedRatio ? parseFloat(indexer.seedRatio) : undefined;
				indexerSeedTime = indexer.seedTime ?? undefined;

				// A tracker's declared requirement is a floor, not a default. A user
				// value or an inherited client default below it risks a hit-and-run on
				// a private tracker, and nothing surfaced the requirement before.
				const definition = indexerManager.getDefinition(indexer.definitionId);
				if (definition) {
					const declared = declaredSeedLimits(definition);
					if (declared.ratio) declaredSeedRatio = Number(declared.ratio);
					if (declared.seedTimeMinutes) declaredSeedTime = declared.seedTimeMinutes;
				}
			}
		}

		// Three sources, highest wins: what the user configured for this indexer,
		// the client's global default, the definition's static declaration, and -
		// when the tracker varies it per release (freeleech, promos) - the value
		// parsed off this release.
		const seedRatioLimit = maxSeedLimit(
			indexerSeedRatio,
			clientConfig.seedRatioLimit ? parseFloat(clientConfig.seedRatioLimit) : undefined,
			declaredSeedRatio,
			release.minimumRatio
		);
		const seedTimeLimit = maxSeedLimit(
			indexerSeedTime,
			clientConfig.seedTimeLimit ?? undefined,
			declaredSeedTime,
			release.minimumSeedTime
		);

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
		let pointerFileSelection: EpisodePointerFileSelection | undefined;
		let pointerEpisodeIds: string[] | undefined;
		let pointerSize: number | undefined;

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

			if (resolvedDownload.torrentFile) {
				// A RuTracker/Kinozal season is a living topic: the pack is a
				// snapshot, and every wanted episode already inside it should come
				// down with the grab. Monitoring grabs fill the missing monitored
				// episodes of the season; interactive grabs stay single-episode.
				const packSelection = await resolveEpisodePackSelection({
					torrentFile: resolvedDownload.torrentFile,
					target: episodePointerTarget,
					seriesId,
					seasonNumber,
					targetEpisodeId: episodeIds?.[0],
					isAutomatic: options.isAutomatic ?? false
				});
				if (!packSelection.ok) {
					return { success: false, error: packSelection.error };
				}

				pointerFileSelection = packSelection.selection;
				pointerSize = packSelection.selection.selectedSize;
				if (packSelection.selection.episodeIds.length > 0) {
					pointerEpisodeIds = packSelection.selection.episodeIds;
				}
			} else {
				// No .torrent, so no file list to select against: the metadata that
				// carries it arrives separately over BEP 9 and may never arrive from
				// an idle swarm. Radarr and Sonarr never hit this because they do not
				// select files at grab time at all - they download the pack and let
				// the import step match filenames. Do the same rather than refusing a
				// grab the client can complete: add the magnet unselected and record
				// the whole requested episode scope so import knows what is coming.
				logger.warn(
					{ title: release.title, episodeIds, seasonNumber },
					'[TorrentHandler] No torrent metadata at grab time; downloading the full pack and letting import select'
				);
				if (episodeIds && episodeIds.length > 0) {
					pointerEpisodeIds = episodeIds;
				}
			}
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
				// Check the queue row before touching the client: selecting files on a
				// torrent whose row already imported starts a download nothing will
				// ever import. The merge below repeats the same predicate, so a row
				// that flips to imported in between still refuses.
				const extendSelection =
					typeof clientInstance.extendFileSelection === 'function'
						? clientInstance.extendFileSelection.bind(clientInstance)
						: undefined;
				const canExtend = extendSelection
					? await downloadMonitor.canExtendQueueItem(existingTorrent.hash)
					: false;

				if (extendSelection && canExtend) {
					try {
						// Only touch file priorities when there is a selection to apply.
						// A whole-pack fallback grab has none, and an empty index list
						// would read as "deselect everything"; the torrent is already
						// downloading in full, so extending the queue scope is enough.
						if (pointerFileSelection) {
							await extendSelection(existingTorrent.hash, {
								fileIndices: pointerFileSelection.fileIndices,
								filePaths: pointerFileSelection.filePaths
							});
						}
						const updatedQueueItem = await downloadMonitor.extendQueueItemEpisodes(
							existingTorrent.hash,
							pointerEpisodeIds ?? episodeIds ?? [],
							pointerSize
						);
						if (!updatedQueueItem) {
							logger.warn(
								{ title: release.title, hash: existingTorrent.hash },
								'Queue item changed state during extension; files were selected but not recorded'
							);
						} else {
							logger.info(
								{
									title: release.title,
									hash: existingTorrent.hash,
									queueItemId: updatedQueueItem.id,
									episodes: updatedQueueItem.episodeIds?.length ?? 0
								},
								'Extended episode pointer file selection on existing torrent'
							);

							return {
								success: true,
								queueId: updatedQueueItem.id,
								hash: existingTorrent.hash,
								clientId: clientConfig.id,
								clientName: clientConfig.name,
								category,
								wasDuplicate: true
							};
						}
					} catch (extendError) {
						logger.warn(
							{
								title: release.title,
								hash: existingTorrent.hash,
								err: extendError
							},
							'Failed to extend episode pointer file selection on existing torrent'
						);
					}
				}

				// The row that carried this hash may already be post-import: the pack
				// delivered some episodes and this grab wants ones it did not (#663).
				// Extending the client's selection is still the right move, but the old
				// row is finished and import refuses a row it has already completed, so
				// the new scope needs a live row of its own to be picked up.
				const retryEpisodeIds = pointerEpisodeIds ?? episodeIds ?? [];
				const importedScope = await resolveImportedScope({
					infoHash: existingTorrent.hash,
					movieId,
					seriesId,
					episodeIds: retryEpisodeIds
				});

				if (
					extendSelection &&
					pointerFileSelection &&
					retryEpisodeIds.length > 0 &&
					!importedScope.satisfied
				) {
					try {
						await extendSelection(existingTorrent.hash, {
							fileIndices: pointerFileSelection.fileIndices,
							filePaths: pointerFileSelection.filePaths
						});

						const created = await downloadMonitor.addToQueue({
							downloadClientId: clientConfig.id,
							downloadId: existingTorrent.hash,
							infoHash: existingTorrent.hash,
							title: release.title,
							indexerId: release.indexerId,
							indexerName: release.indexerName,
							downloadUrl: release.downloadUrl,
							magnetUrl: resolvedDownload.magnetUrl || release.magnetUrl,
							protocol: 'torrent',
							movieId,
							seriesId,
							episodeIds: retryEpisodeIds,
							seasonNumber,
							quality,
							size: pointerSize ?? release.size,
							releaseGroup: parsed.releaseGroup ?? undefined,
							isAutomatic: options.isAutomatic ?? false,
							isUpgrade: options.isUpgrade ?? false
						});

						// addToQueue returns a concurrent row instead of creating one; merging
						// the scope keeps both shapes correct with one call.
						const retryRow =
							(await downloadMonitor.extendQueueItemEpisodes(
								existingTorrent.hash,
								retryEpisodeIds,
								pointerSize
							)) ?? created;

						logger.info(
							{
								title: release.title,
								hash: existingTorrent.hash,
								queueItemId: retryRow.id,
								episodes: retryEpisodeIds.length,
								alreadyImported: importedScope.coveredEpisodeIds.length
							},
							'Reused an imported season pack for episodes it had not delivered yet'
						);

						return {
							success: true,
							queueId: retryRow.id,
							hash: existingTorrent.hash,
							clientId: clientConfig.id,
							clientName: clientConfig.name,
							category,
							wasDuplicate: true
						};
					} catch (retryError) {
						logger.warn(
							{
								title: release.title,
								hash: existingTorrent.hash,
								err: retryError
							},
							'Failed to re-grab an imported season pack for its missing episodes'
						);
					}
				}

				return {
					success: false,
					error:
						'Episode pointer already exists in the client and its file selection could not be extended. Remove the existing torrent and retry.'
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
			episodeIds: pointerEpisodeIds ?? episodeIds,
			seasonNumber,
			quality,
			size: pointerSize ?? release.size,
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
