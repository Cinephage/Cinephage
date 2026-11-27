import { describe, it, expect } from 'vitest';
import type { DownloadInfo } from '../core/interfaces.js';
import type { SwarmHealth } from '#lib/types/queue.js';
import {
	assessSwarmHealth,
	describeSwarmProblem,
	type DeadTorrentSettings
} from './swarmHealth.js';
import { DEAD_TORRENT_DEFAULTS } from './stalledDownloadDefaults.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const ADDED = new Date(T0).toISOString();
const SETTINGS: DeadTorrentSettings = { ...DEAD_TORRENT_DEFAULTS };

function torrent(overrides: Partial<DownloadInfo> = {}): DownloadInfo {
	return {
		id: 'h',
		name: 'Some.Release',
		hash: 'h',
		progress: 0.065,
		status: 'stalled',
		size: 1000,
		downloadSpeed: 0,
		uploadSpeed: 0,
		savePath: '/d',
		contentPath: '/d/x',
		canMoveFiles: false,
		canBeRemoved: false,
		downloadedBytes: 65,
		connectedSeeds: 0,
		connectedPeers: 1,
		availability: 0.065,
		metadataPending: false,
		isPrivate: false,
		...overrides
	};
}

/**
 * Poll the same torrent every `stepMs` from `from` to `to`, feeding each
 * stored state into the next call, the way the monitor does.
 */
function run(
	from: number,
	to: number,
	stepMs: number,
	at: (now: number) => DownloadInfo,
	settings: DeadTorrentSettings = SETTINGS,
	start: SwarmHealth | null = null
): SwarmHealth | null {
	let state = start;
	for (let now = from; now <= to; now += stepMs) {
		const r = assessSwarmHealth(state, at(now), ADDED, settings, now);
		if (r.write) state = r.next;
	}
	return state;
}

