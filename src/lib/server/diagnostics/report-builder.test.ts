import { describe, expect, it } from 'vitest';
import type { CapturedLogEntry, CapturedLogFilters } from '#lib/logging/log-capture.js';
import {
	buildBugReportDiagnostics,
	collectSystemInfo,
	formatLogEntry,
	resolveLogEntries,
	trimLogSlice
} from './report-builder.js';

function entry(
	id: string,
	timestamp: string,
	overrides: Partial<CapturedLogEntry> = {}
): CapturedLogEntry {
	return { id, timestamp, level: 'info', msg: `message ${id}`, ...overrides };
}

interface Harness {
	calls: CapturedLogFilters[];
	deps: {
		getSchemaVersion: () => Promise<number>;
		fetchSnapshot: (filters: CapturedLogFilters) => Promise<CapturedLogEntry[]>;
	};
}

/**
 * Fake history service: routes each snapshot query against a plain in-memory
 * table using the same filter keys the real service supports (enough for the
 * scopes the report builder issues; no time-window semantics needed).
 */
function harness(lookup: (filters: CapturedLogFilters) => CapturedLogEntry[]): Harness {
	const calls: CapturedLogFilters[] = [];
	return {
		calls,
		deps: {
			getSchemaVersion: async () => 169,
			fetchSnapshot: async (filters) => {
				calls.push(filters);
				return lookup(filters);
			}
		}
	};
}

function matches(entry: CapturedLogEntry, filters: CapturedLogFilters): boolean {
	if (filters.supportId && entry.supportId !== filters.supportId) return false;
	if (filters.requestId && entry.requestId !== filters.requestId) return false;
	if (filters.correlationId && entry.correlationId !== filters.correlationId) return false;
	if (filters.logDomain && entry.logDomain !== filters.logDomain) return false;
	if (filters.levels && !filters.levels.includes(entry.level)) return false;
	return true;
}

