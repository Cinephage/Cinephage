import type { PageServerLoad } from './$types';
import { getIndexerManager } from '#lib/server/indexers/IndexerManager.js';
import { toUIDefinition } from '#lib/server/indexers/loader/index.js';
import { getPersistentStatusTracker } from '#lib/server/indexers/status/index.js';
import { CINEPHAGE_STREAM_DEFINITION_ID } from '#lib/server/indexers/types/index.js';
import {
	getSensitiveIndexerSettingsPresence,
	redactIndexerSettingsForForm
} from '#lib/server/indexers/settingsSecrets.js';
import type { IndexerDefinition, IndexerWithStatus } from '#lib/types/indexer.js';
import { getProwlarrConnection } from '#lib/server/indexers/prowlarr/ProwlarrConnectionService.js';
import { getJackettConnection } from '#lib/server/indexers/jackett/JackettConnectionService.js';

export const load: PageServerLoad = async () => {
	const manager = await getIndexerManager();
	const indexerConfigs = await manager.getIndexers();
	const statusTracker = getPersistentStatusTracker();

	const statusEntries = await Promise.all(
		indexerConfigs.map(
			async (config) => [config.id, await statusTracker.getStatus(config.id)] as const
		)
	);
	const statusByIndexerId = new Map(statusEntries);
	const definitionsById = new Map(
		manager.getUnifiedDefinitions().map((definition) => [definition.id, definition])
	);

	const getDisplayBaseUrl = (
		config: (typeof indexerConfigs)[number],
		settings: Record<string, string> | null
	): string => {
		if (config.definitionId !== CINEPHAGE_STREAM_DEFINITION_ID || !settings?.externalHost) {
			return config.baseUrl;
		}

		const host = settings.externalHost.trim().replace(/^https?:\/\//i, '');
		if (!host) return config.baseUrl;

		const useHttps =
			settings.useHttps === 'true' ||
			settings.useHttps === '1' ||
			settings.useHttps?.toLowerCase() === 'yes';
		const protocol = useHttps ? 'https' : 'http';

		return `${protocol}://${host}`.replace(/\/$/, '');
	};

	const indexers: IndexerWithStatus[] = indexerConfigs.map((config) => {
		const status = statusByIndexerId.get(config.id);
		const definition = definitionsById.get(config.definitionId);
		const settings = redactIndexerSettingsForForm(config.settings, definition?.settings);
		const sensitiveSettings = getSensitiveIndexerSettingsPresence(
			config.settings,
			definition?.settings
		);
		const displayBaseUrl = getDisplayBaseUrl(config, settings);

		return {
			id: config.id,
			name: config.name,
			definitionId: config.definitionId,
			enabled: config.enabled,
			upstreamEnabled: config.upstreamEnabled ?? null,
			orphaned: config.orphaned ?? false,
			isBuiltIn: config.isBuiltIn ?? false,
			baseUrl: displayBaseUrl,
			alternateUrls: config.alternateUrls,
			priority: config.priority,
			protocol: config.protocol,
			settings,
			sensitiveSettings,
			enableAutomaticSearch: config.enableAutomaticSearch,
			enableInteractiveSearch: config.enableInteractiveSearch,
			minimumSeeders: config.minimumSeeders,
			seedRatio: config.seedRatio,
			seedTime: config.seedTime,
			packSeedTime: config.packSeedTime,
			rejectDeadTorrents: config.rejectDeadTorrents,
			rejectPasswordProtected: config.rejectPasswordProtected,
			minimumCompletionPercentage: config.minimumCompletionPercentage,
			cachedCategories: config.cachedCategories,
			additionalCategories: config.additionalCategories,
			status: status
				? {
						healthy: status.health === 'healthy',
						enabled: status.isEnabled,
						consecutiveFailures: status.consecutiveFailures,
						lastFailure: status.lastFailure?.toISOString(),
						disabledUntil: status.disabledUntil?.toISOString(),
						disabledReason: status.disabledReason,
						lastFailureMessage: status.recentFailures[0]?.message,
						averageResponseTime: status.avgResponseTime
					}
				: undefined
		};
	});

	const definitions: IndexerDefinition[] = manager
		.getUnifiedDefinitions()
		.map(toUIDefinition)
		.sort((a, b) => a.name.localeCompare(b.name));

	const [prowlarrConn, jackettConn] = await Promise.all([
		getProwlarrConnection(),
		getJackettConnection()
	]);

	return {
		indexers,
		definitions,
		definitionErrors: manager.getDefinitionErrors(),
		prowlarrConnection: prowlarrConn
			? {
					url: prowlarrConn.url,
					autoSync: prowlarrConn.autoSync,
					syncIntervalHours: prowlarrConn.syncIntervalHours,
					syncAddNew: prowlarrConn.syncAddNew,
					useAggregateEndpoint: prowlarrConn.useAggregateEndpoint,
					lastSyncAt: prowlarrConn.lastSyncAt,
					lastSyncResult: prowlarrConn.lastSyncResult,
					lastSyncError: prowlarrConn.lastSyncError
				}
			: null,
		jackettConnection: jackettConn
			? {
					url: jackettConn.url,
					autoSync: jackettConn.autoSync,
					syncIntervalHours: jackettConn.syncIntervalHours,
					syncAddNew: jackettConn.syncAddNew,
					lastSyncAt: jackettConn.lastSyncAt,
					lastSyncResult: jackettConn.lastSyncResult,
					lastSyncError: jackettConn.lastSyncError
				}
			: null
	};
};