describe('assessSwarmHealth', () => {
	it('kills a torrent with no seeds and 6.5% availability after 6h without progress and 3 checks', () => {
		const before = run(T0, T0 + 6 * HOUR + 10 * MIN, 5 * MIN, () => torrent());
		expect(before?.problem).toBe('no_source');
		expect(before?.dead).toBe(false);

		const after = run(
			T0 + 6 * HOUR + 15 * MIN,
			T0 + 6 * HOUR + 40 * MIN,
			5 * MIN,
			() => torrent(),
			SETTINGS,
			before
		);
		expect(after?.dead).toBe(true);
		expect(after?.strikes).toBeGreaterThanOrEqual(3);
	});

	it('does not drop a slow but complete swarm, however long it takes', () => {
		// Full copy available, a seed connected, and not one byte in 2 days.
		const state = run(T0, T0 + 48 * HOUR, 5 * MIN, () =>
			torrent({ availability: 1.4, connectedSeeds: 1 })
		);
		expect(state?.problem).toBeNull();
		expect(state?.dead).toBe(false);
	});

	it('does not drop a torrent that keeps downloading, even with availability below 1', () => {
		const state = run(T0, T0 + 24 * HOUR, 5 * MIN, (now) => {
			const bytes = 65 + Math.floor((now - T0) / HOUR); // one byte an hour
			return torrent({ downloadedBytes: bytes, progress: bytes / 1000 });
		});
		expect(state?.problem).toBeNull();
		expect(state?.dead).toBe(false);
	});

	it('judges by downloaded bytes, not upload activity', () => {
		const state = run(T0, T0 + 7 * HOUR, 5 * MIN, () =>
			torrent({ uploadSpeed: 50_000, status: 'downloading' })
		);
		expect(state?.dead).toBe(true);
	});

	it('kills a magnet still fetching metadata after 1h, after 3 checks', () => {
		const meta = () =>
			torrent({
				metadataPending: true,
				size: 0,
				progress: 0,
				downloadedBytes: 0,
				availability: undefined,
				connectedSeeds: 0
			});
		expect(run(T0, T0 + 55 * MIN, 5 * MIN, meta)?.dead).toBe(false);
		const state = run(T0, T0 + 90 * MIN, 5 * MIN, meta);
		expect(state?.problem).toBe('metadata');
		expect(state?.dead).toBe(true);
	});

	it('gives no verdict inside the grace period', () => {
		const state = run(T0, T0 + 55 * MIN, 5 * MIN, () => torrent(), {
			...SETTINGS,
			noProgressMinutes: 0
		});
		expect(state?.strikes).toBe(0);
	});

	it('needs consecutive bad checks: one good reading resets the strikes', () => {
		let state = run(T0, T0 + 6 * HOUR + 10 * MIN, 10 * MIN, () => torrent());
		expect(state?.strikes).toBe(2);
		// A seed shows up with a full copy for one check.
		state = assessSwarmHealth(
			state,
			torrent({ connectedSeeds: 1, availability: 1 }),
			ADDED,
			SETTINGS,
			T0 + 6 * HOUR + 30 * MIN
		).next;
		expect(state?.strikes).toBe(0);
		expect(state?.dead).toBe(false);
	});

	it('spaces checks: polling every 5 s does not stack strikes', () => {
		const start = run(T0, T0 + 6 * HOUR, 10 * MIN, () => torrent());
		const state = run(
			T0 + 6 * HOUR + 5_000,
			T0 + 6 * HOUR + 5 * MIN,
			5_000,
			() => torrent(),
			SETTINGS,
			start
		);
		expect(state?.strikes).toBe(start?.strikes);
	});

	it('does not count time while the torrent is paused or queued by the client', () => {
		let state = run(T0, T0 + 2 * HOUR, 10 * MIN, () => torrent());
		state = run(
			T0 + 2 * HOUR + 10 * MIN,
			T0 + 10 * HOUR,
			10 * MIN,
			() => torrent({ status: 'paused' }),
			SETTINGS,
			state
		);
		state = run(
			T0 + 10 * HOUR + 10 * MIN,
			T0 + 11 * HOUR,
			10 * MIN,
			() => torrent(),
			SETTINGS,
			state
		);
		expect(state?.problem).toBeNull();
		expect(state?.dead).toBe(false);
	});

	it('does not judge when the client reports neither seeds nor availability', () => {
		const state = run(T0, T0 + 24 * HOUR, 10 * MIN, () =>
			torrent({ connectedSeeds: undefined, availability: undefined })
		);
		expect(state?.dead).toBe(false);
	});

	it('treats an unknown availability (-1) as unknown, not as zero', () => {
		const state = run(T0, T0 + 24 * HOUR, 10 * MIN, () =>
			torrent({ availability: -1, connectedSeeds: 2 })
		);
		expect(state?.dead).toBe(false);
	});

	it('does nothing when disabled, and clears a stored state', () => {
		const disabled = { ...SETTINGS, enabled: false };
		expect(assessSwarmHealth(null, torrent(), ADDED, disabled, T0)).toEqual({
			next: null,
			write: false
		});
		const stored = run(T0, T0 + HOUR, 10 * MIN, () => torrent());
		expect(assessSwarmHealth(stored, torrent(), ADDED, disabled, T0 + 2 * HOUR)).toEqual({
			next: null,
			write: true
		});
	});

	it('survives a restart: the stored clock keeps running', () => {
		// The monitor stores the state on the queue row; a new process reads it back.
		const stored = JSON.parse(
			JSON.stringify(run(T0, T0 + 6 * HOUR + 10 * MIN, 10 * MIN, () => torrent()))
		);
		expect(stored.strikes).toBe(2);
		expect(stored.dead).toBe(false);
		const state = run(
			T0 + 6 * HOUR + 20 * MIN,
			T0 + 6 * HOUR + 20 * MIN,
			1,
			() => torrent(),
			SETTINGS,
			stored
		);
		expect(state?.dead).toBe(true);
	});
});

describe('describeSwarmProblem', () => {
	it('names seeds, availability and the time without progress', () => {
		const state = run(T0, T0 + 6 * HOUR + 40 * MIN, 10 * MIN, () => torrent())!;
		expect(describeSwarmProblem(state, ADDED, T0 + 6 * HOUR + 40 * MIN)).toBe(
			'no seeds, 6.5% available, no progress for 6h 40m'
		);
	});
});
