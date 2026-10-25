import type { MigrationDefinition } from '../migration-helpers.js';
import { tableExists } from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
export const migration_v074: MigrationDefinition = {
	version: 74,
	name: 'consolidate_nzb_mount_clients_into_sab_mount_mode',
	apply: (sqlite) => {
		if (!tableExists(sqlite, 'download_clients')) {
			return;
		}

		const updateLegacyClients = sqlite.prepare(`
			UPDATE "download_clients"
			SET
				"implementation" = 'sabnzbd',
				"mount_mode" = CASE
					WHEN "mount_mode" IS NULL OR TRIM("mount_mode") = '' THEN 'nzbdav'
					WHEN "mount_mode" = 'altmount' THEN 'nzbdav'
					ELSE "mount_mode"
				END
			WHERE "implementation" = 'nzb-mount'
		`);

		const normalizeAltmount = sqlite.prepare(`
			UPDATE "download_clients"
			SET "mount_mode" = 'nzbdav'
			WHERE "mount_mode" = 'altmount'
		`);

		const convertedClients = updateLegacyClients.run().changes;
		const normalizedMountModes = normalizeAltmount.run().changes;

		logger.info(
			{
				convertedClients,
				normalizedMountModes
			},
			'[SchemaSync] Consolidated legacy nzb-mount clients into sabnzbd mount mode'
		);
	}
};
