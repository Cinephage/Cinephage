import { describe, expect, it } from 'vitest';
import {
	describeNetworkAirtime,
	formatLocalAirTime,
	localAirTimeLabel,
	zonedWallClockToInstant
} from './airTime.js';

/**
 * Broadcast times are wall clock at the network; every consumer needs them as an
 * instant so the viewer's zone can format them. These tests pin the conversion,
 * which is the only place timezone maths happens.
 */
describe('zonedWallClockToInstant', () => {
	it('converts a US eastern evening broadcast to UTC', () => {
		// 22:00 EST (UTC-5) on 2026-11-11 is 03:00Z on 2026-11-12.
		const instant = zonedWallClockToInstant('2026-11-11', '22:00', 'America/New_York');
		expect(instant?.toISOString()).toBe('2026-11-12T03:00:00.000Z');
	});

	it('honours daylight saving time', () => {
		// 22:00 EDT (UTC-4) on 2026-07-01 is 02:00Z the next day.
		const instant = zonedWallClockToInstant('2026-07-01', '22:00', 'America/New_York');
		expect(instant?.toISOString()).toBe('2026-07-02T02:00:00.000Z');
	});

	it('handles a late-night Japanese broadcast that lands on the previous UTC day', () => {
		// 00:30 JST on 2026-11-14 is 15:30Z on 2026-11-13.
		const instant = zonedWallClockToInstant('2026-11-14', '00:30', 'Asia/Tokyo');
		expect(instant?.toISOString()).toBe('2026-11-13T15:30:00.000Z');
	});

	it('returns null for malformed dates or times instead of throwing', () => {
		expect(zonedWallClockToInstant('2026-11-11', 'nope', 'America/New_York')).toBeNull();
		expect(zonedWallClockToInstant('11/11/2026', '22:00', 'America/New_York')).toBeNull();
		expect(zonedWallClockToInstant('2026-11-11', '99:00', 'America/New_York')).toBeNull();
	});
});

describe('formatLocalAirTime', () => {
	it('returns null when the schedule is incomplete', () => {
		expect(formatLocalAirTime('2026-11-11', null, 'America/New_York', 'en-US')).toBeNull();
		expect(formatLocalAirTime('2026-11-11', '22:00', null, 'en-US')).toBeNull();
		expect(formatLocalAirTime(null, '22:00', 'America/New_York', 'en-US')).toBeNull();
	});

	it('produces a time string for a valid schedule', () => {
		const formatted = formatLocalAirTime('2026-11-11', '22:00', 'America/New_York', 'en-US');
		expect(formatted).toMatch(/^\d{2}:\d{2}\s?(AM|PM)$/i);
	});
});

describe('localAirTimeLabel', () => {
	it('shifts to the viewer day and marks the offset', () => {
		// 22:00 ET is 03:00 the next morning in London.
		expect(
			localAirTimeLabel('2026-11-11', '22:00', 'America/New_York', 'en-GB', 'Europe/London')
		).toBe('03:00 (+1d)');
	});

	it('omits the day marker when the viewer is on the same day', () => {
		expect(
			localAirTimeLabel('2026-11-11', '22:00', 'America/New_York', 'en-US', 'America/Los_Angeles')
		).toBe('07:00 PM');
	});

	it('returns null when the schedule is incomplete', () => {
		expect(localAirTimeLabel('2026-11-11', null, 'America/New_York')).toBeNull();
		expect(localAirTimeLabel('2026-11-11', '22:00', null)).toBeNull();
	});
});

describe('describeNetworkAirtime', () => {
	it('describes the original broadcast slot', () => {
		expect(describeNetworkAirtime('22:00', 'America/New_York')).toBe('22:00 (America/New_York)');
	});

	it('returns undefined without a schedule', () => {
		expect(describeNetworkAirtime(null, 'America/New_York')).toBeUndefined();
		expect(describeNetworkAirtime('22:00', null)).toBeUndefined();
	});
});
