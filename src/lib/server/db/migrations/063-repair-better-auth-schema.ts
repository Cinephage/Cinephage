import type { MigrationDefinition } from '../migration-helpers.js';
import {
	columnExists,
	tableExists,
	renameColumnIfExists,
	ensureColumn,
	getTableRowCount,
	createBetterAuthTables,
	createBetterAuthIndexes,
	recreateBetterAuthSchema
} from '../migration-helpers.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'system' as const });
// Version 63: Repair Better Auth schema drift and add missing plugin tables

export const migration_v063: MigrationDefinition = {
	version: 63,
	name: 'repair_better_auth_schema',
	apply: (sqlite) => {
		const authTables = ['user', 'session', 'account', 'verification', 'apikey', 'rateLimit'];
		const authHasData = authTables.some((tableName) => getTableRowCount(sqlite, tableName) > 0);

		const userColumns = [
			'email',
			'emailVerified',
			'image',
			'username',
			'displayUsername',
			'role',
			'banned',
			'banReason',
			'banExpires',
			'createdAt',
			'updatedAt'
		];
		const userNeedsRepair =
			tableExists(sqlite, 'user') &&
			userColumns.some((columnName) => !columnExists(sqlite, 'user', columnName));

		const sessionColumns = [
			'userId',
			'token',
			'expiresAt',
			'ipAddress',
			'userAgent',
			'createdAt',
			'updatedAt'
		];
		const sessionNeedsRepair =
			tableExists(sqlite, 'session') &&
			(sessionColumns.some((columnName) => !columnExists(sqlite, 'session', columnName)) ||
				!columnExists(sqlite, 'session', 'impersonatedBy'));
		const accountColumns = ['userId', 'accountId', 'providerId', 'createdAt', 'updatedAt'];
		const accountNeedsRepair =
			tableExists(sqlite, 'account') &&
			accountColumns.some((columnName) => !columnExists(sqlite, 'account', columnName));
		const apikeyMissing = !tableExists(sqlite, 'apikey');
		const apikeyNeedsRepair =
			tableExists(sqlite, 'apikey') &&
			!columnExists(sqlite, 'apikey', 'key') &&
			!columnExists(sqlite, 'apikey', 'referenceId') &&
			!columnExists(sqlite, 'apikey', 'userId');
		const rateLimitMissing = !tableExists(sqlite, 'rateLimit');

		if (
			!authHasData &&
			(userNeedsRepair ||
				sessionNeedsRepair ||
				accountNeedsRepair ||
				apikeyMissing ||
				apikeyNeedsRepair ||
				rateLimitMissing)
		) {
			logger.info(
				'[SchemaSync] Recreating empty Better Auth schema with complete table definitions'
			);
			recreateBetterAuthSchema(sqlite);
			return;
		}

		createBetterAuthTables(sqlite);

		renameColumnIfExists(sqlite, 'session', 'user_id', 'userId');
		renameColumnIfExists(sqlite, 'session', 'expires_at', 'expiresAt');
		renameColumnIfExists(sqlite, 'session', 'ip_address', 'ipAddress');
		renameColumnIfExists(sqlite, 'session', 'user_agent', 'userAgent');
		renameColumnIfExists(sqlite, 'session', 'created_at', 'createdAt');
		renameColumnIfExists(sqlite, 'session', 'updated_at', 'updatedAt');
		renameColumnIfExists(sqlite, 'account', 'user_id', 'userId');
		renameColumnIfExists(sqlite, 'account', 'account_id', 'accountId');
		renameColumnIfExists(sqlite, 'account', 'provider_id', 'providerId');
		renameColumnIfExists(sqlite, 'account', 'access_token', 'accessToken');
		renameColumnIfExists(sqlite, 'account', 'refresh_token', 'refreshToken');
		renameColumnIfExists(sqlite, 'account', 'created_at', 'createdAt');
		renameColumnIfExists(sqlite, 'account', 'updated_at', 'updatedAt');
		renameColumnIfExists(sqlite, 'apikey', 'user_id', 'userId');

		ensureColumn(sqlite, 'user', 'name', '"name" text');
		ensureColumn(sqlite, 'user', 'email', '"email" text');
		ensureColumn(sqlite, 'user', 'emailVerified', '"emailVerified" integer DEFAULT 0');
		ensureColumn(sqlite, 'user', 'image', '"image" text');
		ensureColumn(sqlite, 'user', 'username', '"username" text');
		ensureColumn(sqlite, 'user', 'displayUsername', '"displayUsername" text');
		ensureColumn(sqlite, 'user', 'role', '"role" text DEFAULT \'admin\' NOT NULL');
		ensureColumn(sqlite, 'user', 'banned', '"banned" integer DEFAULT 0');
		ensureColumn(sqlite, 'user', 'banReason', '"banReason" text');
		ensureColumn(sqlite, 'user', 'banExpires', '"banExpires" date');
		ensureColumn(sqlite, 'user', 'createdAt', '"createdAt" date');
		ensureColumn(sqlite, 'user', 'updatedAt', '"updatedAt" date');

		ensureColumn(sqlite, 'session', 'userId', '"userId" text');
		ensureColumn(sqlite, 'session', 'token', '"token" text');
		ensureColumn(sqlite, 'session', 'expiresAt', '"expiresAt" date');
		ensureColumn(sqlite, 'session', 'ipAddress', '"ipAddress" text');
		ensureColumn(sqlite, 'session', 'userAgent', '"userAgent" text');
		ensureColumn(sqlite, 'session', 'createdAt', '"createdAt" date');
		ensureColumn(sqlite, 'session', 'updatedAt', '"updatedAt" date');
		ensureColumn(sqlite, 'session', 'impersonatedBy', '"impersonatedBy" text');

		ensureColumn(sqlite, 'account', 'userId', '"userId" text');
		ensureColumn(sqlite, 'account', 'accountId', '"accountId" text');
		ensureColumn(sqlite, 'account', 'providerId', '"providerId" text');
		ensureColumn(sqlite, 'account', 'accessToken', '"accessToken" text');
		ensureColumn(sqlite, 'account', 'refreshToken', '"refreshToken" text');
		ensureColumn(sqlite, 'account', 'createdAt', '"createdAt" date');
		ensureColumn(sqlite, 'account', 'updatedAt', '"updatedAt" date');

		ensureColumn(sqlite, 'apikey', 'name', '"name" text');
		ensureColumn(sqlite, 'apikey', 'start', '"start" text');
		ensureColumn(sqlite, 'apikey', 'prefix', '"prefix" text');
		ensureColumn(sqlite, 'apikey', 'key', '"key" text');
		// apikey v1.5+ shape: never re-introduce the legacy userId column on a
		// table already in the new shape — a table with BOTH columns breaks
		// migration 065's rename. Legacy v1.4 tables keep userId here and 065
		// performs the data-preserving rename.
		if (
			columnExists(sqlite, 'apikey', 'userId') &&
			!columnExists(sqlite, 'apikey', 'referenceId')
		) {
			ensureColumn(sqlite, 'apikey', 'userId', '"userId" text');
		} else {
			ensureColumn(sqlite, 'apikey', 'referenceId', '"referenceId" text');
			ensureColumn(sqlite, 'apikey', 'configId', `"configId" text DEFAULT 'default'`);
		}
		ensureColumn(sqlite, 'apikey', 'refillInterval', '"refillInterval" integer');
		ensureColumn(sqlite, 'apikey', 'refillAmount', '"refillAmount" integer');
		ensureColumn(sqlite, 'apikey', 'lastRefillAt', '"lastRefillAt" date');
		ensureColumn(sqlite, 'apikey', 'enabled', '"enabled" integer DEFAULT 1');
		ensureColumn(sqlite, 'apikey', 'rateLimitEnabled', '"rateLimitEnabled" integer DEFAULT 1');
		ensureColumn(sqlite, 'apikey', 'rateLimitTimeWindow', '"rateLimitTimeWindow" integer');
		ensureColumn(sqlite, 'apikey', 'rateLimitMax', '"rateLimitMax" integer');
		ensureColumn(sqlite, 'apikey', 'requestCount', '"requestCount" integer DEFAULT 0');
		ensureColumn(sqlite, 'apikey', 'remaining', '"remaining" integer');
		ensureColumn(sqlite, 'apikey', 'lastRequest', '"lastRequest" date');
		ensureColumn(sqlite, 'apikey', 'expiresAt', '"expiresAt" date');
		ensureColumn(sqlite, 'apikey', 'createdAt', '"createdAt" date');
		ensureColumn(sqlite, 'apikey', 'updatedAt', '"updatedAt" date');
		ensureColumn(sqlite, 'apikey', 'permissions', '"permissions" text');
		ensureColumn(sqlite, 'apikey', 'metadata', '"metadata" text');

		ensureColumn(sqlite, 'rateLimit', 'id', '"id" text');
		ensureColumn(sqlite, 'rateLimit', 'key', '"key" text');
		ensureColumn(sqlite, 'rateLimit', 'count', '"count" integer NOT NULL DEFAULT 0');
		ensureColumn(sqlite, 'rateLimit', 'lastRequest', '"lastRequest" integer NOT NULL DEFAULT 0');

		if (tableExists(sqlite, 'user')) {
			sqlite
				.prepare(`UPDATE "user" SET "role" = 'admin' WHERE "role" IS NULL OR "role" = ''`)
				.run();
			sqlite.prepare(`UPDATE "user" SET "emailVerified" = 0 WHERE "emailVerified" IS NULL`).run();
			sqlite.prepare(`UPDATE "user" SET "banned" = 0 WHERE "banned" IS NULL`).run();
		}

		if (tableExists(sqlite, 'apikey')) {
			sqlite.prepare(`UPDATE "apikey" SET "enabled" = 1 WHERE "enabled" IS NULL`).run();
			sqlite
				.prepare(`UPDATE "apikey" SET "rateLimitEnabled" = 1 WHERE "rateLimitEnabled" IS NULL`)
				.run();
			sqlite.prepare(`UPDATE "apikey" SET "requestCount" = 0 WHERE "requestCount" IS NULL`).run();
		}

		if (tableExists(sqlite, 'rateLimit')) {
			sqlite
				.prepare(
					`UPDATE "rateLimit" SET "id" = lower(hex(randomblob(16))) WHERE "id" IS NULL OR "id" = ''`
				)
				.run();
			sqlite
				.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_rateLimit_key" ON "rateLimit" ("key")`)
				.run();
			sqlite
				.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_rateLimit_id" ON "rateLimit" ("id")`)
				.run();
		}

		createBetterAuthIndexes(sqlite);
		logger.info('[SchemaSync] Better Auth schema repair complete');
	}
};
