/**
 * Broadcast-time conversion.
 *
 * TVDB reports an air time as wall clock at the network (`21:00` +
 * `originalNetwork.country`), and `series.air_tz` is resolved from that country.
 * Viewers need the time in *their* zone, so the calendar converts the network
 * wall clock to an instant and formats it locally.
 *
 * No new dependency: `Intl` already knows every offset and DST rule.
 */

const MS_PER_MINUTE = 60_000;

/** Parts of an instant as observed in `timeZone`. */
function zonedParts(instant: Date, timeZone: string): Record<string, number> {
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit'
	});

	const parts: Record<string, number> = {};
	for (const part of formatter.formatToParts(instant)) {
		if (part.type !== 'literal') parts[part.type] = Number(part.value);
	}
	// `hour` can be 24 for midnight in some engines.
	if (parts.hour === 24) parts.hour = 0;
	return parts;
}

/**
 * Wall clock in `timeZone` → the UTC instant it refers to.
 * Returns null for malformed input rather than throwing.
 */
export function zonedWallClockToInstant(
	dateISO: string,
	time: string,
	timeZone: string
): Date | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO) || !/^\d{2}:\d{2}$/.test(time)) return null;

	const [year, month, day] = dateISO.split('-').map(Number);
	const [hour, minute] = time.split(':').map(Number);
	if (hour > 23 || minute > 59) return null;

	const guess = Date.UTC(year, month - 1, day, hour, minute);

	try {
		// Offset of the zone at the guessed instant, then correct once. A second
		// correction handles the rare case where the guess lands on the other
		// side of a DST boundary.
		let instant = guess;
		for (let attempt = 0; attempt < 2; attempt++) {
			const parts = zonedParts(new Date(instant), timeZone);
			const asIfUtc = Date.UTC(
				parts.year,
				parts.month - 1,
				parts.day,
				parts.hour,
				parts.minute
			);
			const offset = asIfUtc - instant;
			if (offset === 0) break;
			instant = guess - offset;
		}
		return new Date(instant);
	} catch {
		return null;
	}
}

/**
 * Format the air time in the viewer's own timezone. Returns null when the
 * schedule or zone is missing, so callers can omit the label entirely.
 */
export function formatLocalAirTime(
	dateISO: string | null | undefined,
	time: string | null | undefined,
	timeZone: string | null | undefined,
	locale?: string
): string | null {
	if (!dateISO || !time || !timeZone) return null;

	const instant = zonedWallClockToInstant(dateISO, time, timeZone);
	if (!instant) return null;

	return new Intl.DateTimeFormat(locale, {
		hour: '2-digit',
		minute: '2-digit'
	}).format(instant);
}

/** Tooltip-friendly description of the original broadcast time. */
export function describeNetworkAirtime(
	time: string | null | undefined,
	timeZone: string | null | undefined
): string | undefined {
	if (!time || !timeZone) return undefined;
	return `${time} (${timeZone})`;
}

/**
 * Local time plus a day marker when the broadcast lands on a different calendar
 * day for the viewer than it did at the network — `03:00 (+1d)`.
 *
 * The calendar groups episodes by their air *date*, which is the network's date.
 * A 22:00 ET broadcast is 03:00 the next morning in London, and silently showing
 * "03:00" next to the previous day reads like a bug.
 */
export function localAirTimeLabel(
	dateISO: string | null | undefined,
	time: string | null | undefined,
	timeZone: string | null | undefined,
	locale?: string,
	/** Defaults to the runtime zone; explicit for tests and server-side callers. */
	viewerTimeZone?: string
): string | null {
	if (!dateISO || !time || !timeZone) return null;

	const instant = zonedWallClockToInstant(dateISO, time, timeZone);
	if (!instant) return null;

	const formatted = new Intl.DateTimeFormat(locale, {
		hour: '2-digit',
		minute: '2-digit',
		timeZone: viewerTimeZone
	}).format(instant);

	const viewerDateParts = new Intl.DateTimeFormat('en-US', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: viewerTimeZone
	}).formatToParts(instant);
	const part = (type: string) => viewerDateParts.find((p) => p.type === type)?.value ?? '';
	const viewerDate = `${part('year')}-${part('month')}-${part('day')}`;

	const delta = daysBetween(dateISO, viewerDate);
	if (delta === 0) return formatted;
	return `${formatted} (${delta > 0 ? '+' : ''}${delta}d)`;
}

function daysBetween(fromISO: string, toISO: string): number {
	const from = Date.parse(`${fromISO}T00:00:00Z`);
	const to = Date.parse(`${toISO}T00:00:00Z`);
	if (Number.isNaN(from) || Number.isNaN(to)) return 0;
	return Math.round((to - from) / 86_400_000);
}
