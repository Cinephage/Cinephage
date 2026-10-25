import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../../../test/db-helper';
import { api } from '../../../../../test/api-helper';

const mockLogger = vi.hoisted(() => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	child: vi.fn().mockReturnThis()
}));

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('#lib/logging/index.js', () => ({
	logger: mockLogger,
	createChildLogger: vi.fn(() => mockLogger)
}));

const { GET } = await import('./+server');
const { languageProfiles, languageSettings } = await import('#lib/server/db/schema.js');
const { LanguageSettingsService } =
	await import('#lib/server/subtitles/services/LanguageSettingsService.js');

const PROFILE_DEFAULT = 'b0000000-0000-4000-8000-000000000001';

/** Insert a profile row directly with a fixed UUID-shaped id. */
async function seedProfile(id: string, name: string): Promise<void> {
	await testDb.db.insert(languageProfiles).values({
		id,
		name,
		audio: { preferOriginal: true, languages: [], mode: 'prefer' },
		subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
		cutoffRank: null,
		minimumScore: 70,
		upgradesAllowed: true
	});
}

async function setDefaultProfileId(id: string | null): Promise<void> {
	await LanguageSettingsService.getInstance().update({ defaultProfileId: id });
}

describe('Effective language settings API (add flow)', () => {
	afterAll(() => {
		destroyTestDb(testDb);
	});

	beforeEach(async () => {
		testDb.sqlite.prepare('DELETE FROM language_settings').run();
		testDb.sqlite.prepare('DELETE FROM language_profiles').run();
		await setDefaultProfileId(null);
	});

	it('returns null when no default profile is configured', async () => {
		const { status, data } = await api.get<unknown>(GET, {
			url: 'http://localhost/api/subtitles/language-settings/effective?mediaType=movie'
		});

		expect(status).toBe(200);
		expect(data).toBeNull();
	});

	it('resolves the instance default with source "default" for movies', async () => {
		await seedProfile(PROFILE_DEFAULT, 'English Default');
		await setDefaultProfileId(PROFILE_DEFAULT);

		const { status, data } = await api.get<{ profile: { id: string }; source: string }>(GET, {
			url: 'http://localhost/api/subtitles/language-settings/effective?mediaType=movie'
		});

		expect(status).toBe(200);
		expect(data).toMatchObject({ profile: { id: PROFILE_DEFAULT }, source: 'default' });
	});

	it('resolves the instance default for series too', async () => {
		await seedProfile(PROFILE_DEFAULT, 'English Default');
		await setDefaultProfileId(PROFILE_DEFAULT);

		const { status, data } = await api.get<{ source: string }>(GET, {
			url: 'http://localhost/api/subtitles/language-settings/effective?mediaType=series'
		});

		expect(status).toBe(200);
		expect(data).toMatchObject({ profile: { id: PROFILE_DEFAULT }, source: 'default' });
	});

	it('rejects an unknown mediaType', async () => {
		const { status } = await api.get(GET, {
			url: 'http://localhost/api/subtitles/language-settings/effective?mediaType=book'
		});

		expect(status).toBe(400);
	});

	it('accepts the request without a mediaType parameter', async () => {
		const { status } = await api.get(GET);

		expect(status).toBe(200);
	});

	it('ignores a dangling default profile id and returns null', async () => {
		// Simulate a legacy dangling reference written before the service
		// validated that the profile exists.
		await testDb.db
			.insert(languageSettings)
			.values({ id: 'singleton', defaultProfileId: PROFILE_DEFAULT })
			.onConflictDoUpdate({
				target: languageSettings.id,
				set: { defaultProfileId: PROFILE_DEFAULT }
			});

		const { status, data } = await api.get<unknown>(GET, {
			url: 'http://localhost/api/subtitles/language-settings/effective?mediaType=movie'
		});

		expect(status).toBe(200);
		expect(data).toBeNull();
	});

	it('reflects a cleared default (profile delete nulls the reference)', async () => {
		await seedProfile(PROFILE_DEFAULT, 'English Default');
		await setDefaultProfileId(PROFILE_DEFAULT);

		await testDb.db.delete(languageProfiles).where(eq(languageProfiles.id, PROFILE_DEFAULT));

		const { status, data } = await api.get<unknown>(GET, {
			url: 'http://localhost/api/subtitles/language-settings/effective?mediaType=movie'
		});

		expect(status).toBe(200);
		expect(data).toBeNull();
	});
});
