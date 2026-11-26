import { describe, it, expect } from 'vitest';
import {
	buildCalendarFeed,
	calendarFeedEtag,
	escapeIcalText,
	etagMatches,
	foldIcalLine,
	formatIcalDate,
	formatIcalUtc,
	type CalendarEvent
} from './ical.js';

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
	return {
		uid: 'movie-abc@cinephage',
		summary: 'Blade Runner (1982)',
		revision: 1_790_000_000,
		start: '2026-12-01',
		...overrides
	};
}

function physicalLines(body: string): string[] {
	return body.split('\r\n').filter(Boolean);
}

describe('escapeIcalText', () => {
	it('escapes backslashes, separators and newlines', () => {
		expect(escapeIcalText('a\\b;c,d')).toBe('a\\\\b\\;c\\,d');
		expect(escapeIcalText('line one\nline two')).toBe('line one\\nline two');
	});

	it('drops control characters that make clients reject the feed', () => {
		expect(escapeIcalText('ok\u0001still ok')).toBe('okstill ok');
	});
});

describe('foldIcalLine', () => {
	it('leaves a short line alone', () => {
		expect(foldIcalLine('SUMMARY:short')).toBe('SUMMARY:short');
	});

	it('folds every physical line to 75 octets or fewer', () => {
		const folded = foldIcalLine(`SUMMARY:${'Long title '.repeat(20)}`);
		const encoder = new TextEncoder();
		for (const line of folded.split('\r\n')) {
			expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
		}
	});

	it('continues with a leading space and rejoins to the original', () => {
		const original = `DESCRIPTION:${'word '.repeat(40).trim()}`;
		const folded = foldIcalLine(original);
		expect(folded).toContain('\r\n ');

		const rejoined = folded
			.split('\r\n')
			.map((line, index) => (index === 0 ? line : line.slice(1)))
			.join('');
		expect(rejoined).toBe(original);
	});

	it('never splits a multi-octet character', () => {
		const original = `SUMMARY:${'\u{1F3AC}'.repeat(40)}`;
		const folded = foldIcalLine(original);
		expect(folded).not.toContain('\uFFFD');
		expect(folded.replaceAll('\r\n ', '')).toBe(original);
	});
});

describe('date formatting', () => {
	it('formats an all-day date', () => {
		expect(formatIcalDate('2026-12-01')).toBe('20261201');
	});

	it('formats a UTC instant', () => {
		expect(formatIcalUtc(new Date(Date.UTC(2026, 11, 1, 18, 5, 9)))).toBe('20261201T180509Z');
	});

	it('rejects a partial date instead of emitting a broken property', () => {
		expect(() => formatIcalDate('2026-12')).toThrow();
	});
});

describe('buildCalendarFeed', () => {
	it('produces a CRLF document with the required calendar properties', () => {
		const body = buildCalendarFeed([], { calendarName: 'Cinephage - jane' });

		expect(body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
		expect(body.endsWith('END:VCALENDAR\r\n')).toBe(true);
		expect(body).toContain('VERSION:2.0');
		expect(body).toContain('CALSCALE:GREGORIAN');
		expect(body).toContain('X-WR-CALNAME:Cinephage - jane');
		// Never a bare LF: some clients silently truncate the feed on one.
		expect(body.replaceAll('\r\n', '')).not.toContain('\n');
	});

	it('emits an all-day event with an exclusive DTEND', () => {
		const body = buildCalendarFeed([event()], { calendarName: 'feed' });

		expect(body).toContain('UID:movie-abc@cinephage');
		expect(body).toContain('DTSTART;VALUE=DATE:20261201');
		expect(body).toContain('DTEND;VALUE=DATE:20261202');
	});

	it('emits a timed event in UTC with its duration', () => {
		const body = buildCalendarFeed(
			[event({ start: new Date(Date.UTC(2026, 11, 1, 23, 0)), durationMinutes: 45 })],
			{ calendarName: 'feed' }
		);

		expect(body).toContain('DTSTART:20261201T230000Z');
		expect(body).toContain('DTEND:20261201T234500Z');
	});

	it('keeps the UID stable and the revision in SEQUENCE', () => {
		const first = buildCalendarFeed([event()], { calendarName: 'feed' });
		const moved = buildCalendarFeed([event({ start: '2026-12-08' })], { calendarName: 'feed' });

		expect(first).toContain('UID:movie-abc@cinephage');
		expect(moved).toContain('UID:movie-abc@cinephage');
		expect(first).toContain('SEQUENCE:1790000000');
	});

	it('adds a display alarm only when a lead time is set', () => {
		const without = buildCalendarFeed([event()], { calendarName: 'feed' });
		const withAlarm = buildCalendarFeed([event({ alertMinutes: 90 })], { calendarName: 'feed' });

		expect(without).not.toContain('BEGIN:VALARM');
		expect(withAlarm).toContain('BEGIN:VALARM');
		expect(withAlarm).toContain('TRIGGER:-PT90M');
		expect(withAlarm).toContain('END:VALARM');
	});

	it('skips a malformed event rather than poisoning the whole feed', () => {
		const body = buildCalendarFeed([event({ start: '2026-12' }), event({ uid: 'ok@cinephage' })], {
			calendarName: 'feed'
		});

		expect(body).not.toContain('UID:movie-abc@cinephage');
		expect(body).toContain('UID:ok@cinephage');
	});
});

describe('ETag', () => {
	it('is deterministic for the same events', () => {
		const a = buildCalendarFeed([event()], { calendarName: 'feed' });
		const b = buildCalendarFeed([event()], { calendarName: 'feed' });
		expect(calendarFeedEtag(a)).toBe(calendarFeedEtag(b));
	});

	it('changes when an event changes', () => {
		const a = buildCalendarFeed([event()], { calendarName: 'feed' });
		const b = buildCalendarFeed([event({ summary: 'Something else' })], { calendarName: 'feed' });
		expect(calendarFeedEtag(a)).not.toBe(calendarFeedEtag(b));
	});

	it('matches weak and multi-value If-None-Match headers', () => {
		const etag = '"abc123"';
		expect(etagMatches(etag, etag)).toBe(true);
		expect(etagMatches(`W/${etag}`, etag)).toBe(true);
		expect(etagMatches(`"other", ${etag}`, etag)).toBe(true);
		expect(etagMatches('"other"', etag)).toBe(false);
		expect(etagMatches(null, etag)).toBe(false);
	});
});

describe('whole document shape', () => {
	it('has one VEVENT per event and folds every line', () => {
		const body = buildCalendarFeed(
			[event(), event({ uid: 'episode-1@cinephage', summary: 'Show S01E01', start: '2026-12-02' })],
			{ calendarName: 'feed' }
		);
		const lines = physicalLines(body);

		expect(lines.filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(2);
		expect(lines.filter((line) => line === 'END:VEVENT')).toHaveLength(2);
		for (const line of lines) {
			expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
		}
	});
});
