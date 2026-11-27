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
