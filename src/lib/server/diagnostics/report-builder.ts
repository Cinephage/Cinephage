/**
 * Bug-report diagnostics assembly.
 *
 * Collects the technical evidence a GitHub issue needs from the user's install
 * (system info plus a scoped slice of log history). The bug itself is
 * described on GitHub; this module only provides what users cannot dig out
 * themselves - version/commit, OS, and logs - formatted for copy-paste into
 * the issue form's technical fields, plus the scope resolution for the
 * attachable full-log file.
 *
 * Log scopes:
 * - "relevant" + supportId: the full correlation web for that id (all entries
 *   with the supportId, plus everything sharing their request/correlation ids)
 * - "relevant" + area: warn/error entries from that area's log domains (24h)
 * - "errors": warn/error entries from every domain (24h)
 * - "all": full persisted history, trimmed by the character budget
 *
 * Entries are redacted at emit time by the logger; every string that leaves
 * this module passes through `redactString` again as defense-in-depth.
 */

import { existsSync, readFileSync } from 'node:fs';
import { arch, platform as nodePlatform, release, type as osType } from 'node:os';

import { redactString } from '#lib/logging/index.js';
import type { CapturedLogEntry, CapturedLogFilters } from '#lib/logging/log-capture.js';
import { DOMAIN_LABELS } from '#lib/logging/log-capture.js';
import { resolveAppCommit, resolveAppVersion } from '#lib/server/version.js';
import {
	BUG_REPORT_AREA_LOG_DOMAINS,
	type BugReportArea,
	type BugReportLogScope
} from '#lib/shared/bug-report.js';
import type { BugReportDiagnosticsQuery } from '#lib/validation/schemas.js';

/**
 * Character budget for the copyable log slice. GitHub caps issue bodies
 * around 65k chars; the attachable full-log file exists for everything that
 * does not fit.
 */
const LOG_SLICE_CHAR_BUDGET = 30_000;

/** Per-query snapshot cap (getSnapshot itself hard-caps at 5000). */
const SNAPSHOT_LIMIT = 2000;

/** Correlation ids followed per supportId spider, so one noisy id cannot
 * explode into dozens of history scans. */
const SPIDER_MAX_CORRELATION_IDS = 12;

/** Time window for the area/error scopes. */
const RELEVANT_WINDOW_HOURS = 24;

/** Cap on a single formatted entry message; longer payloads are cut with a marker. */
const ENTRY_MESSAGE_CHAR_CAP = 400;

/** Compact JSON cap for an entry's data payload. */
const ENTRY_DATA_CHAR_CAP = 200;

export interface BugReportSystemInfo {
	version: string;
	commit: string;
	node: string;
	os: string;
	platform: string;
	arch: string;
	schemaVersion: number | null;
	uptimeSeconds: number;
	deployment: 'docker' | 'native';
	/** PRETTY_NAME from /etc/os-release, when readable (e.g. "Debian GNU/Linux 12"). */
	osRelease: string | null;
	/** The exact "Operating System" option to pick on the GitHub issue form. */
	githubOsOption: string | null;
	/** The exact "Deployment Method" option to pick on the GitHub issue form. */
	githubDeploymentOption: string;
}

export interface FormattedLogEntry {
	/** Source log entry id; keys the preview list so repeated identical
	 * lines (same second, same message) cannot produce duplicate keys. */
	id: string;
	/** "MM-DD HH:mm:ss" — spans days without the year noise. */
	time: string;
	level: string;
	domain: string;
	/** Fully formatted, redacted, length-capped message line. */
	message: string;
}

export interface BugReportLogResult {
	/** Effective scope after fallbacks (e.g. area without domains -> errors). */
	scope: BugReportLogScope;
	/** Plain-language description of what was queried, for the report header. */
	scopeDescription: string;
	entries: FormattedLogEntry[];
	/** Entries matched before the character budget trimmed the oldest ones. */
	totalMatched: number;
	/** Entries dropped from the front (oldest) to fit the budget. */
	trimmedCount: number;
}

export interface BugReportDiagnosticsResult {
	system: BugReportSystemInfo;
	logs: BugReportLogResult;
	generatedAt: string;
}

/** Seam for tests: history/schema lookups default to the real services via
 * lazy imports so this module stays importable without the database. */
export interface BugReportDeps {
	fetchSnapshot?: (filters: CapturedLogFilters) => Promise<CapturedLogEntry[]>;
	getSchemaVersion?: () => Promise<number | null>;
}

async function defaultFetchSnapshot(filters: CapturedLogFilters): Promise<CapturedLogEntry[]> {
	const { logHistoryService } = await import('#lib/server/logging/log-history.js');
	return logHistoryService.getSnapshot(filters);
}

async function defaultGetSchemaVersion(): Promise<number | null> {
	try {
		const { CURRENT_SCHEMA_VERSION } = await import('#lib/server/db/schema-sync.js');
		return CURRENT_SCHEMA_VERSION;
	} catch {
		return null;
	}
}

