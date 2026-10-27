/**
 * A manual-import history row (no download client involved) previously got
 * tagged "Download" purely because its activitySource was 'download_history'
 * - so a successful manual import showed "Download Imported", implying a
 * download client triggered it. Only a real client-backed row should get
 * the "Download" category tag.
 */

import { describe, expect, it } from 'vitest';
import { getCompactStatusLabel } from './activity-display-utils.js';
import type { UnifiedActivity } from '#lib/types/activity.js';

const baseActivity: UnifiedActivity = {
	id: 'activity-1',
	activitySource: 'download_history',
	mediaType: 'movie',
	mediaId: 'movie-1',
	mediaTitle: 'The Matrix',
	mediaYear: 1999,
	releaseTitle: 'The.Matrix.1999.1080p.BluRay',
	quality: null,
	releaseGroup: null,
	size: 1_000_000,
	indexerId: null,
	indexerName: null,
	protocol: null,
	status: 'imported',
	isUpgrade: false,
	timeline: [],
	startedAt: new Date().toISOString(),
	completedAt: null
};

describe('getCompactStatusLabel', () => {
	it('tags a real client-backed download history row as "Download Imported"', () => {
		const label = getCompactStatusLabel(
			{ ...baseActivity, downloadClientId: 'client-1', downloadClientName: 'qBittorrent' },
			'Imported'
		);
		expect(label).toBe('Download Imported');
	});

	it('does not tag a manual-import history row (no download client) as a Download', () => {
		const label = getCompactStatusLabel(
			{ ...baseActivity, downloadClientId: null, downloadClientName: 'Manual Import' },
			'Imported'
		);
		expect(label).toBe('Imported');
	});
});
