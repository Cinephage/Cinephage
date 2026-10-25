import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { syncSchema } from './schema-sync';
import { createBetterAuthTables, convergeApikeySchemaToV15 } from './migration-helpers';
import { migration_v065 } from './migrations/065-migrate-apikey-schema-v1-5';

const databases: Database.Database[] = [];

function createTestDatabase(): Database.Database {
	const sqlite = new Database(':memory:');
	databases.push(sqlite);
	return sqlite;
}

function getColumnNames(sqlite: Database.Database, tableName: string): string[] {
	return (
		sqlite.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
			name: string;
		}>
	).map((column) => column.name);
}

function tableExists(sqlite: Database.Database, tableName: string): boolean {
	return !!sqlite
		.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
		.get(tableName);
}

afterEach(() => {
	for (const sqlite of databases.splice(0)) {
		sqlite.close();
	}
});

describe('syncSchema Better Auth repair', () => {
	it('creates durable library job tables and indexes', () => {
		const sqlite = createTestDatabase();

		syncSchema(sqlite);

		const tables = sqlite
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('library_jobs', 'library_job_items')"
			)
			.all() as Array<{ name: string }>;
		expect(tables.map((row) => row.name).sort()).toEqual(['library_job_items', 'library_jobs']);

		const indexes = sqlite
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_library_job%'"
			)
			.all() as Array<{ name: string }>;
		expect(indexes.map((row) => row.name)).toEqual(
			expect.arrayContaining([
				'idx_library_jobs_status_created',
				'idx_library_jobs_type_status',
				'idx_library_jobs_root_status',
				'idx_library_jobs_active_dedupe',
				'idx_library_job_items_job_status',
				'idx_library_job_items_path'
			])
		);
	});

	it('dedupes legacy seasons and episodes before adding v090 unique indexes', async () => {
		const sqlite = createTestDatabase();
		const { migration_v090 } = await import('./migrations/090-add-library-jobs.js');

		sqlite
			.prepare(
				`CREATE TABLE "settings" (
					"key" text PRIMARY KEY NOT NULL,
					"value" text NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "root_folders" (
					"id" text PRIMARY KEY NOT NULL,
					"path" text NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "movies" (
					"id" text PRIMARY KEY NOT NULL,
					"root_folder_id" text
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "series" (
					"id" text PRIMARY KEY NOT NULL,
					"root_folder_id" text
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "movie_files" (
					"id" text PRIMARY KEY NOT NULL,
					"movie_id" text NOT NULL,
					"relative_path" text NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "episode_files" (
					"id" text PRIMARY KEY NOT NULL,
					"series_id" text NOT NULL,
					"season_number" integer NOT NULL,
					"episode_ids" text,
					"relative_path" text NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "monitoring_history" (
					"id" text PRIMARY KEY NOT NULL,
					"episode_id" text
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "subtitles" (
					"id" text PRIMARY KEY NOT NULL,
					"episode_id" text
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "download_queue" (
					"id" text PRIMARY KEY NOT NULL,
					"episode_ids" text
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "unmatched_files" (
					"id" text PRIMARY KEY NOT NULL,
					"path" text NOT NULL,
					"root_folder_id" text,
					"media_type" text NOT NULL,
					"discovered_at" text
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "library_scan_history" (
					"id" text PRIMARY KEY NOT NULL,
					"root_folder_id" text,
					"status" text NOT NULL,
					"started_at" text
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "seasons" (
					"id" text PRIMARY KEY NOT NULL,
					"series_id" text NOT NULL,
					"season_number" integer NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "episodes" (
					"id" text PRIMARY KEY NOT NULL,
					"series_id" text NOT NULL,
					"season_id" text,
					"season_number" integer NOT NULL,
					"episode_number" integer NOT NULL
				)`
			)
			.run();
		sqlite.prepare(`INSERT INTO "settings" ("key", "value") VALUES ('schema_version', '89')`).run();
		sqlite.prepare(`INSERT INTO "series" ("id", "root_folder_id") VALUES ('series-1', NULL)`).run();
		sqlite
			.prepare(`INSERT INTO "seasons" ("id", "series_id", "season_number") VALUES (?, ?, ?)`)
			.run('season-1', 'series-1', 1);
		sqlite
			.prepare(`INSERT INTO "seasons" ("id", "series_id", "season_number") VALUES (?, ?, ?)`)
			.run('season-2', 'series-1', 1);
		sqlite
			.prepare(
				`INSERT INTO "episodes" ("id", "series_id", "season_id", "season_number", "episode_number")
				 VALUES (?, ?, ?, ?, ?)`
			)
			.run('episode-1', 'series-1', 'season-1', 1, 1);
		sqlite
			.prepare(
				`INSERT INTO "episodes" ("id", "series_id", "season_id", "season_number", "episode_number")
				 VALUES (?, ?, ?, ?, ?)`
			)
			.run('episode-2', 'series-1', 'season-2', 1, 1);
		sqlite
			.prepare(
				`INSERT INTO "episode_files" ("id", "series_id", "season_number", "episode_ids", "relative_path") VALUES (?, ?, ?, ?, ?)`
			)
			.run('file-1', 'series-1', 1, JSON.stringify(['episode-2']), 'Season 01/Episode 01.mkv');
		sqlite
			.prepare(`INSERT INTO "monitoring_history" ("id", "episode_id") VALUES (?, ?)`)
			.run('monitoring-1', 'episode-2');
		sqlite
			.prepare(`INSERT INTO "subtitles" ("id", "episode_id") VALUES (?, ?)`)
			.run('subtitle-1', 'episode-2');
		sqlite
			.prepare(`INSERT INTO "download_queue" ("id", "episode_ids") VALUES (?, ?)`)
			.run('queue-1', JSON.stringify(['episode-2']));

		expect(() => migration_v090.apply(sqlite)).not.toThrow();
		expect(getColumnNames(sqlite, 'movie_files')).toContain('last_seen_scan_id');
		expect(getColumnNames(sqlite, 'episode_files')).toContain('last_seen_scan_id');
		expect(getColumnNames(sqlite, 'unmatched_files')).toContain('last_seen_scan_id');

		const seasonCount = sqlite.prepare(`SELECT COUNT(*) AS count FROM "seasons"`).get() as {
			count: number;
		};
		const episodeCount = sqlite.prepare(`SELECT COUNT(*) AS count FROM "episodes"`).get() as {
			count: number;
		};
		expect(seasonCount.count).toBe(1);
		expect(episodeCount.count).toBe(1);
		expect(
			sqlite.prepare(`SELECT "episode_id" AS episodeId FROM "monitoring_history"`).get()
		).toEqual({ episodeId: 'episode-1' });
		expect(sqlite.prepare(`SELECT "episode_id" AS episodeId FROM "subtitles"`).get()).toEqual({
			episodeId: 'episode-1'
		});
		expect(
			JSON.parse(
				(
					sqlite.prepare(`SELECT "episode_ids" AS episodeIds FROM "episode_files"`).get() as {
						episodeIds: string;
					}
				).episodeIds
			)
		).toEqual(['episode-1']);
		expect(
			JSON.parse(
				(
					sqlite.prepare(`SELECT "episode_ids" AS episodeIds FROM "download_queue"`).get() as {
						episodeIds: string;
					}
				).episodeIds
			)
		).toEqual(['episode-1']);
	});

	it('creates Better Auth plugin tables for a fresh database', () => {
		const sqlite = createTestDatabase();

		syncSchema(sqlite);

		expect(tableExists(sqlite, 'apikey')).toBe(true);
		expect(tableExists(sqlite, 'rateLimit')).toBe(true);
		expect(getColumnNames(sqlite, 'user')).toEqual(
			expect.arrayContaining([
				'email',
				'username',
				'displayUsername',
				'role',
				'banned',
				'banReason',
				'banExpires'
			])
		);
		expect(getColumnNames(sqlite, 'session')).toContain('impersonatedBy');
	});

	it('repairs broken Better Auth tables from an existing schema version', () => {
		const sqlite = createTestDatabase();

		sqlite
			.prepare(
				`CREATE TABLE "user" (
					"id" text PRIMARY KEY NOT NULL,
					"role" text DEFAULT 'admin' NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "session" (
					"id" text PRIMARY KEY NOT NULL,
					"userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
					"token" text NOT NULL UNIQUE,
					"expiresAt" date NOT NULL,
					"ipAddress" text,
					"userAgent" text,
					"createdAt" date NOT NULL,
					"updatedAt" date NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "account" (
					"id" text PRIMARY KEY NOT NULL,
					"userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
					"accountId" text NOT NULL,
					"providerId" text NOT NULL,
					"accessToken" text,
					"refreshToken" text,
					"accessTokenExpiresAt" date,
					"refreshTokenExpiresAt" date,
					"scope" text,
					"idToken" text,
					"password" text,
					"createdAt" date NOT NULL,
					"updatedAt" date NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "verification" (
					"id" text PRIMARY KEY NOT NULL,
					"identifier" text NOT NULL,
					"value" text NOT NULL,
					"expiresAt" date NOT NULL,
					"createdAt" date,
					"updatedAt" date
				)`
			)
			.run();
		sqlite
			.prepare(`CREATE TABLE "settings" ("key" text PRIMARY KEY NOT NULL, "value" text NOT NULL)`)
			.run();
		sqlite.prepare(`INSERT INTO "settings" ("key", "value") VALUES ('schema_version', '62')`).run();

		syncSchema(sqlite);

		expect(tableExists(sqlite, 'apikey')).toBe(true);
		expect(tableExists(sqlite, 'rateLimit')).toBe(true);
		expect(getColumnNames(sqlite, 'user')).toEqual(
			expect.arrayContaining([
				'name',
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
			])
		);
		expect(getColumnNames(sqlite, 'session')).toContain('impersonatedBy');

		const userTable = sqlite
			.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='user'`)
			.get() as { sql: string };
		expect(userTable.sql).toContain('"email" text NOT NULL');
	});

	it('promotes a sole legacy bootstrap user to admin', () => {
		const sqlite = createTestDatabase();

		sqlite
			.prepare(
				`CREATE TABLE "user" (
					"id" text PRIMARY KEY NOT NULL,
					"name" text,
					"email" text NOT NULL,
					"emailVerified" integer DEFAULT 0,
					"image" text,
					"username" text UNIQUE,
					"displayUsername" text,
					"role" text DEFAULT 'admin' NOT NULL,
					"banned" integer DEFAULT 0,
					"banReason" text,
					"banExpires" date,
					"createdAt" date NOT NULL,
					"updatedAt" date NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(`CREATE TABLE "settings" ("key" text PRIMARY KEY NOT NULL, "value" text NOT NULL)`)
			.run();
		sqlite
			.prepare(
				`INSERT INTO "user" ("id", "email", "username", "role", "createdAt", "updatedAt")
				 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(
				'user-1',
				'admin@example.com',
				'admin',
				'user',
				'2026-03-01T00:00:00.000Z',
				'2026-03-01T00:00:00.000Z'
			);
		sqlite.prepare(`INSERT INTO "settings" ("key", "value") VALUES ('schema_version', '63')`).run();

		syncSchema(sqlite);

		const row = sqlite.prepare(`SELECT "role" FROM "user" WHERE "id" = 'user-1'`).get() as {
			role: string;
		};

		expect(row.role).toBe('admin');
	});

	it('repairs legacy snake_case auth columns without failing startup', () => {
		const sqlite = createTestDatabase();

		sqlite
			.prepare(
				`CREATE TABLE "user" (
					"id" text PRIMARY KEY NOT NULL,
					"name" text,
					"email" text NOT NULL,
					"emailVerified" integer DEFAULT 0,
					"image" text,
					"username" text UNIQUE,
					"displayUsername" text,
					"role" text DEFAULT 'admin' NOT NULL,
					"banned" integer DEFAULT 0,
					"banReason" text,
					"banExpires" date,
					"createdAt" date NOT NULL,
					"updatedAt" date NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "session" (
					"id" text PRIMARY KEY NOT NULL,
					"user_id" text NOT NULL,
					"token" text NOT NULL UNIQUE,
					"expires_at" date NOT NULL,
					"ip_address" text,
					"user_agent" text,
					"created_at" date NOT NULL,
					"updated_at" date NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "account" (
					"id" text PRIMARY KEY NOT NULL,
					"user_id" text NOT NULL,
					"account_id" text NOT NULL,
					"provider_id" text NOT NULL,
					"created_at" date NOT NULL,
					"updated_at" date NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "apikey" (
					"id" text PRIMARY KEY NOT NULL,
					"key" text NOT NULL,
					"user_id" text NOT NULL,
					"createdAt" date NOT NULL,
					"updatedAt" date NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(`CREATE TABLE "settings" ("key" text PRIMARY KEY NOT NULL, "value" text NOT NULL)`)
			.run();
		sqlite.prepare(`INSERT INTO "settings" ("key", "value") VALUES ('schema_version', '62')`).run();

		sqlite
			.prepare(
				`INSERT INTO "user" ("id", "email", "username", "role", "createdAt", "updatedAt")
				 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(
				'user-legacy',
				'legacy@example.com',
				'legacy-user',
				'admin',
				'2026-03-01T00:00:00.000Z',
				'2026-03-01T00:00:00.000Z'
			);
		sqlite
			.prepare(
				`INSERT INTO "session" ("id", "user_id", "token", "expires_at", "created_at", "updated_at")
				 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(
				'session-legacy',
				'user-legacy',
				'legacy-token',
				'2026-04-01T00:00:00.000Z',
				'2026-03-01T00:00:00.000Z',
				'2026-03-01T00:00:00.000Z'
			);
		sqlite
			.prepare(
				`INSERT INTO "account" ("id", "user_id", "account_id", "provider_id", "created_at", "updated_at")
				 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(
				'account-legacy',
				'user-legacy',
				'provider-account',
				'credentials',
				'2026-03-01T00:00:00.000Z',
				'2026-03-01T00:00:00.000Z'
			);
		sqlite
			.prepare(
				`INSERT INTO "apikey" ("id", "key", "user_id", "createdAt", "updatedAt")
				 VALUES (?, ?, ?, ?, ?)`
			)
			.run(
				'apikey-legacy',
				'legacy-apikey',
				'user-legacy',
				'2026-03-01T00:00:00.000Z',
				'2026-03-01T00:00:00.000Z'
			);

		expect(() => syncSchema(sqlite)).not.toThrow();

		expect(getColumnNames(sqlite, 'session')).toEqual(
			expect.arrayContaining(['userId', 'expiresAt'])
		);
		expect(getColumnNames(sqlite, 'account')).toEqual(
			expect.arrayContaining(['userId', 'accountId', 'providerId'])
		);
		expect(getColumnNames(sqlite, 'apikey')).toEqual(
			expect.arrayContaining(['referenceId', 'configId'])
		);

		const sessionRow = sqlite
			.prepare(`SELECT "userId" FROM "session" WHERE "id" = ?`)
			.get('session-legacy') as { userId: string };
		expect(sessionRow.userId).toBe('user-legacy');
	});

	it('adds and backfills rateLimit.id for legacy rateLimit tables', () => {
		const sqlite = createTestDatabase();

		sqlite
			.prepare(
				`CREATE TABLE "rateLimit" (
					"key" text PRIMARY KEY NOT NULL,
					"count" integer NOT NULL,
					"lastRequest" integer NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(`CREATE TABLE "settings" ("key" text PRIMARY KEY NOT NULL, "value" text NOT NULL)`)
			.run();
		sqlite.prepare(`INSERT INTO "settings" ("key", "value") VALUES ('schema_version', '64')`).run();
		sqlite
			.prepare(`INSERT INTO "rateLimit" ("key", "count", "lastRequest") VALUES (?, ?, ?)`)
			.run('ip|/sign-in', 2, Date.now());

		expect(() => syncSchema(sqlite)).not.toThrow();
		expect(getColumnNames(sqlite, 'rateLimit')).toEqual(
			expect.arrayContaining(['id', 'key', 'count', 'lastRequest'])
		);

		const row = sqlite
			.prepare(`SELECT "id", "key", "count" FROM "rateLimit" WHERE "key" = ?`)
			.get('ip|/sign-in') as { id: string; key: string; count: number };
		expect(row.id).toBeTruthy();
		expect(row.key).toBe('ip|/sign-in');
		expect(row.count).toBe(2);
	});

	it('migrates saved custom format audio conditions to canonical schema', () => {
		const sqlite = createTestDatabase();

		sqlite
			.prepare(`CREATE TABLE "settings" ("key" text PRIMARY KEY NOT NULL, "value" text NOT NULL)`)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "user" (
					"id" text PRIMARY KEY NOT NULL,
					"name" text,
					"email" text NOT NULL,
					"emailVerified" integer DEFAULT 0,
					"image" text,
					"username" text UNIQUE,
					"displayUsername" text,
					"role" text DEFAULT 'admin' NOT NULL,
					"language" text DEFAULT 'en',
					"banned" integer DEFAULT 0,
					"banReason" text,
					"banExpires" date,
					"createdAt" date NOT NULL,
					"updatedAt" date NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "session" (
					"id" text PRIMARY KEY NOT NULL,
					"userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
					"token" text NOT NULL UNIQUE,
					"expiresAt" date NOT NULL,
					"ipAddress" text,
					"userAgent" text,
					"impersonatedBy" text,
					"createdAt" date NOT NULL,
					"updatedAt" date NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "account" (
					"id" text PRIMARY KEY NOT NULL,
					"userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
					"accountId" text NOT NULL,
					"providerId" text NOT NULL,
					"accessToken" text,
					"refreshToken" text,
					"accessTokenExpiresAt" date,
					"refreshTokenExpiresAt" date,
					"scope" text,
					"idToken" text,
					"password" text,
					"createdAt" date NOT NULL,
					"updatedAt" date NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "verification" (
					"id" text PRIMARY KEY NOT NULL,
					"identifier" text NOT NULL,
					"value" text NOT NULL,
					"expiresAt" date NOT NULL,
					"createdAt" date,
					"updatedAt" date
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "apikey" (
					"id" text PRIMARY KEY NOT NULL,
					"name" text,
					"start" text,
					"prefix" text,
					"key" text NOT NULL,
					"referenceId" text NOT NULL,
					"configId" text DEFAULT 'default',
					"refillInterval" integer,
					"refillAmount" integer,
					"lastRefillAt" date,
					"enabled" integer DEFAULT 1,
					"rateLimitEnabled" integer DEFAULT 1,
					"rateLimitTimeWindow" integer,
					"rateLimitMax" integer,
					"requestCount" integer DEFAULT 0,
					"remaining" integer,
					"lastRequest" date,
					"expiresAt" date,
					"createdAt" date NOT NULL,
					"updatedAt" date NOT NULL,
					"permissions" text,
					"metadata" text
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "rateLimit" (
					"id" text PRIMARY KEY NOT NULL,
					"key" text NOT NULL UNIQUE,
					"count" integer NOT NULL,
					"lastRequest" integer NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "custom_formats" (
					"id" text PRIMARY KEY NOT NULL,
					"name" text NOT NULL,
					"description" text,
					"category" text NOT NULL DEFAULT 'other',
					"tags" text,
					"conditions" text,
					"enabled" integer DEFAULT true,
					"created_at" text,
					"updated_at" text
				)`
			)
			.run();
		sqlite.prepare(`INSERT INTO "settings" ("key", "value") VALUES ('schema_version', '78')`).run();
		sqlite
			.prepare(
				`INSERT INTO "custom_formats" ("id", "name", "category", "conditions") VALUES (?, ?, ?, ?)`
			)
			.run(
				'legacy-audio-format',
				'Legacy Audio Format',
				'audio',
				JSON.stringify([
					{
						name: 'Legacy DD+',
						type: 'audio',
						required: true,
						negate: false,
						audio: 'dd+'
					},
					{
						name: 'Legacy Atmos',
						type: 'audio',
						required: false,
						negate: false,
						audio: 'atmos'
					}
				])
			);

		syncSchema(sqlite);

		const row = sqlite
			.prepare(`SELECT "conditions" FROM "custom_formats" WHERE "id" = 'legacy-audio-format'`)
			.get() as { conditions: string };
		const conditions = JSON.parse(row.conditions) as Array<Record<string, unknown>>;

		expect(conditions).toEqual([
			{
				name: 'Legacy DD+',
				type: 'audio_codec',
				required: true,
				negate: false,
				audioCodec: 'dd+'
			},
			{
				name: 'Legacy Atmos',
				type: 'audio_atmos',
				required: false,
				negate: false
			}
		]);
	});
});

describe('apikey v1.5 baseline shape and pre-migration converge', () => {
	function getApikeyColumn(
		sqlite: Database.Database,
		name: string
	): { notnull: number } | undefined {
		const columns = sqlite.prepare(`PRAGMA table_info(apikey)`).all() as Array<{
			name: string;
			notnull: number;
		}>;
		return columns.find((column) => column.name === name);
	}

	it('creates the apikey table in the v1.5 shape before any migration runs', () => {
		const sqlite = createTestDatabase();

		createBetterAuthTables(sqlite);

		const columns = getColumnNames(sqlite, 'apikey');
		expect(columns).toContain('referenceId');
		expect(columns).toContain('configId');
		// better-auth >= 1.7 validates required columns on first access and
		// latches a mismatch — the table must be born correct, not converged
		// later by migrations 065/066.
		expect(columns).not.toContain('userId');
		expect(getApikeyColumn(sqlite, 'referenceId')?.notnull).toBe(1);
	});

	it('converges a legacy v1.4 apikey table before better-auth is constructed', () => {
		const sqlite = createTestDatabase();
		sqlite
			.prepare(`CREATE TABLE "user" ("id" text PRIMARY KEY NOT NULL, "email" text NOT NULL)`)
			.run();
		sqlite
			.prepare(`INSERT INTO "user" ("id", "email") VALUES ('user-1', 'user@example.com')`)
			.run();
		sqlite
			.prepare(
				`CREATE TABLE "apikey" (
					"id" text PRIMARY KEY NOT NULL,
					"key" text NOT NULL,
					"userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
					"createdAt" date NOT NULL,
					"updatedAt" date NOT NULL
				)`
			)
			.run();
		sqlite
			.prepare(
				`INSERT INTO "apikey" ("id", "key", "userId", "createdAt", "updatedAt")
				 VALUES ('key-1', 'secret', 'user-1', '2026-01-01', '2026-01-01')`
			)
			.run();

		convergeApikeySchemaToV15(sqlite);

		const columns = getColumnNames(sqlite, 'apikey');
		expect(columns).toContain('referenceId');
		expect(columns).toContain('configId');
		expect(columns).not.toContain('userId');

		const row = sqlite.prepare(`SELECT "referenceId" FROM "apikey" WHERE "id" = 'key-1'`).get() as {
			referenceId: string;
		};
		expect(row.referenceId).toBe('user-1');
		// RENAME COLUMN preserves constraints — the renamed column stays NOT NULL.
		expect(getApikeyColumn(sqlite, 'referenceId')?.notnull).toBe(1);

		expect(() => convergeApikeySchemaToV15(sqlite)).not.toThrow();
	});

	it('keeps a fresh install free of the legacy userId column through full syncSchema', () => {
		const sqlite = createTestDatabase();

		syncSchema(sqlite);

		const columns = getColumnNames(sqlite, 'apikey');
		expect(columns).toContain('referenceId');
		expect(columns).toContain('configId');
		expect(columns).not.toContain('userId');
	});

	it('drops a stray userId column instead of failing migration 065', () => {
		const sqlite = createTestDatabase();
		sqlite
			.prepare(
				`CREATE TABLE "apikey" (
					"id" text PRIMARY KEY NOT NULL,
					"key" text NOT NULL,
					"userId" text,
					"referenceId" text
				)`
			)
			.run();
		sqlite
			.prepare(
				`INSERT INTO "apikey" ("id", "key", "userId", "referenceId")
				 VALUES ('key-1', 'secret', 'user-legacy', 'user-1')`
			)
			.run();

		expect(() => migration_v065.apply(sqlite)).not.toThrow();

		const columns = getColumnNames(sqlite, 'apikey');
		expect(columns).not.toContain('userId');
		expect(columns).toContain('referenceId');
		expect(columns).toContain('configId');

		const row = sqlite.prepare(`SELECT "referenceId" FROM "apikey" WHERE "id" = 'key-1'`).get() as {
			referenceId: string;
		};
		expect(row.referenceId).toBe('user-1');
	});
});

describe('syncSchema language system', () => {
	it('creates the language_settings singleton table with all columns and defaults', () => {
		const sqlite = createTestDatabase();

		syncSchema(sqlite);

		expect(tableExists(sqlite, 'language_settings')).toBe(true);
		expect(getColumnNames(sqlite, 'language_settings')).toEqual(
			expect.arrayContaining([
				'id',
				'default_profile_id',
				'metadata_locale',
				'region',
				'discover_original_filter',
				'unknown_subtitle_policy',
				'assumed_language',
				'auto_sync_subtitles',
				'updated_at'
			])
		);

		// Migration v137 seeds the singleton during syncSchema; clear it so the
		// bare-row insert below exposes the raw DDL column defaults.
		sqlite.prepare(`DELETE FROM "language_settings"`).run();
		sqlite.prepare(`INSERT INTO "language_settings" ("id") VALUES ('singleton')`).run();
		const settings = sqlite
			.prepare(`SELECT * FROM "language_settings" WHERE "id" = 'singleton'`)
			.get() as Record<string, unknown>;
		expect(settings.default_profile_id).toBeNull();
		expect(settings.metadata_locale).toBe('en-US');
		expect(settings.region).toBe('US');
		expect(settings.discover_original_filter).toBeNull();
		expect(settings.unknown_subtitle_policy).toBe('und');
		expect(settings.assumed_language).toBeNull();
		expect(settings.auto_sync_subtitles).toBe(1);
	});

	it('creates language_profiles with the v2 shape and no is_default column', () => {
		const sqlite = createTestDatabase();

		syncSchema(sqlite);

		expect(getColumnNames(sqlite, 'language_profiles')).toEqual(
			expect.arrayContaining([
				'id',
				'name',
				'audio',
				'subtitles',
				'cutoff_rank',
				'minimum_score',
				'upgrades_allowed',
				'created_at',
				'updated_at'
			])
		);
		expect(getColumnNames(sqlite, 'language_profiles')).not.toContain('is_default');
		expect(getColumnNames(sqlite, 'language_profiles')).not.toContain('languages');
		expect(getColumnNames(sqlite, 'language_profiles')).not.toContain('cutoff_index');

		sqlite
			.prepare(
				`INSERT INTO "language_profiles" ("id", "name", "audio", "subtitles")
				 VALUES ('profile-1', 'Default', '{}', '[]')`
			)
			.run();
		const profile = sqlite
			.prepare(`SELECT * FROM "language_profiles" WHERE "id" = 'profile-1'`)
			.get() as Record<string, unknown>;
		expect(profile.minimum_score).toBe(70);
		expect(profile.cutoff_rank).toBeNull();
		expect(profile.upgrades_allowed).toBe(1);
	});

	it('adds language identity columns to movies/series and language_profile_id to libraries', () => {
		const sqlite = createTestDatabase();

		syncSchema(sqlite);

		for (const table of ['movies', 'series']) {
			expect(getColumnNames(sqlite, table)).toEqual(
				expect.arrayContaining([
					'original_language',
					'metadata_language_mode',
					'metadata_language_value'
				])
			);
		}
		expect(getColumnNames(sqlite, 'libraries')).toContain('language_profile_id');

		sqlite
			.prepare(
				`INSERT INTO "movies" ("id", "tmdb_id", "title", "path") VALUES ('movie-1', 1, 'T', '/t')`
			)
			.run();
		const movie = sqlite.prepare(`SELECT * FROM "movies" WHERE "id" = 'movie-1'`).get() as Record<
			string,
			unknown
		>;
		expect(movie.original_language).toBeNull();
		expect(movie.metadata_language_mode).toBe('inherit');
		expect(movie.metadata_language_value).toBeNull();
	});

	it('enforces the subtitle owner XOR check on fresh databases', () => {
		const sqlite = createTestDatabase();

		syncSchema(sqlite);

		const subtitlesDdl = sqlite
			.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'subtitles'`)
			.get() as { sql: string };
		expect(subtitlesDdl.sql).toContain(
			'CHECK ((movie_id IS NOT NULL AND episode_id IS NULL) OR (movie_id IS NULL AND episode_id IS NOT NULL))'
		);

		sqlite
			.prepare(
				`INSERT INTO "movies" ("id", "tmdb_id", "title", "path") VALUES ('m1', 1, 'T', '/t')`
			)
			.run();
		sqlite
			.prepare(
				`INSERT INTO "subtitles" ("id", "movie_id", "relative_path", "language", "format")
				 VALUES ('s1', 'm1', 't.en.srt', 'en', 'srt')`
			)
			.run();
		expect(() =>
			sqlite
				.prepare(
					`INSERT INTO "subtitles" ("id", "movie_id", "episode_id", "relative_path", "language", "format")
					 VALUES ('s2', 'm1', 'e1', 't2.en.srt', 'en', 'srt')`
				)
				.run()
		).toThrow(/CHECK/);
	});

	it('creates subtitle_search_state and subtitles.last_checked_at', () => {
		const sqlite = createTestDatabase();

		syncSchema(sqlite);

		expect(tableExists(sqlite, 'subtitle_search_state')).toBe(true);
		expect(getColumnNames(sqlite, 'subtitle_search_state')).toEqual([
			'owner_type',
			'owner_id',
			'requirement_key',
			'failed_attempts',
			'first_search_at',
			'last_search_at'
		]);
		expect(getColumnNames(sqlite, 'subtitles')).toContain('last_checked_at');

		const indexNames = (
			sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{
				name: string;
			}>
		).map((row) => row.name);
		expect(indexNames).toContain('idx_subtitle_search_state_owner');

		sqlite
			.prepare(
				`INSERT INTO "subtitle_search_state" ("owner_type", "owner_id", "requirement_key")
				 VALUES ('movie', 'm1', 'en|forced|any')`
			)
			.run();
		const state = sqlite
			.prepare(`SELECT * FROM "subtitle_search_state" WHERE "owner_id" = 'm1'`)
			.get() as Record<string, unknown>;
		expect(state).toMatchObject({
			owner_type: 'movie',
			owner_id: 'm1',
			requirement_key: 'en|forced|any',
			failed_attempts: 0,
			first_search_at: null,
			last_search_at: null
		});
	});
});