function readOsReleasePrettyName(): string | null {
	try {
		const content = readFileSync('/etc/os-release', 'utf8');
		const match = content.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

/** Map the running OS onto the GitHub issue form's Operating System options. */
function resolveGithubOsOption(prettyName: string | null, platform: string): string | null {
	const pretty = prettyName?.toLowerCase() ?? '';
	if (pretty.includes('unraid')) return 'Unraid';
	if (pretty.includes('truenas')) return 'TrueNAS';
	if (pretty.includes('synology')) return 'Synology';
	if (pretty.includes('debian') || pretty.includes('ubuntu')) return 'Linux (Debian/Ubuntu)';
	if (['fedora', 'rhel', 'rocky', 'alma', 'centos'].some((s) => pretty.includes(s))) {
		return 'Linux (Fedora/RHEL)';
	}
	if (pretty.includes('arch')) return 'Linux (Arch)';
	if (platform === 'win32' || pretty.includes('windows')) return 'Windows';
	if (platform === 'darwin') return 'macOS';
	if (platform === 'linux') return 'Linux (Other)';
	return null;
}

export async function collectSystemInfo(deps: BugReportDeps = {}): Promise<BugReportSystemInfo> {
	const getSchemaVersion = deps.getSchemaVersion ?? defaultGetSchemaVersion;
	const platform = nodePlatform();
	const deployment: 'docker' | 'native' = existsSync('/.dockerenv') ? 'docker' : 'native';
	const osRelease = readOsReleasePrettyName();
	return {
		version: resolveAppVersion(),
		commit: resolveAppCommit(),
		node: process.version,
		os: osRelease ?? `${osType()} ${release()}`,
		platform,
		arch: arch(),
		schemaVersion: await getSchemaVersion(),
		uptimeSeconds: Math.floor(process.uptime()),
		deployment,
		osRelease,
		githubOsOption: resolveGithubOsOption(osRelease, platform),
		githubDeploymentOption: deployment === 'docker' ? 'Docker' : 'Native (npm/node)'
	};
}

function windowStartISO(): string {
	return new Date(Date.now() - RELEVANT_WINDOW_HOURS * 3_600_000).toISOString();
}

function mergeEntries(target: Map<string, CapturedLogEntry>, entries: CapturedLogEntry[]): void {
	for (const entry of entries) {
		target.set(entry.id, entry);
	}
}

function sortByTimestamp(entries: CapturedLogEntry[]): CapturedLogEntry[] {
	return [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function compactJson(value: unknown): string {
	let json: string;
	try {
		json = JSON.stringify(value) ?? '';
	} catch {
		return '';
	}
	return json.length > ENTRY_DATA_CHAR_CAP ? `${json.slice(0, ENTRY_DATA_CHAR_CAP)}...` : json;
}

export function formatLogEntry(entry: CapturedLogEntry): FormattedLogEntry {
	const time = entry.timestamp.slice(5, 19).replace('T', ' ');
	const parts: string[] = [];
	if (entry.msg) parts.push(entry.msg);
	const errMessage = entry.err?.message;
	if (typeof errMessage === 'string' && errMessage) parts.push(errMessage);
	if (entry.path) parts.push(`${entry.method ? `${entry.method} ` : ''}${entry.path}`);
	if (entry.data && Object.keys(entry.data).length > 0) {
		const dataJson = compactJson(entry.data);
		if (dataJson) parts.push(`{${dataJson}}`);
	}

	let message = redactString(parts.join(' | '));
	if (message.length > ENTRY_MESSAGE_CHAR_CAP) {
		message = `${message.slice(0, ENTRY_MESSAGE_CHAR_CAP)}[truncated]`;
	}

	return {
		id: entry.id,
		time,
		level: entry.level,
		domain: entry.logDomain ?? 'general',
		message
	};
}

/** Single-line rendering used by both the copy slice and the download file. */
export function formatLogLine(entry: FormattedLogEntry): string {
	return `[${entry.time}] ${entry.level.toUpperCase()} ${entry.domain}: ${entry.message}`;
}

function filterByKeyword(entries: CapturedLogEntry[], keyword: string): CapturedLogEntry[] {
	const needle = keyword.trim().toLowerCase();
	if (!needle) return entries;
	return entries.filter((entry) => formatLogEntry(entry).message.toLowerCase().includes(needle));
}

interface ResolvedLogs {
	scope: BugReportLogScope;
	scopeDescription: string;
	entries: CapturedLogEntry[];
}

async function resolveSupportIdSpider(
	supportId: string,
	keyword: string | undefined,
	fetchSnapshot: NonNullable<BugReportDeps['fetchSnapshot']>
): Promise<ResolvedLogs> {
	const seed = await fetchSnapshot({ supportId, limit: SNAPSHOT_LIMIT });
	const merged = new Map<string, CapturedLogEntry>();
	mergeEntries(merged, seed);

	// Follow the correlation web: every request/correlation id seen on the
	// seed entries pulls in the rest of that request's trail (server-side
	// work the user never saw, e.g. grab pipelines triggered by a click).
	const correlationIds = new Set<string>();
	for (const entry of seed) {
		if (entry.requestId) correlationIds.add(entry.requestId);
		if (entry.correlationId) correlationIds.add(entry.correlationId);
	}

	for (const id of [...correlationIds].slice(0, SPIDER_MAX_CORRELATION_IDS)) {
		mergeEntries(merged, await fetchSnapshot({ requestId: id, limit: SNAPSHOT_LIMIT }));
		mergeEntries(merged, await fetchSnapshot({ correlationId: id, limit: SNAPSHOT_LIMIT }));
	}

	return {
		scope: 'relevant',
		scopeDescription: `Error ID ${supportId} and correlated requests`,
		entries: keyword
			? filterByKeyword(sortByTimestamp([...merged.values()]), keyword)
			: sortByTimestamp([...merged.values()])
	};
}

async function resolveErrorLogs(
	fetchSnapshot: NonNullable<BugReportDeps['fetchSnapshot']>
): Promise<ResolvedLogs> {
	const entries = await fetchSnapshot({
		levels: ['warn', 'error'],
		from: windowStartISO(),
		limit: SNAPSHOT_LIMIT
	});
	return {
		scope: 'errors',
		scopeDescription: `all warnings and errors, last ${RELEVANT_WINDOW_HOURS}h`,
		entries: sortByTimestamp(entries)
	};
}

async function resolveAreaLogs(
	area: BugReportArea,
	fetchSnapshot: NonNullable<BugReportDeps['fetchSnapshot']>
): Promise<ResolvedLogs> {
	const domains = BUG_REPORT_AREA_LOG_DOMAINS[area];
	if (domains.length === 0) {
		return resolveErrorLogs(fetchSnapshot);
	}

	const from = windowStartISO();
	const merged = new Map<string, CapturedLogEntry>();
	for (const logDomain of domains) {
		mergeEntries(
			merged,
			await fetchSnapshot({ logDomain, levels: ['warn', 'error'], from, limit: SNAPSHOT_LIMIT })
		);
	}

	const domainList = domains.map((domain) => DOMAIN_LABELS[domain]).join(', ');
	return {
		scope: 'relevant',
		scopeDescription: `${domainList}, last ${RELEVANT_WINDOW_HOURS}h`,
		entries: sortByTimestamp([...merged.values()])
	};
}

export async function resolveLogEntries(
	input: Pick<BugReportDiagnosticsQuery, 'supportId' | 'area' | 'logScope' | 'keyword'>,
	deps: BugReportDeps = {}
): Promise<BugReportLogResult> {
	const fetchSnapshot = deps.fetchSnapshot ?? defaultFetchSnapshot;
	const keyword = input.keyword?.trim() || undefined;

	let resolved: ResolvedLogs;
	if (input.logScope === 'all') {
		let entries = await fetchSnapshot({ limit: SNAPSHOT_LIMIT * 2 });
		if (keyword) entries = filterByKeyword(entries, keyword);
		resolved = { scope: 'all', scopeDescription: 'full log history', entries };
	} else if (input.logScope === 'relevant' && input.supportId) {
		resolved = await resolveSupportIdSpider(input.supportId, keyword, fetchSnapshot);
	} else if (input.logScope === 'relevant' && input.area) {
		resolved = await resolveAreaLogs(input.area, fetchSnapshot);
		if (keyword) resolved = { ...resolved, entries: filterByKeyword(resolved.entries, keyword) };
	} else {
		resolved = await resolveErrorLogs(fetchSnapshot);
		if (keyword) resolved = { ...resolved, entries: filterByKeyword(resolved.entries, keyword) };
	}

	return {
		scope: resolved.scope,
		scopeDescription: resolved.scopeDescription,
		entries: resolved.entries.map(formatLogEntry),
		totalMatched: resolved.entries.length,
		trimmedCount: 0
	};
}

/**
 * Applies the character budget to the copyable log slice: when it is too
 * large, entries drop from the front (oldest first) so the most recent —
 * usually the most relevant — survive. The untrimmed set stays available for
 * the attachable full-log file.
 */
export function trimLogSlice(logs: BugReportLogResult): BugReportLogResult {
	const lines = logs.entries.map(formatLogLine);
	let trimmedCount = 0;
	while (
		trimmedCount < lines.length &&
		lines.slice(trimmedCount).join('\n').length > LOG_SLICE_CHAR_BUDGET
	) {
		trimmedCount += 1;
	}

	return { ...logs, entries: logs.entries.slice(trimmedCount), trimmedCount };
}

export async function buildBugReportDiagnostics(
	input: BugReportDiagnosticsQuery,
	deps: BugReportDeps = {}
): Promise<BugReportDiagnosticsResult> {
	const [system, rawLogs] = await Promise.all([
		collectSystemInfo(deps),
		resolveLogEntries(input, deps)
	]);

	return {
		system,
		logs: trimLogSlice(rawLogs),
		generatedAt: new Date().toISOString()
	};
}