describe('bug report diagnostics', () => {
	it('collects system info with the schema version and GitHub form options', async () => {
		const { deps } = harness(() => []);
		const info = await collectSystemInfo(deps);
		expect(info.schemaVersion).toBe(169);
		expect(info.node).toMatch(/^v\d+/);
		expect(['docker', 'native']).toContain(info.deployment);
		// The dropdown hints must be exactly pickable options on the form.
		expect(['Docker', 'Native (npm/node)']).toContain(info.githubDeploymentOption);
		expect(
			info.githubOsOption === null ||
				/^([A-Z]|Other)/.test(info.githubOsOption) ||
				info.githubOsOption.startsWith('Linux') ||
				info.githubOsOption.startsWith('Other')
		).toBe(true);
	});

	it('spiders a supportId across request and correlation ids, deduped and sorted', async () => {
		const table = [
			entry('e1', '2026-11-04T14:31:50Z', { supportId: 'abc', requestId: 'r1' }),
			entry('e2', '2026-11-04T14:31:58Z', { supportId: 'abc', correlationId: 'c1' }),
			// Hidden server-side trail sharing r1/c1 but no supportId of its own.
			entry('e3', '2026-11-04T14:31:51Z', { requestId: 'r1', logDomain: 'downloads' }),
			entry('e4', '2026-11-04T14:31:59Z', { correlationId: 'c1' }),
			// Same request id again through the correlation hop - must dedupe.
			entry('e1', '2026-11-04T14:31:50Z', { supportId: 'abc', requestId: 'r1' }),
			// Unrelated traffic that must not leak in.
			entry('e5', '2026-11-04T14:31:55Z', { supportId: 'other' }),
			entry('e6', '2026-11-04T14:31:56Z', { requestId: 'r-unrelated' })
		];
		const { deps, calls } = harness((filters) => table.filter((e) => matches(e, filters)));

		const result = await resolveLogEntries({ supportId: 'abc', logScope: 'relevant' }, deps);

		expect(result.entries.map((e) => e.message)).toEqual([
			'message e1',
			'message e3',
			'message e2',
			'message e4'
		]);
		expect(result.scope).toBe('relevant');
		expect(result.scopeDescription).toContain('abc');
		// Seed query by supportId first, then the request/correlation hops.
		expect(calls[0]).toMatchObject({ supportId: 'abc' });
		expect(calls.some((c) => c.requestId === 'r1')).toBe(true);
		expect(calls.some((c) => c.correlationId === 'c1')).toBe(true);
	});

	it('queries each of the area domains with warn/error levels and a time window', async () => {
		const table = [
			entry('s1', '2026-11-04T10:00:00Z', { logDomain: 'scans', level: 'error' }),
			entry('s2', '2026-11-04T10:05:00Z', { logDomain: 'imports', level: 'warn' }),
			entry('s3', '2026-11-04T10:06:00Z', { logDomain: 'indexers', level: 'error' })
		];
		const { deps, calls } = harness((filters) => table.filter((e) => matches(e, filters)));

		const result = await resolveLogEntries({ area: 'library', logScope: 'relevant' }, deps);

		expect(result.entries.map((e) => e.message)).toEqual(['message s1', 'message s2']);
		expect(result.scopeDescription).toContain('Scans');
		expect(result.scopeDescription).toContain('Imports');
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call.levels).toEqual(['warn', 'error']);
			expect(call.from).toBeDefined();
		}
		expect(new Set(calls.map((c) => c.logDomain))).toEqual(new Set(['scans', 'imports']));
	});

	it('falls back to the errors scope for areas without log domains', async () => {
		const { deps, calls } = harness(() => []);
		const result = await resolveLogEntries({ area: 'other', logScope: 'relevant' }, deps);
		expect(result.scope).toBe('errors');
		expect(calls[0]?.levels).toEqual(['warn', 'error']);
	});

	it('applies the keyword as a post-filter without breaking the supportId spider', async () => {
		const table = [
			entry('e1', '2026-11-04T14:31:50Z', { supportId: 'abc', msg: 'DanishBytes test failed' }),
			entry('e2', '2026-11-04T14:31:58Z', { supportId: 'abc', msg: 'unrelated noise' })
		];
		const { deps, calls } = harness((filters) => table.filter((e) => matches(e, filters)));

		const result = await resolveLogEntries(
			{ supportId: 'abc', logScope: 'relevant', keyword: 'danishbytes' },
			deps
		);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.message).toContain('DanishBytes');
		// The keyword narrows results client-of-the-query only; the seed query
		// stays a pure supportId lookup so the spider still sees all ids.
		expect(calls[0]?.supportId).toBe('abc');
		expect(calls[0]?.search).toBeUndefined();
	});

	it('formats entries with error message, path, compact redacted data, and a stable id', () => {
		const formatted = formatLogEntry({
			id: 'x',
			timestamp: '2026-11-04T14:31:58.123Z',
			level: 'error',
			msg: 'grab failed',
			logDomain: 'indexers',
			method: 'GET',
			path: '/api/x?token=supersecret',
			err: { message: 'indexer returned 502' },
			data: { indexer: 'DanishBytes' }
		});

		expect(formatted.id).toBe('x');
		expect(formatted.time).toBe('11-04 14:31:58');
		expect(formatted.domain).toBe('indexers');
		expect(formatted.message).toContain('grab failed');
		expect(formatted.message).toContain('indexer returned 502');
		expect(formatted.message).toContain('DanishBytes');
		expect(formatted.message).not.toContain('supersecret');
		expect(formatted.message).toContain('[REDACTED]');
	});

	it('trims the oldest entries when the copy slice exceeds the character budget', () => {
		const entries = Array.from({ length: 60 }, (_, i) => ({
			id: `entry-${i}`,
			time: `11-04 14:${String(i).padStart(2, '0')}:00`,
			level: 'error',
			domain: 'indexers',
			message: 'x'.repeat(700)
		}));
		const result = trimLogSlice({
			scope: 'all' as const,
			scopeDescription: 'full log history',
			entries,
			totalMatched: entries.length,
			trimmedCount: 0
		});

		expect(result.trimmedCount).toBeGreaterThan(0);
		// Newest survive, oldest are dropped.
		expect(result.entries[0]?.id).not.toBe('entry-0');
		expect(result.entries.at(-1)?.id).toBe('entry-59');
		expect(result.totalMatched).toBe(entries.length);
	});

	it('assembles the full diagnostics result with the budget applied', async () => {
		const table = [entry('e1', '2026-11-04T14:31:50Z', { supportId: 'abc', level: 'error' })];
		const { deps } = harness((filters) => table.filter((e) => matches(e, filters)));

		const result = await buildBugReportDiagnostics(
			{ supportId: 'abc', logScope: 'relevant' },
			deps
		);

		expect(result.system.schemaVersion).toBe(169);
		expect(result.logs.entries).toHaveLength(1);
		expect(result.logs.trimmedCount).toBe(0);
		expect(result.generatedAt).toBeDefined();
	});
});
