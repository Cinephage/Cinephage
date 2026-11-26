/**
 * iCalendar (RFC 5545) serialization for the calendar feed.
 *
 * Hand-written rather than a dependency: the repo already emits XMLTV by hand
 * (`src/routes/api/livetv/epg.xml`), and the parts that decide whether a feed
 * parses at all — octet folding, CRLF, text escaping, exclusive all-day DTEND —
 * are the parts an off-the-shelf builder still gets wrong.
 *
 * Everything here is pure. `feed.ts` owns the database query; the
 * `/api/calendar/feed.ics` route owns transport (auth, ETag, 304).
 */

import { createHash } from 'node:crypto';

export interface CalendarEvent {
	/**
	 * Stable identity, `<type>-<rowId>@cinephage`. It must never contain the
	 * date, or a shifted release shows up as a second event instead of moving.
	 */
	uid: string;
	summary: string;
	description?: string;
	categories?: string[];
	/** Epoch seconds driving DTSTAMP / LAST-MODIFIED / SEQUENCE. 0 when unknown. */
	revision: number;
	/** `YYYY-MM-DD` for an all-day event; a Date for a timed (UTC) event. */
	start: string | Date;
	/** Timed events only; defaults to 60 minutes. */
	durationMinutes?: number;
	/** Minutes before the start; 0/undefined emits no VALARM. */
	alertMinutes?: number;
}

export interface CalendarFeedOptions {
	calendarName: string;
}

const CRLF = '\r\n';
/** RFC 5545 §3.1: content lines SHALL NOT be longer than 75 octets. */
const MAX_LINE_OCTETS = 75;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE_MS = 60_000;

/**
 * Escape TEXT-property characters. Control characters other than newline are
 * dropped: some come out of metadata providers and make clients reject the feed.
 */
export function escapeIcalText(value: string): string {
	return (
		value
			// eslint-disable-next-line no-control-regex
			.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
			.replace(/\\/g, '\\\\')
			.replace(/;/g, '\\;')
			.replace(/,/g, '\\,')
			.replace(/\r\n|\r|\n/g, '\\n')
	);
}

/**
 * Fold one content line at 75 octets. Continuation lines start with a space,
 * and that space counts towards the limit. Iterating by code point keeps a
 * multi-octet character from being split across lines.
 */
export function foldIcalLine(line: string): string {
	const encoder = new TextEncoder();
	const physical: string[] = [];
	let current = '';
	let octets = 0;

	for (const char of line) {
		const size = encoder.encode(char).length;
		if (octets + size > MAX_LINE_OCTETS) {
			physical.push(current);
			current = ' ';
			octets = 1;
		}
		current += char;
		octets += size;
	}

	physical.push(current);
	return physical.join(CRLF);
}

/** `YYYY-MM-DD` → `YYYYMMDD`. Throws only on programmer error. */
export function formatIcalDate(dateISO: string): string {
	if (!DATE_ONLY.test(dateISO)) {
		throw new Error(`Invalid calendar feed date: ${dateISO}`);
	}
	return dateISO.replaceAll('-', '');
}

/** A UTC instant → `YYYYMMDDTHHMMSSZ`. */
export function formatIcalUtc(instant: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return (
		`${instant.getUTCFullYear()}${pad(instant.getUTCMonth() + 1)}${pad(instant.getUTCDate())}` +
		`T${pad(instant.getUTCHours())}${pad(instant.getUTCMinutes())}${pad(instant.getUTCSeconds())}Z`
	);
}

/** `YYYY-MM-DD` plus a whole number of days, in UTC to stay DST-proof. */
function addDays(dateISO: string, days: number): string {
	const [year, month, day] = dateISO.split('-').map(Number);
	const shifted = new Date(Date.UTC(year, month - 1, day + days));
	return shifted.toISOString().slice(0, 10);
}

function startLines(event: CalendarEvent): string[] {
	if (typeof event.start === 'string') {
		// All-day: DTEND is exclusive, so it names the day after.
		return [
			`DTSTART;VALUE=DATE:${formatIcalDate(event.start)}`,
			`DTEND;VALUE=DATE:${formatIcalDate(addDays(event.start, 1))}`
		];
	}

	const duration = (event.durationMinutes ?? 60) * MINUTE_MS;
	return [
		`DTSTART:${formatIcalUtc(event.start)}`,
		`DTEND:${formatIcalUtc(new Date(event.start.getTime() + duration))}`
	];
}

function eventLines(event: CalendarEvent): string[] | null {
	if (typeof event.start === 'string') {
		if (!DATE_ONLY.test(event.start)) return null;
	} else if (Number.isNaN(event.start.getTime())) {
		return null;
	}

	const revision = Number.isFinite(event.revision) ? Math.max(0, Math.trunc(event.revision)) : 0;
	const stamp = formatIcalUtc(new Date(revision * 1000));

	const lines = [
		'BEGIN:VEVENT',
		`UID:${event.uid}`,
		`DTSTAMP:${stamp}`,
		`LAST-MODIFIED:${stamp}`,
		`SEQUENCE:${revision}`,
		...startLines(event),
		`SUMMARY:${escapeIcalText(event.summary)}`,
		'STATUS:CONFIRMED',
		// A release does not block the time: it is an all-day marker, not a meeting.
		'TRANSP:TRANSPARENT'
	];

	if (event.description) {
		lines.push(`DESCRIPTION:${escapeIcalText(event.description)}`);
	}
	if (event.categories && event.categories.length > 0) {
		lines.push(`CATEGORIES:${event.categories.map(escapeIcalText).join(',')}`);
	}
	if (event.alertMinutes && event.alertMinutes > 0) {
		lines.push(
			'BEGIN:VALARM',
			'ACTION:DISPLAY',
			`DESCRIPTION:${escapeIcalText(event.summary)}`,
			`TRIGGER:-PT${Math.trunc(event.alertMinutes)}M`,
			'END:VALARM'
		);
	}

	lines.push('END:VEVENT');
	return lines;
}

/**
 * Build the whole document. Deterministic for the same events: the body is a
 * function of the data alone, which is what makes a strong ETag worth sending.
 */
export function buildCalendarFeed(
	events: readonly CalendarEvent[],
	options: CalendarFeedOptions
): string {
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Cinephage//Calendar Feed 1.0//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		`X-WR-CALNAME:${escapeIcalText(options.calendarName)}`,
		'X-WR-TIMEZONE:UTC',
		// Clients poll on their own timer; tell them once an hour is enough.
		'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
		'X-PUBLISHED-TTL:PT1H'
	];

	for (const event of events) {
		const built = eventLines(event);
		if (built) lines.push(...built);
	}

	lines.push('END:VCALENDAR');
	return lines.map(foldIcalLine).join(CRLF) + CRLF;
}

/** Strong validator over the serialized body. */
export function calendarFeedEtag(body: string): string {
	return `"${createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32)}"`;
}

/** Whether an `If-None-Match` header covers `etag` (weak or strong form). */
export function etagMatches(header: string | null, etag: string): boolean {
	if (!header) return false;
	return header
		.split(',')
		.map((candidate) => candidate.trim().replace(/^W\//, ''))
		.some((candidate) => candidate === etag || candidate === '*');
}
