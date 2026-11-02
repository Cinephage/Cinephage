import type { MigrationDefinition } from '../migration-helpers.js';
import { ensureSoleUserIsAdmin } from '#lib/server/auth/admin-bootstrap.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 64: Promote the sole bootstrap user to admin if older auth code created it as user

export const migration_v064: MigrationDefinition = {
	version: 64,
	name: 'ensure_bootstrap_user_is_admin',
	apply: (sqlite) => {
		if (ensureSoleUserIsAdmin(sqlite)) {
			logger.info('[SchemaSync] Ensured the sole bootstrap user has admin role');
		}
	}
};
