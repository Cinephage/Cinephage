/**
 * Defaults for stalled download handling, shared by the download monitor (which
 * acts on them) and the monitoring settings API (which shows them in the UI).
 * Keeping them in one place stops the settings page from showing a value the
 * monitor does not actually use when nothing has been saved yet.
 */
export const STALLED_DOWNLOAD_DEFAULTS = {
	/**
	 * Timeout (minutes) for downloads at or below the progress threshold. 3 days:
	 * stalling is normal - torrents routinely resume when a seeder returns.
	 */
	timeoutMinutes: 3 * 24 * 60,
	/** Timeout (minutes) for downloads above the progress threshold: 14 days. */
	progressTimeoutMinutes: 14 * 24 * 60,
	/** Progress threshold (%) that separates the two timeouts. */
	progressThreshold: 1,
	/** Blocklist duration (hours) for an auto-removed release; 0 = permanent. */
	blocklistHours: 72
} as const;

/**
 * Parse a stored stalled-download setting. Returns the fallback when the value
 * is missing, not a number, negative, or above `max` - the same rules the
 * download monitor applies, so the UI and the monitor always agree.
 */
export function parseStalledSetting(
	raw: string | null | undefined,
	fallback: number,
	max = Number.POSITIVE_INFINITY
): number {
	if (raw === null || raw === undefined) return fallback;
	const value = parseFloat(raw);
	return Number.isFinite(value) && value >= 0 && value <= max ? value : fallback;
}

/** What to do with a dead torrent from a private tracker. */
export type DeadTorrentPrivateAction = 'warn' | 'remove';

/**
 * Defaults for dead-torrent detection: a torrent whose swarm cannot finish it
 * is failed, blocklisted and searched again after hours instead of days.
 */
export const DEAD_TORRENT_DEFAULTS = {
	enabled: true,
	/** No verdict in the first hour after the torrent was added. */
	graceMinutes: 60,
	/** A magnet still fetching metadata after this long is dead. */
	metadataMinutes: 60,
	/**
	 * No downloaded bytes for this long, while the connected swarm has less
	 * than one full copy or no seeds, is dead.
	 */
	noProgressMinutes: 6 * 60,
	/** Consecutive bad checks (about 10 minutes apart) before acting. */
	strikes: 3,
	/** Private trackers punish leaving early (hit and run): only warn. */
	privateAction: 'warn' as DeadTorrentPrivateAction
};

/** Minutes between two dead-torrent checks of the same torrent. */
export const DEAD_TORRENT_CHECK_INTERVAL_MINUTES = 10;

/** At most one automatic search per movie or episode in this window. */
export const DEAD_TORRENT_RESEARCH_WINDOW_HOURS = 24;

/** Dead-torrent settings as stored in monitoring_settings. */
export const DEAD_TORRENT_SETTING_KEYS = {
	enabled: 'dead_torrent_enabled',
	graceMinutes: 'dead_torrent_grace_minutes',
	metadataMinutes: 'dead_torrent_metadata_minutes',
	noProgressMinutes: 'dead_torrent_no_progress_minutes',
	strikes: 'dead_torrent_strikes',
	privateAction: 'dead_torrent_private_action'
} as const;

export interface DeadTorrentSettingValues {
	enabled: boolean;
	graceMinutes: number;
	metadataMinutes: number;
	noProgressMinutes: number;
	strikes: number;
	privateAction: DeadTorrentPrivateAction;
}

/**
 * Read the dead-torrent settings from stored key/values, falling back to the
 * defaults for anything missing or invalid. Shared by the download monitor and
 * the settings API so both always agree.
 */
export function parseDeadTorrentSettings(
	get: (key: string) => string | null | undefined
): DeadTorrentSettingValues {
	const d = DEAD_TORRENT_DEFAULTS;
	const k = DEAD_TORRENT_SETTING_KEYS;
	return {
		enabled: get(k.enabled) !== 'false',
		graceMinutes: parseStalledSetting(get(k.graceMinutes), d.graceMinutes),
		metadataMinutes: parseStalledSetting(get(k.metadataMinutes), d.metadataMinutes),
		noProgressMinutes: parseStalledSetting(get(k.noProgressMinutes), d.noProgressMinutes),
		strikes: Math.max(1, Math.round(parseStalledSetting(get(k.strikes), d.strikes))),
		privateAction: get(k.privateAction) === 'remove' ? 'remove' : 'warn'
	};
}
