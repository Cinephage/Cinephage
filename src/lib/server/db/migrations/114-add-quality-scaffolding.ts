import type { MigrationDefinition } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });

export const migration_v114: MigrationDefinition = {
	version: 114,
	name: 'add_quality_scaffolding',
	apply: (sqlite) => {
		try {
			sqlite
				.prepare(`ALTER TABLE "scoring_profiles" ADD COLUMN "is_builtin" integer DEFAULT 0`)
				.run();
			sqlite.prepare(`ALTER TABLE "scoring_profiles" ADD COLUMN "media_type" text`).run();

			// Seed built-in default profiles if no built-in profiles exist
			const builtinCount = sqlite
				.prepare(`SELECT COUNT(*) as c FROM "scoring_profiles" WHERE "is_builtin" = 1`)
				.get() as { c: number } | undefined;
			if (!builtinCount?.c) {
				const now = new Date().toISOString();
				sqlite
					.prepare(
						`INSERT INTO "scoring_profiles" ("id", "name", "description", "is_builtin", "media_type", "is_default", "min_score", "upgrade_until_score", "upgrades_allowed", "allowed_protocols", "resolution_order", "created_at", "updated_at")
						 VALUES (?, ?, ?, 1, ?, 1, 0, -1, 1, ?, ?, ?, ?)`
					)
					.run(
						'profile-default-movie',
						'Default Movie',
						'Built-in default scoring profile for movies',
						'movie',
						JSON.stringify(['torrent', 'usenet']),
						JSON.stringify(['2160p', '1080p', '720p', '480p']),
						now,
						now
					);
				sqlite
					.prepare(
						`INSERT INTO "scoring_profiles" ("id", "name", "description", "is_builtin", "media_type", "is_default", "min_score", "upgrade_until_score", "upgrades_allowed", "allowed_protocols", "resolution_order", "created_at", "updated_at")
						 VALUES (?, ?, ?, 1, ?, 1, 0, -1, 1, ?, ?, ?, ?)`
					)
					.run(
						'profile-default-tv',
						'Default TV',
						'Built-in default scoring profile for TV shows',
						'tv',
						JSON.stringify(['torrent', 'usenet']),
						JSON.stringify(['2160p', '1080p', '720p', '480p']),
						now,
						now
					);
				logger.info('[migration v114] Seeded built-in default profiles');
			}

			sqlite
				.prepare(
					`ALTER TABLE "libraries" ADD COLUMN "quality_profile_id" text REFERENCES "scoring_profiles"("id") ON DELETE SET NULL`
				)
				.run();

			logger.info('[migration v114] Quality scaffolding columns added');
		} catch (e) {
			logger.info(
				{ err: e instanceof Error ? e.message : String(e) },
				'[migration v114] Columns may already exist, skipping'
			);
		}
	}
};
