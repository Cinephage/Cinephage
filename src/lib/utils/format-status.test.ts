/**
 * Series status formatting regression tests.
 *
 * Bug #494: TMDB stores cancelled shows as "Cancelled" (double-L), but the
 * formatter only matches "canceled" (single-L), so TMDB-cancelled shows render
 * the raw status string instead of the translated label - and match neither the
 * "Ended" nor (missing) "Cancelled" filter.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as m from '#lib/paraglide/messages.js';
import { overwriteGetLocale } from '#lib/paraglide/runtime.js';
import {
	formatSeriesStatus,
	matchesSeriesStatusFilter,
	seriesStatusFilterOptions
} from './format-status.js';

afterAll(() => {
	overwriteGetLocale(() => 'en');
});

describe('formatSeriesStatus', () => {
	it('returns unknown for null/undefined', () => {
		expect(formatSeriesStatus(null)).toBe(m.common_unknown());
	});

	it('recognizes TMDB "Returning Series"', () => {
		expect(formatSeriesStatus('Returning Series')).toBe(m.library_libraryMediaTable_continuing());
	});

	it('recognizes "In Production"', () => {
		expect(formatSeriesStatus('In Production')).toBe(m.library_libraryMediaTable_inProduction());
	});

	it('recognizes "Ended"', () => {
		expect(formatSeriesStatus('Ended')).toBe(m.library_libraryMediaTable_ended());
	});

	it('recognizes single-L "Canceled" (AniList spelling)', () => {
		expect(formatSeriesStatus('Canceled')).toBe(m.library_libraryMediaTable_cancelled());
	});

	it('recognizes TMDB double-L "Cancelled" (bug #494)', () => {
		expect(formatSeriesStatus('Cancelled')).toBe(m.library_libraryMediaTable_cancelled());
	});

	it('translates TMDB "Cancelled" in non-English locales instead of returning the raw string (bug #494)', () => {
		overwriteGetLocale(() => 'de');
		expect(formatSeriesStatus('Cancelled')).toBe(
			m.library_libraryMediaTable_cancelled(undefined, { locale: 'de' })
		);
	});

	it('passes through unknown statuses unchanged', () => {
		expect(formatSeriesStatus('Planned')).toBe('Planned');
	});
});

describe('matchesSeriesStatusFilter', () => {
	it('matches TMDB double-L "Cancelled" under the cancelled filter (bug #494)', () => {
		expect(matchesSeriesStatusFilter('Cancelled', 'cancelled')).toBe(true);
	});

	it('matches single-L "Canceled" under the cancelled filter', () => {
		expect(matchesSeriesStatusFilter('Canceled', 'cancelled')).toBe(true);
	});

	it('does not match TMDB "Cancelled" under the ended filter', () => {
		expect(matchesSeriesStatusFilter('Cancelled', 'ended')).toBe(false);
	});

	it('keeps single-L "Canceled" under the ended filter for backward compatibility', () => {
		expect(matchesSeriesStatusFilter('Canceled', 'ended')).toBe(true);
	});

	it('matches continuing statuses under the continuing filter', () => {
		expect(matchesSeriesStatusFilter('Returning Series', 'continuing')).toBe(true);
		expect(matchesSeriesStatusFilter('In Production', 'continuing')).toBe(true);
		expect(matchesSeriesStatusFilter('Ended', 'continuing')).toBe(false);
	});

	it('matches ended under the ended filter', () => {
		expect(matchesSeriesStatusFilter('Ended', 'ended')).toBe(true);
	});

	it('returns false for null status', () => {
		expect(matchesSeriesStatusFilter(null, 'cancelled')).toBe(false);
	});

	it('matches everything for unknown filter keys (all)', () => {
		expect(matchesSeriesStatusFilter('Planned', 'all')).toBe(true);
		expect(matchesSeriesStatusFilter('Ended', 'all')).toBe(true);
	});
});

describe('seriesStatusFilterOptions', () => {
	it('includes the cancelled option wired to the translated label (bug #494)', () => {
		const options = seriesStatusFilterOptions();
		const cancelled = options.find((o) => o.value === 'cancelled');

		expect(cancelled).toBeDefined();
		expect(cancelled?.label).toBe(m.library_tv_filterCancelled());
	});

	it('every option value has a matching status filter branch', () => {
		const options = seriesStatusFilterOptions();
		for (const option of options) {
			if (option.value === 'all') continue;
			// Sanity: each branch is exercised by the predicate without throwing
			expect(typeof matchesSeriesStatusFilter('Ended', option.value)).toBe('boolean');
		}
	});

	it('includes continuing and ended options', () => {
		const values = seriesStatusFilterOptions().map((o) => o.value);
		expect(values).toEqual(['all', 'continuing', 'ended', 'cancelled']);
	});
});
