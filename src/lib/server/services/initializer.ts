import { building } from '$app/env';
import { createChildLogger, registerServerLogSinks } from '#lib/logging/index.js';
import { getLibraryScheduler } from '#lib/server/library/library-scheduler.js';
import { libraryJobWorker, LibraryJobWorker } from '#lib/server/library/jobs/LibraryJobWorker.js';
import { isFFprobeAvailable, getFFprobeVersion } from '#lib/server/library/ffprobe.js';
import { getDownloadMonitor } from '#lib/server/downloadClients/monitoring/index.js';
import { getImportService } from '#lib/server/downloadClients/import/ImportService.js';
import { getMonitoringScheduler } from '#lib/server/monitoring/MonitoringScheduler.js';
import { getExternalIdService } from '#lib/server/services/ExternalIdService.js';
import { getDataRepairService } from '#lib/server/services/DataRepairService.js';
import { qualityFilter } from '#lib/server/quality/index.js';
import { initializeDatabase } from '#lib/server/db/index.js';
import { getCaptchaSolver } from '#lib/server/captcha/index.js';
import { ensureCamoufoxBrowserInBackground } from '#lib/server/captcha/browser/browserProvisioning.js';
import { getServiceManager } from '#lib/server/services/service-manager.js';
import { getNntpManager } from '#lib/server/streaming/usenet/NntpManager.js';
import { getExtractionCacheManager } from '#lib/server/streaming/nzb/extraction/ExtractionCacheManager.js';
import { getMediaBrowserNotifier } from '#lib/server/notifications/mediabrowser/index.js';
import { getMediaServerStatsSyncService } from '#lib/server/mediaServerStats/MediaServerStatsSyncService.js';
import { getReconciliationService } from '#lib/server/storage/reconciliation/ReconciliationService.js';
import { getInsightsService } from '#lib/server/storage/insights/InsightsService.js';
import { getEpgScheduler } from '#lib/server/livetv/epg/index.js';
import { getLiveTvAccountManager } from '#lib/server/livetv/LiveTvAccountManager.js';
import { getProwlarrSyncScheduler } from '#lib/server/indexers/prowlarr/ProwlarrSyncScheduler.js';
import { getJackettSyncScheduler } from '#lib/server/indexers/jackett/JackettSyncScheduler.js';
import { getLiveTvChannelService } from '#lib/server/livetv/LiveTvChannelService.js';
import { getLiveTvStreamService } from '#lib/server/livetv/streaming/LiveTvStreamService.js';
import { getStalkerPortalManager } from '#lib/server/livetv/stalker/StalkerPortalManager.js';
import { initializeProviderFactory } from '#lib/server/subtitles/providers/SubtitleProviderFactory.js';
import { ensureStreamingApiKeyRateLimit } from '#lib/server/auth/index.js';
import { logCaptureStore } from '#lib/server/logging/log-capture-store.js';
import { logHistoryService } from '#lib/server/logging/log-history.js';
import { getCinephageApiService } from '#lib/server/cinephage/CinephageApiService.js';
import { getDebridPollService } from '#lib/server/downloadClients/debrid/DebridPollService.js';
import { getRequestAvailabilityProjector } from '#lib/server/requests/RequestAvailabilityProjector.js';

const logger = createChildLogger({ module: 'Initializer', logDomain: 'system' });

let initializationPromise: Promise<void> | null = null;
let initializationStarted = false;

