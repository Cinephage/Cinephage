import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// NOTE: Better Auth migrations removed (versions 56-57)
// Auth tables (user, session, account, verification) are now managed by Better Auth
// Do not add auth-related migrations here - Better Auth handles its own schema
// Version 61: Rename Live TV API Key to Media Streaming API Key
// Expands permissions to include both livetv and streaming endpoints

export const migration_v061: MigrationDefinition = {
	version: 61,
	name: 'rename_live_tv_to_media_streaming_api_key',
	apply: (sqlite) => {
		logger.info(
			'[SchemaSync] Running migration: Rename Live TV API Key to Media Streaming API Key'
		);

		// Update Better Auth API key table to migrate livetv keys to streaming keys
		// Better Auth stores keys in the 'apiKey' table
		try {
			// Check if apiKey table exists (Better Auth managed)
			const tableExists = sqlite
				.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='apiKey'`)
				.get();

			if (tableExists) {
				// Update keys with metadata.type = 'livetv' to type = 'streaming'
				const updateNameResult = sqlite
					.prepare(
						`UPDATE apiKey SET name = 'Media Streaming API Key' WHERE name = 'Live TV API Key'`
					)
					.run();

				// Update metadata - we need to parse and update the JSON
				const keysToUpdate = sqlite
					.prepare(
						`SELECT id, metadata, permissions FROM apiKey WHERE metadata LIKE '%"type":"livetv"%'`
					)
					.all() as Array<{ id: string; metadata: string; permissions: string }>;

				for (const key of keysToUpdate) {
					try {
						const metadata = JSON.parse(key.metadata);
						const permissions = JSON.parse(key.permissions);

						// Update metadata type and description
						metadata.type = 'streaming';
						metadata.description =
							'Access to Live TV and Media Streaming endpoints for media server integration';

						// Add streaming permission alongside livetv
						permissions.streaming = ['*'];

						// Update the key
						sqlite
							.prepare(`UPDATE apiKey SET metadata = ?, permissions = ? WHERE id = ?`)
							.run(JSON.stringify(metadata), JSON.stringify(permissions), key.id);

						logger.info(`[SchemaSync] Migrated API key ${key.id} to Media Streaming API Key`);
					} catch (parseError) {
						logger.warn(`[SchemaSync] Failed to parse metadata for key ${key.id}: ${parseError}`);
					}
				}

				logger.info(
					{
						updatedCount: updateNameResult.changes
					},
					'[SchemaSync] Migration completed: Live TV API Keys renamed to Media Streaming API Keys'
				);
			} else {
				logger.info('[SchemaSync] apiKey table not found, skipping migration');
			}
		} catch (error) {
			logger.error({ err: error }, '[SchemaSync] Migration failed');
			throw error;
		}
	}
};
