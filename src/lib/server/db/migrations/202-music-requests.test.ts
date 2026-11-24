import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration_v202 } from './202-music-requests.js';

const OLD_REQUESTS = `
CREATE TABLE "requests" (
	"id" text PRIMARY KEY NOT NULL,
	"media_type" text NOT NULL,
	"tmdb_id" integer NOT NULL,
	"title" text NOT NULL,
	"poster_path" text,
	"year" integer,
	"movie_id" text REFERENCES "movies"("id") ON DELETE SET NULL,
	"series_id" text REFERENCES "series"("id") ON DELETE SET NULL,
	"status" text NOT NULL DEFAULT 'pending',
	"seasons" text,
	"episodes" text,
	"episode_count_snapshot" text,
	"requested_by" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"acting_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
	"decided_by" text REFERENCES "user"("id") ON DELETE SET NULL,
	"auto_approved" integer NOT NULL DEFAULT 0,
	"decline_reason" text,
	"failure_reason" text,
	"ignore_quota" integer NOT NULL DEFAULT 0,
	"expires_at" text,
	"decided_at" text,
	"fulfilled_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
)`;

const OLD_USER_SETTINGS = `
CREATE TABLE "user_request_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"requests_disabled" integer NOT NULL DEFAULT 0,
	"auto_approve" integer,
	"movie_quota_limit" integer,
	"movie_quota_days" integer,
	"tv_quota_limit" integer,
	"tv_quota_days" integer,
	"updated_at" text NOT NULL
)`;

function seed(sqlite: Database.Database): void {
	// The request row references a user that this isolated table test does not
	// create; the migration must work on real rows, not on FK enforcement.
	sqlite.pragma('foreign_keys = OFF');
	sqlite.exec(OLD_REQUESTS);
	sqlite.exec(OLD_USER_SETTINGS);
	sqlite.exec(
		'CREATE INDEX "idx_requests_media_status" ON "requests" ("media_type", "tmdb_id", "status")'
	);
	sqlite.exec(
		'CREATE INDEX "idx_requests_requester_created" ON "requests" ("requested_by", "created_at")'
	);
	sqlite.exec('CREATE INDEX "idx_requests_pending" ON "requests" ("status")');
	sqlite
		.prepare(
			`INSERT INTO requests (id, media_type, tmdb_id, title, status, requested_by, created_at, updated_at)
			 VALUES ('r1', 'movie', 603, 'The Matrix', 'pending', 'u1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
		)
		.run();
	sqlite
		.prepare(
			`INSERT INTO user_request_settings (user_id, movie_quota_limit, movie_quota_days, updated_at)
			 VALUES ('u1', 5, 7, '2026-01-01T00:00:00.000Z')`
		)
		.run();
}

function columns(sqlite: Database.Database, table: string) {
	return sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
		name: string;
		notnull: number;
	}>;
}

describe('migration 202: music requests', () => {
	it('makes tmdb_id nullable and adds the music identity without losing rows', () => {
		const sqlite = new Database(':memory:');
		seed(sqlite);

		migration_v202.apply(sqlite);

		const cols = columns(sqlite, 'requests');
		expect(cols.find((c) => c.name === 'tmdb_id')?.notnull).toBe(0);
		expect(cols.map((c) => c.name)).toEqual(
			expect.arrayContaining(['mbid', 'album_id', 'cover_url'])
		);
		const row = sqlite.prepare(`SELECT * FROM "requests" WHERE id = 'r1'`).get() as Record<
			string,
			unknown
		>;
		expect(row).toMatchObject({
			media_type: 'movie',
			tmdb_id: 603,
			title: 'The Matrix',
			status: 'pending',
			requested_by: 'u1'
		});

		// A music request carries the release group and no TMDB id.
		sqlite
			.prepare(
				`INSERT INTO requests (id, media_type, mbid, title, status, requested_by, created_at, updated_at)
				 VALUES ('r2', 'music', 'rg-1', 'Discovery', 'pending', 'u1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
			)
			.run();
		const music = sqlite.prepare(`SELECT * FROM "requests" WHERE id = 'r2'`).get() as Record<
			string,
			unknown
		>;
		expect(music).toMatchObject({ media_type: 'music', tmdb_id: null, mbid: 'rg-1' });
	});

	it('recreates the request indexes and adds the music ones', () => {
		const sqlite = new Database(':memory:');
		seed(sqlite);
		migration_v202.apply(sqlite);
		const names = (
			sqlite
				.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'requests'`)
				.all() as Array<{ name: string }>
		).map((r) => r.name);
		expect(names).toEqual(
			expect.arrayContaining([
				'idx_requests_media_status',
				'idx_requests_requester_created',
				'idx_requests_pending',
				'idx_requests_media_mbid',
				'idx_requests_album'
			])
		);
	});

	it('adds music quota columns while preserving existing overrides', () => {
		const sqlite = new Database(':memory:');
		seed(sqlite);
		migration_v202.apply(sqlite);
		const cols = columns(sqlite, 'user_request_settings').map((c) => c.name);
		expect(cols).toEqual(expect.arrayContaining(['music_quota_limit', 'music_quota_days']));
		const row = sqlite
			.prepare(`SELECT * FROM "user_request_settings" WHERE user_id = 'u1'`)
			.get() as Record<string, unknown>;
		expect(row).toMatchObject({ movie_quota_limit: 5, movie_quota_days: 7 });
		expect(row.music_quota_limit).toBeNull();
	});

	it('is a no-op on an already-migrated database', () => {
		const sqlite = new Database(':memory:');
		seed(sqlite);
		migration_v202.apply(sqlite);
		const before = sqlite.prepare(`SELECT count(*) AS n FROM "requests"`).get() as { n: number };
		migration_v202.apply(sqlite);
		const after = sqlite.prepare(`SELECT count(*) AS n FROM "requests"`).get() as { n: number };
		expect(after.n).toBe(before.n);
		expect(columns(sqlite, 'requests').find((c) => c.name === 'tmdb_id')?.notnull).toBe(0);
	});
});
