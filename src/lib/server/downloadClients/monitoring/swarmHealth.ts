/**
 * Dead-torrent detection: decides, from what the download client reports,
 * whether a torrent's swarm can still finish it.
 *
 * A torrent is dead when, after a grace period from being added, either
 * - it is still fetching metadata after `metadataMinutes`, or
 * - its downloaded bytes have not gone up for `noProgressMinutes` AND the
 *   connected swarm cannot finish it: less than one full copy available, or
 *   no seeds connected;
 * on `strikes` consecutive checks spaced `DEAD_TORRENT_CHECK_INTERVAL_MINUTES`
 * apart. One bad reading never kills a torrent.
 *
 * A slow swarm that still has a full copy is never dead here, whatever its
 * progress percentage: it is left to the long stalled timeouts.
 *
 * Pure function: the caller stores the returned state on the queue row, so
 * the clock and strikes survive a restart.
 */
import type { SwarmHealth } from '#lib/types/queue.js';
import type { DownloadInfo } from '../core/interfaces.js';
import {
	DEAD_TORRENT_CHECK_INTERVAL_MINUTES,
	type DeadTorrentSettingValues
} from './stalledDownloadDefaults.js';

export type DeadTorrentSettings = DeadTorrentSettingValues;

const MINUTE = 60_000;

/** Client states in which the torrent is trying to download. */
function isTryingToDownload(download: DownloadInfo): boolean {
	return (
		(download.status === 'downloading' || download.status === 'stalled') && download.progress < 1
	);
}

function downloadedBytesOf(download: DownloadInfo): number {
	if (typeof download.downloadedBytes === 'number' && download.downloadedBytes >= 0) {
		return download.downloadedBytes;
	}
	return Math.max(0, Math.round(download.progress * (download.size || 0)));
}

function minutesSince(iso: string | null | undefined, now: number): number {
	if (!iso) return 0;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? (now - t) / MINUTE : 0;
}

export interface SwarmAssessment {
	/** The state to store, or null to clear it */
	next: SwarmHealth | null;
	/** Whether `next` differs enough from the stored state to be written */
	write: boolean;
}

/**
 * Assess one torrent.
 *
 * @param previous state stored on the queue row (null on first sight)
 * @param download what the client reports now
 * @param addedAt when the torrent was grabbed (queue row `addedAt`)
 */
export function assessSwarmHealth(
	previous: SwarmHealth | null,
	download: DownloadInfo,
	addedAt: string | null,
	settings: DeadTorrentSettings,
	now: number = Date.now()
): SwarmAssessment {
	const nowIso = new Date(now).toISOString();
	const bytes = downloadedBytesOf(download);

	const signals = {
		seeds: typeof download.connectedSeeds === 'number' ? download.connectedSeeds : null,
		peers: typeof download.connectedPeers === 'number' ? download.connectedPeers : null,
		availability:
			typeof download.availability === 'number' && download.availability >= 0
				? download.availability
				: null,
		isPrivate: typeof download.isPrivate === 'boolean' ? download.isPrivate : null
	};

	if (!settings.enabled) {
		return { next: null, write: previous !== null };
	}

	// Paused, queued by the client, checking, seeding or done: the swarm is not
	// being asked for anything, so neither the no-progress clock nor the strikes
	// may run. Restart the clock (at most once per check interval, to avoid a
	// write on every poll) so time spent paused never counts against it.
	if (!isTryingToDownload(download)) {
		if (!previous) return { next: null, write: false };
		const due =
			minutesSince(previous.checkedAt, now) >= DEAD_TORRENT_CHECK_INTERVAL_MINUTES ||
			previous.strikes > 0 ||
			previous.dead;
		if (!due) return { next: previous, write: false };
		return {
			next: {
				...previous,
				...signals,
				checkedAt: nowIso,
				progressBytes: bytes,
				progressAt: nowIso,
				problem: null,
				strikes: 0,
				strikesNeeded: settings.strikes,
				dead: false
			},
			write: true
		};
	}

	// First sight: start tracking. Progress is measured from here.
	if (!previous) {
		return {
			next: {
				...signals,
				checkedAt: nowIso,
				progressBytes: bytes,
				progressAt: nowIso,
				problem: null,
				strikes: 0,
				strikesNeeded: settings.strikes,
				dead: false
			},
			write: true
		};
	}

	const progressed = bytes > previous.progressBytes;
	const progressBytes = progressed ? bytes : previous.progressBytes;
	const progressAt = progressed ? nowIso : previous.progressAt;

	// Checks are spaced so N strikes mean N readings over tens of minutes, not
	// N polls a few seconds apart. Between checks only real progress is worth a
	// write, and only when it clears a strike.
	if (minutesSince(previous.checkedAt, now) < DEAD_TORRENT_CHECK_INTERVAL_MINUTES) {
		if (progressed && previous.strikes > 0) {
			return {
				next: {
					...previous,
					...signals,
					progressBytes,
					progressAt,
					problem: null,
					strikes: 0,
					dead: false
				},
				write: true
			};
		}
		return { next: previous, write: false };
	}

	const age = minutesSince(addedAt ?? previous.progressAt, now);
	let problem: SwarmHealth['problem'] = null;
	if (age >= settings.graceMinutes) {
		if (download.metadataPending) {
			if (age >= settings.metadataMinutes) problem = 'metadata';
		} else if (minutesSince(progressAt, now) >= settings.noProgressMinutes) {
			const lacksFullCopy = signals.availability !== null && signals.availability < 1;
			const noSeeds = signals.seeds === 0;
			if (lacksFullCopy || noSeeds) problem = 'no_source';
		}
	}

	const strikes = problem ? previous.strikes + 1 : 0;
	return {
		next: {
			...signals,
			checkedAt: nowIso,
			progressBytes,
			progressAt,
			problem,
			strikes,
			strikesNeeded: settings.strikes,
			dead: problem !== null && strikes >= settings.strikes
		},
		write: true
	};
}

function formatMinutes(minutes: number): string {
	const m = Math.max(0, Math.round(minutes));
	if (m >= 24 * 60) {
		const d = Math.floor(m / (24 * 60));
		const h = Math.floor((m % (24 * 60)) / 60);
		return h > 0 ? `${d}d ${h}h` : `${d}d`;
	}
	if (m >= 60) {
		const h = Math.floor(m / 60);
		const rest = m % 60;
		return rest > 0 ? `${h}h ${rest}m` : `${h}h`;
	}
	return `${m}m`;
}

/**
 * One-line English explanation for logs, history and the failure message,
 * e.g. "no seeds, 6.5% available, no progress for 6h".
 */
export function describeSwarmProblem(
	health: SwarmHealth,
	addedAt: string | null,
	now: number = Date.now()
): string {
	if (health.problem === 'metadata') {
		return `stuck fetching metadata for ${formatMinutes(minutesSince(addedAt ?? health.progressAt, now))}`;
	}
	const parts: string[] = [];
	if (health.seeds === 0) parts.push('no seeds');
	if (health.availability !== null) {
		parts.push(`${(health.availability * 100).toFixed(1).replace(/\.0$/, '')}% available`);
	}
	parts.push(`no progress for ${formatMinutes(minutesSince(health.progressAt, now))}`);
	return parts.join(', ');
}
