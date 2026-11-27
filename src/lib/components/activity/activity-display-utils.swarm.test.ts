import { describe, expect, it } from 'vitest';
import type { SwarmHealth } from '#lib/types/queue.js';
import { canFailAndSearch, describeSwarmHealth } from './activity-display-utils.js';

const NOW = Date.parse('2026-11-01T06:20:00.000Z');

function health(overrides: Partial<SwarmHealth> = {}): SwarmHealth {
	return {
		checkedAt: '2026-11-01T06:18:00.000Z',
		progressBytes: 65,
		progressAt: '2026-11-01T00:00:00.000Z',
		seeds: 0,
		peers: 1,
		availability: 0.065,
		isPrivate: false,
		problem: 'no_source',
		strikes: 2,
		strikesNeeded: 3,
		dead: false,
		...overrides
	};
}

describe('describeSwarmHealth', () => {
	it('explains a torrent the check is counting down on', () => {
		expect(
			describeSwarmHealth({ swarmHealth: health(), startedAt: '2026-11-01T00:00:00.000Z' }, NOW)
				?.text
		).toBe('No seeds, 6.5% available, 6h 20m without progress · check 2 of 3');
	});

	it('says a dead private-tracker torrent is kept on purpose', () => {
		const result = describeSwarmHealth(
			{
				swarmHealth: health({ problem: 'metadata', dead: true, strikes: 3, isPrivate: true }),
				startedAt: '2026-11-01T04:40:00.000Z'
			},
			NOW
		);
		expect(result).toEqual({
			text: 'Stuck fetching metadata for 1h 40m · dead, kept because it is from a private tracker',
			dead: true,
			keptPrivate: true
		});
	});

	it('shows nothing when the last check found no problem', () => {
		expect(
			describeSwarmHealth({
				swarmHealth: health({ problem: null, strikes: 0 }),
				startedAt: '2026-11-01T00:00:00.000Z'
			})
		).toBeNull();
		expect(describeSwarmHealth({ startedAt: '2026-11-01T00:00:00.000Z' })).toBeNull();
	});
});

describe('canFailAndSearch', () => {
	it('offers the action for torrents still trying to download', () => {
		for (const queueStatus of ['queued', 'downloading', 'stalled', 'paused']) {
			expect(canFailAndSearch({ queueItemId: 'q', protocol: 'torrent', queueStatus })).toBe(true);
		}
	});

	it('does not offer it for finished, failed or non-torrent downloads', () => {
		expect(
			canFailAndSearch({ queueItemId: 'q', protocol: 'torrent', queueStatus: 'seeding' })
		).toBe(false);
		expect(canFailAndSearch({ queueItemId: 'q', protocol: 'torrent', queueStatus: 'failed' })).toBe(
			false
		);
		expect(canFailAndSearch({ queueItemId: 'q', protocol: 'usenet', queueStatus: 'stalled' })).toBe(
			false
		);
		expect(canFailAndSearch({ protocol: 'torrent', queueStatus: 'stalled' })).toBe(false);
	});
});
