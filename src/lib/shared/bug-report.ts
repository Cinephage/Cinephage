/**
 * Shared bug-report constants.
 *
 * Client-safe: used by the report form (area dropdown, log scope picker) and
 * by the server-side diagnostics assembly, so both sides agree on area ids,
 * their GitHub issue-form labels, and which log domains belong to each area.
 */

import type { CapturedLogDomain } from '#lib/logging/log-capture.js';

export const GITHUB_REPO_URL = 'https://github.com/Cinephage/Cinephage';
export const GITHUB_NEW_ISSUE_URL = `${GITHUB_REPO_URL}/issues/new?template=bug_report.yml`;

/**
 * Machine ids for the affected-area picker. Kept stable because they cross
 * the API boundary (diagnostics query schema) and the report markdown.
 */
export const BUG_REPORT_AREAS = [
	'ui',
	'api',
	'indexers',
	'downloads',
	'library',
	'subtitles',
	'monitoring',
	'database',
	'deployment',
	'other'
] as const;

export type BugReportArea = (typeof BUG_REPORT_AREAS)[number];

/**
 * Labels as they appear on the GitHub issue form (bug_report.yml "Affected
 * Area" dropdown). The report is filed in English, so these are not localized.
 */
export const BUG_REPORT_AREA_GITHUB_LABELS: Record<BugReportArea, string> = {
	ui: 'UI/Frontend',
	api: 'API/Backend',
	indexers: 'Indexers/Search',
	downloads: 'Download Clients',
	library: 'Library Management',
	subtitles: 'Subtitles',
	monitoring: 'Monitoring/Scheduler',
	database: 'Database',
	deployment: 'Docker/Deployment',
	other: 'Other'
};

/**
 * Log domains queried for each area when the user picks the "relevant" log
 * scope. `other` has no natural domain and falls back to recent errors.
 */
export const BUG_REPORT_AREA_LOG_DOMAINS: Record<BugReportArea, CapturedLogDomain[]> = {
	ui: ['client'],
	api: ['http'],
	indexers: ['indexers'],
	downloads: ['downloads'],
	library: ['scans', 'imports'],
	subtitles: ['subtitles'],
	monitoring: ['monitoring'],
	database: ['system'],
	deployment: ['system'],
	other: []
};

export const BUG_REPORT_LOG_SCOPES = ['relevant', 'errors', 'all'] as const;

export type BugReportLogScope = (typeof BUG_REPORT_LOG_SCOPES)[number];
