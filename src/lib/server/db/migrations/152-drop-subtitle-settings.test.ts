import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migration_v152 } from './152-drop-subtitle-settings.js';

const databases: Database.Database[] = [];

function createLegacyDatabase(): Database.Database {
	const sqlite = new Database(':memory:');
	databases.push(sqlite);
	sqlite.exec(`
		CREATE TABLE "subtitle_settings" (
			"key" text PRIMARY KEY NOT NULL,
			"value" text NOT NULL
		);
		INSERT INTO subtitle_settings (key, value) VALUES ('preferred_audio_language', 'en');
		CREATE TABLE "language_settings" ("id" text PRIMARY KEY NOT NULL);
	`);
	return sqlite;
}

afterEach(() => {
	for (const sqlite of databases.splice(0)) {
		sqlite.close();
	}
});

describe('migration v152 - drop subtitle_settings', () => {
	it('drops the legacy table and leaves other tables alone', () => {
		const sqlite = createLegacyDatabase();

		migration_v152.apply(sqlite);

		const tables = (
			sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
				name: string;
			}>
		).map((row) => row.name);
		expect(tables).not.toContain('subtitle_settings');
		expect(tables).toContain('language_settings');
	});

	it('is idempotent when the table is already gone', () => {
		const sqlite = createLegacyDatabase();
		migration_v152.apply(sqlite);

		expect(() => migration_v152.apply(sqlite)).not.toThrow();
	});
});
