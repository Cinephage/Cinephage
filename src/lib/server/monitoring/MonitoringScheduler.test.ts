import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MonitoringSettings } from './MonitoringScheduler';

const { executeMissingContentTaskMock, executeUpgradeMonitorTaskMock, executeCutoffUnmetTaskMock } =
	vi.hoisted(() => ({
		executeMissingContentTaskMock: vi.fn(),
		executeUpgradeMonitorTaskMock: vi.fn(),
		executeCutoffUnmetTaskMock: vi.fn()
	}));

vi.mock('./tasks/MissingContentTask.js', () => ({
	executeMissingContentTask: executeMissingContentTaskMock
}));

vi.mock('./tasks/UpgradeMonitorTask.js', () => ({
	executeUpgradeMonitorTask: executeUpgradeMonitorTaskMock
}));

vi.mock('./tasks/CutoffUnmetTask.js', () => ({
	executeCutoffUnmetTask: executeCutoffUnmetTaskMock
}));

const { getMonitoringScheduler, resetMonitoringScheduler } =
	await import('./MonitoringScheduler.js');

const settings: MonitoringSettings = {
	missingSearchIntervalHours: 6,
	upgradeSearchIntervalHours: 18,
	newEpisodeCheckIntervalHours: 1,
	cutoffUnmetSearchIntervalHours: 9,
	autoReplaceEnabled: true,
	searchOnMonitorEnabled: true,
	missingSubtitlesIntervalHours: 6,
	subtitleUpgradeIntervalHours: 24,
	subtitleSearchOnImportEnabled: true,
	subtitleSearchTrigger: 'immediate',
	stalledDownloadTimeoutMinutes: 60,
	stalledDownloadProgressThreshold: 0,
	stalledDownloadBlocklistHours: 72
};

const baseResult = {
	itemsProcessed: 0,
	itemsGrabbed: 0,
	errors: 0,
	executedAt: new Date('2026-02-20T00:00:00.000Z')
};

beforeEach(async () => {
	await resetMonitoringScheduler();
	vi.clearAllMocks();

	executeMissingContentTaskMock.mockResolvedValue({ taskType: 'missing', ...baseResult });
	executeUpgradeMonitorTaskMock.mockResolvedValue({ taskType: 'upgrade', ...baseResult });
	executeCutoffUnmetTaskMock.mockResolvedValue({ taskType: 'cutoff_unmet', ...baseResult });
});

describe('MonitoringScheduler cooldown propagation', () => {
	it('passes task interval as cooldown for automatic search tasks', async () => {
		const scheduler = getMonitoringScheduler();
		vi.spyOn(scheduler, 'getSettings').mockResolvedValue(settings);
		// @ts-expect-error accessing private method for testing
		const runTask = scheduler.runTask.bind(scheduler);

		await runTask('missing', null, 'automatic');
		await runTask('upgrade', null, 'automatic');
		await runTask('cutoffUnmet', null, 'automatic');

		expect(executeMissingContentTaskMock).toHaveBeenCalledWith(null, {
			ignoreCooldown: false,
			cooldownHours: settings.missingSearchIntervalHours
		});
		expect(executeUpgradeMonitorTaskMock).toHaveBeenCalledWith(null, {
			ignoreCooldown: false,
			cooldownHours: settings.upgradeSearchIntervalHours
		});
		expect(executeCutoffUnmetTaskMock).toHaveBeenCalledWith(null, {
			ignoreCooldown: false,
			cooldownHours: settings.cutoffUnmetSearchIntervalHours
		});
	});

	it('bypasses cooldown for manual runs while preserving interval-derived cooldownHours', async () => {
		const scheduler = getMonitoringScheduler();
		vi.spyOn(scheduler, 'getSettings').mockResolvedValue(settings);
		// @ts-expect-error accessing private method for testing
		const runTask = scheduler.runTask.bind(scheduler);

		await runTask('missing', null, 'manual');
		await runTask('upgrade', null, 'manual');
		await runTask('cutoffUnmet', null, 'manual');

		expect(executeMissingContentTaskMock).toHaveBeenCalledWith(null, {
			ignoreCooldown: true,
			cooldownHours: settings.missingSearchIntervalHours
		});
		expect(executeUpgradeMonitorTaskMock).toHaveBeenCalledWith(null, {
			ignoreCooldown: true,
			cooldownHours: settings.upgradeSearchIntervalHours
		});
		expect(executeCutoffUnmetTaskMock).toHaveBeenCalledWith(null, {
			ignoreCooldown: true,
			cooldownHours: settings.cutoffUnmetSearchIntervalHours
		});
	});
});

describe('MonitoringScheduler.getStatus', () => {
	it('reports a defined status for every task, including hyphenated ids', async () => {
		const scheduler = getMonitoringScheduler();
		vi.spyOn(scheduler, 'getSettings').mockResolvedValue(settings);

		const status = await scheduler.getStatus();

		// Regression guard: the returned object's keys must exactly match the
		// UnifiedTaskRegistry ids used everywhere else (taskIntervals,
		// lastRunTimes, the runTask switch). A camelCase key here (e.g.
		// libraryReconcile instead of 'library-reconcile') type-checks fine on
		// its own but makes /api/tasks's `monitoringStatus.tasks[def.id]` lookup
		// silently return undefined at runtime, showing "Never"/"-" in the UI
		// even though the task is actually running on schedule.
		expect(status.tasks['library-reconcile']).toBeDefined();
		expect(status.tasks['metadata-refresh']).toBeDefined();
		for (const [taskType, taskStatus] of Object.entries(status.tasks)) {
			expect(taskStatus, `status.tasks['${taskType}'] should be defined`).toBeDefined();
			expect(typeof taskStatus.intervalHours).toBe('number');
		}
	});
});
