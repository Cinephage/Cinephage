/**
 * The stalled-download settings shown on the download client page must match
 * what the download monitor actually does. Before this, an install that never
 * saved the setting showed a 60 minute timeout while the monitor waited 3 days,
 * and the timeout for downloads above the progress threshold (14 days) could
 * not be seen or changed at all.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, destroyTestDb, clearTestDb } from '../../../test/db-helper';
import { monitoringSettings } from '#lib/server/db/schema.js';

const testDb = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

const { getMonitoringScheduler, resetMonitoringScheduler } =
	await import('./MonitoringScheduler.js');

async function storedValue(key: string) {
	const [row] = await testDb.db
		.select()
		.from(monitoringSettings)
		.where(eq(monitoringSettings.key, key));
	return row?.value;
}

beforeEach(async () => {
	clearTestDb(testDb);
	// clearTestDb leaves monitoring_settings alone
	testDb.db.delete(monitoringSettings).run();
	await resetMonitoringScheduler();
});

afterAll(() => {
	destroyTestDb(testDb);
});

describe('stalled download settings', () => {
	it('reports the defaults the download monitor uses when nothing is saved', async () => {
		const settings = await getMonitoringScheduler().getSettings();

		expect(settings.stalledDownloadTimeoutMinutes).toBe(3 * 24 * 60);
		expect(settings.stalledDownloadProgressTimeoutMinutes).toBe(14 * 24 * 60);
		expect(settings.stalledDownloadProgressThreshold).toBe(1);
		expect(settings.stalledDownloadBlocklistHours).toBe(72);
	});

	it('saves and reads back the timeout for downloads above the threshold', async () => {
		const scheduler = getMonitoringScheduler();
		await scheduler.updateSettings({ stalledDownloadProgressTimeoutMinutes: 2880 });

		expect(await storedValue('stalled_download_progress_timeout_minutes')).toBe('2880');
		expect((await scheduler.getSettings()).stalledDownloadProgressTimeoutMinutes).toBe(2880);
	});

	it('keeps 0 (tier disabled) instead of falling back to the default', async () => {
		const scheduler = getMonitoringScheduler();
		await scheduler.updateSettings({
			stalledDownloadTimeoutMinutes: 0,
			stalledDownloadProgressTimeoutMinutes: 0
		});

		const settings = await scheduler.getSettings();
		expect(settings.stalledDownloadTimeoutMinutes).toBe(0);
		expect(settings.stalledDownloadProgressTimeoutMinutes).toBe(0);
	});

	it('falls back to the defaults for values the monitor would ignore', async () => {
		await testDb.db.insert(monitoringSettings).values([
			{ key: 'stalled_download_timeout_minutes', value: 'abc' },
			{ key: 'stalled_download_progress_timeout_minutes', value: '-5' },
			{ key: 'stalled_download_progress_threshold', value: '150' }
		]);

		const settings = await getMonitoringScheduler().getSettings();
		expect(settings.stalledDownloadTimeoutMinutes).toBe(3 * 24 * 60);
		expect(settings.stalledDownloadProgressTimeoutMinutes).toBe(14 * 24 * 60);
		expect(settings.stalledDownloadProgressThreshold).toBe(1);
	});
});

describe('dead torrent settings', () => {
	it('reports the defaults when nothing is saved', async () => {
		const settings = await getMonitoringScheduler().getSettings();
		expect(settings).toMatchObject({
			deadTorrentEnabled: true,
			deadTorrentGraceMinutes: 60,
			deadTorrentMetadataMinutes: 60,
			deadTorrentNoProgressMinutes: 360,
			deadTorrentStrikes: 3,
			deadTorrentPrivateAction: 'warn'
		});
	});

	it('saves and reads back every field', async () => {
		const scheduler = getMonitoringScheduler();
		await scheduler.updateSettings({
			deadTorrentEnabled: false,
			deadTorrentGraceMinutes: 30,
			deadTorrentMetadataMinutes: 120,
			deadTorrentNoProgressMinutes: 720,
			deadTorrentStrikes: 5,
			deadTorrentPrivateAction: 'remove'
		});

		expect(await storedValue('dead_torrent_enabled')).toBe('false');
		expect(await scheduler.getSettings()).toMatchObject({
			deadTorrentEnabled: false,
			deadTorrentGraceMinutes: 30,
			deadTorrentMetadataMinutes: 120,
			deadTorrentNoProgressMinutes: 720,
			deadTorrentStrikes: 5,
			deadTorrentPrivateAction: 'remove'
		});
	});
});
