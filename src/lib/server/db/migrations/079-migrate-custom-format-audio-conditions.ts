import type { MigrationDefinition } from '../migration-helpers.js';
import { columnExists, tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 79: Convert saved custom format audio conditions to canonical fields

export const migration_v079: MigrationDefinition = {
	version: 79,
	name: 'migrate_custom_format_audio_conditions',
	apply: (sqlite) => {
		if (
			!tableExists(sqlite, 'custom_formats') ||
			!columnExists(sqlite, 'custom_formats', 'conditions')
		) {
			logger.info(
				'[SchemaSync] custom_formats table not found, skipping audio condition migration'
			);
			return;
		}

		const rows = sqlite
			.prepare(`SELECT "id", "conditions" FROM "custom_formats" WHERE "conditions" IS NOT NULL`)
			.all() as Array<{ id: string; conditions: string | null }>;

		const updateConditions = sqlite.prepare(
			`UPDATE "custom_formats" SET "conditions" = ?, "updated_at" = ? WHERE "id" = ?`
		);

		let migratedCount = 0;
		const now = new Date().toISOString();

		for (const row of rows) {
			if (!row.conditions) continue;

			let parsedConditions: unknown;
			try {
				parsedConditions = JSON.parse(row.conditions);
			} catch (error) {
				logger.warn(
					{
						formatId: row.id,
						error: error instanceof Error ? error.message : String(error)
					},
					'[SchemaSync] Skipping custom format with invalid conditions JSON'
				);
				continue;
			}

			if (!Array.isArray(parsedConditions)) {
				continue;
			}

			let changed = false;
			const migratedConditions = parsedConditions.map((condition) => {
				if (
					typeof condition !== 'object' ||
					condition === null ||
					!('type' in condition) ||
					(condition as { type?: unknown }).type !== 'audio'
				) {
					return condition;
				}

				const legacy = condition as Record<string, unknown>;
				const { audio, ...rest } = legacy;

				if (audio === 'atmos') {
					changed = true;
					return {
						...rest,
						type: 'audio_atmos'
					};
				}

				if (typeof audio === 'string' && audio.length > 0) {
					changed = true;
					return {
						...rest,
						type: 'audio_codec',
						audioCodec: audio
					};
				}

				return condition;
			});

			if (!changed) {
				continue;
			}

			updateConditions.run(JSON.stringify(migratedConditions), now, row.id);
			migratedCount += 1;
		}

		logger.info(
			{ migratedCount },
			'[SchemaSync] Migrated custom format audio conditions to canonical schema'
		);
	}
};