async function initializeServices(): Promise<void> {
	if (building) {
		logger.info('Skipping service initialization during build');
		return;
	}

	if (initializationPromise) {
		return initializationPromise;
	}

	initializationPromise = (async () => {
		try {
			registerServerLogSinks({
				logCaptureStore,
				logHistoryService
			});

			await initializeDatabase();
			const updatedStreamingKeys = await ensureStreamingApiKeyRateLimit();
			if (updatedStreamingKeys > 0) {
				logger.info(
					{
						updatedKeys: updatedStreamingKeys
					},
					'Updated streaming API key rate limits'
				);
			}
			logger.info('Initializing background services...');

			const ffprobeAvailable = await isFFprobeAvailable();
			if (ffprobeAvailable) {
				const version = await getFFprobeVersion();
				logger.info(`ffprobe available: ${version}`);
			} else {
				logger.warn('ffprobe not found. Library refresh will be slower and less accurate.');
			}

			await qualityFilter.seedDefaultScoringProfiles();

			const profiles = await qualityFilter.getAllProfiles();
			logger.info(`Loaded ${profiles.length} quality profiles`);

			const serviceManager = getServiceManager();

			const libraryScheduler = getLibraryScheduler();
			serviceManager.register(libraryScheduler);

			serviceManager.register(libraryJobWorker);

			// Manual imports (single and bulk) can pile up into a long queue and
			// don't touch diskScanService, so a few dedicated workers can safely
			// run them alongside the primary worker without racing scan jobs.
			const IMPORT_WORKER_POOL_SIZE = 3;
			for (let i = 1; i <= IMPORT_WORKER_POOL_SIZE; i++) {
				serviceManager.register(
					new LibraryJobWorker({
						name: `LibraryJobWorker:import-${i}`,
						jobTypes: ['manual_import']
					})
				);
			}

			await getLibraryScheduler().initialize();
			logger.info('Library scheduler initialized');

			// Event-driven request fulfillment (media appearing flips active
			// requests to fulfilled). The hourly sweep task registers with the
			// monitoring scheduler separately.
			getRequestAvailabilityProjector().start();
			logger.info('Request availability projector started');

			await initializeProviderFactory();
			logger.info('Provider registry initialized with 13 providers');

			const downloadMonitor = getDownloadMonitor();
			serviceManager.register(downloadMonitor);

			getImportService().start();

			const monitoringScheduler = getMonitoringScheduler();
			serviceManager.register(monitoringScheduler);

			const externalIdService = getExternalIdService();
			serviceManager.register(externalIdService);

			const dataRepairService = getDataRepairService();
			serviceManager.register(dataRepairService);

			const captchaSolver = getCaptchaSolver();
			if (captchaSolver) {
				serviceManager.register(captchaSolver);
				logger.info('CaptchaSolver initialized for anti-bot bypass');
			}

			const nntpManager = getNntpManager();
			serviceManager.register(nntpManager);

			const extractionCacheManager = getExtractionCacheManager();
			serviceManager.register(extractionCacheManager);

			const mediaBrowserNotifier = getMediaBrowserNotifier();
			serviceManager.register(mediaBrowserNotifier);
			logger.info('MediaBrowser notifier initialized for Jellyfin/Emby/Plex integration');

			// Wire library events to media server notifications. The event kind
			// (import/upgrade/delete) lets each server's notification toggles filter
			// what it actually receives.
			const importSvc = getImportService();
			importSvc.on('file:imported', (event: { importedPath?: string; wasUpgrade?: boolean }) => {
				if (event.importedPath) {
					mediaBrowserNotifier.queueUpdate(
						event.importedPath,
						event.wasUpgrade ? 'Modified' : 'Created',
						event.wasUpgrade ? 'upgrade' : 'import'
					);
				}
			});
			importSvc.on('file:deleted', (event: { filePath?: string }) => {
				if (event.filePath) {
					mediaBrowserNotifier.queueUpdate(event.filePath, 'Deleted', 'delete');
				}
			});

			const mediaServerStatsSync = getMediaServerStatsSyncService();
			serviceManager.register(mediaServerStatsSync);

			const reconciliationService = getReconciliationService();
			serviceManager.register(reconciliationService);

			const insightsService = getInsightsService();
			serviceManager.register(insightsService);

			const liveTvAccountManager = getLiveTvAccountManager();
			serviceManager.register(liveTvAccountManager);

			const liveTvChannelService = getLiveTvChannelService();
			serviceManager.register(liveTvChannelService);

			const liveTvStreamService = getLiveTvStreamService();
			serviceManager.register(liveTvStreamService);

			const stalkerPortalManager = getStalkerPortalManager();
			serviceManager.register(stalkerPortalManager);

			const epgScheduler = getEpgScheduler();
			serviceManager.register(epgScheduler);

			const prowlarrSyncScheduler = getProwlarrSyncScheduler();
			serviceManager.register(prowlarrSyncScheduler);

			const jackettSyncScheduler = getJackettSyncScheduler();
			serviceManager.register(jackettSyncScheduler);

			// CinephageAPI subsystem — owns api.cinephage.net connection and
			// feature modules (library-streaming, remote-streaming). Phase 1
			// ships with zero modules registered — no behavior change yet.
			const cinephageApiService = getCinephageApiService();
			serviceManager.register(cinephageApiService);

			// WL-05E: Debrid polling and exactly-once import handoff. A narrowly
			// scoped background service that polls submitted debrid provider items,
			// projects status, and invokes map → materialize → finalize exactly
			// once, including after restart. Only touches protocol='debrid' rows;
			// generic torrent/usenet monitor debrid exclusion stays intact.
			const debridPollService = getDebridPollService();
			serviceManager.register(debridPollService);

			serviceManager.startAll();

			logger.info('All background services initialized and started');

			// Non-blocking: keep the browser build paired with the installed
			// Camoufox launcher provisioned for self-hosted deployments
			// (see browserProvisioning.ts).
			setImmediate(() => {
				void ensureCamoufoxBrowserInBackground();
			});
		} catch (error) {
			logger.error('Failed to initialize services', error);
			throw error;
		}
	})();

	return initializationPromise;
}

function ensureServicesInitialized(): void {
	if (building || initializationStarted) {
		return;
	}

	initializationStarted = true;
	initializeServices().catch((error) => {
		logger.error('Service initialization failed', error);
	});
}

export { initializeServices, ensureServicesInitialized };
