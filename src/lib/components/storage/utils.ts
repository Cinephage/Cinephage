import * as m from '#lib/paraglide/messages.js';
import { formatDisplayDate } from '#lib/utils/format.js';

export { formatBytes } from '#lib/utils/format.js';

export type InsightSeverity = 'info' | 'warning' | 'critical';

/**
 * Shared client-facing shape for a storage insight, consumed by InsightsPanel,
 * InsightCard and InsightDetailModal. Kept in sync with the fields these
 * components read from the `storage_insights` records returned by the page load.
 */
export type Insight = {
	id: string;
	insightType: string;
	severity: InsightSeverity;
	title: string;
	summary: string | null;
	reclaimableBytes: number | null;
	detailsJson: string | null;
	itemCount: number;
};

/**
 * Badge classes for each severity, matching the codebase convention:
 * border-X/30 bg-X/10 text-X (fixed in Phase 1 from the broken bg-X/15 pattern).
 */
export function severityBadgeClass(severity: InsightSeverity): string {
	switch (severity) {
		case 'critical':
			return 'border-error/30 bg-error/10 text-error';
		case 'warning':
			return 'border-warning/30 bg-warning/10 text-warning';
		default:
			return 'border-info/30 bg-info/10 text-info';
	}
}

/**
 * Dismiss an insight via the API. Returns true on success.
 */
export async function dismissInsight(insightId: string): Promise<boolean> {
	try {
		const response = await fetch(`/api/storage/insights/${insightId}/dismiss`, {
			method: 'POST'
		});
		const data = await response.json();
		return data.success === true;
	} catch {
		return false;
	}
}

/**
 * Map an insight type to a human-readable category label.
 */
export function insightTypeLabel(type: string): string {
	const labels: Record<string, string> = {
		'orphaned-files': 'Orphaned Files',
		'missing-from-media-server': 'Sync Gap',
		'untracked-by-cinephage': 'Untracked',
		unplayed: 'Unplayed',
		'duplicate-items': 'Duplicates',
		'filename-duplicates': 'Filename Dupes',
		'quality-below-cutoff': 'Quality',
		'broken-paths': 'Broken Paths',
		'health-issues': 'Health'
	};
	return labels[type] ?? type;
}

/**
 * Badge classes for a per-item insight badge's tone (InsightItemBadge.tone),
 * shared by InsightDetailModal and the status page's own detail dialog so
 * both surfaces render the resolver's actual data-point labels (e.g. "117
 * unplayed episodes", "2x files") identically instead of one of them falling
 * back to a bare count.
 */
export function badgeToneColor(tone: string): string {
	switch (tone) {
		case 'critical':
			return 'border-error/30 bg-error/10 text-error';
		case 'warn':
			return 'border-warning/30 bg-warning/10 text-warning';
		default:
			return 'border-info/30 bg-info/10 text-info';
	}
}

// Insight types whose items resolve to real library rows on one of these two
// list pages. Both pages accept ?insightId=<id> and filter down to exactly
// the items that insight's resolver returns.
const FILTERABLE_INSIGHT_LINKS: Record<string, string> = {
	'missing-from-media-server': '/settings/monitoring/status/media',
	unplayed: '/settings/monitoring/status/media',
	'duplicate-items': '/library/movies',
	'filename-duplicates': '/library/movies',
	'quality-below-cutoff': '/library/movies',
	'redundant-quality-tiers': '/library/movies'
};

// Insight types whose items don't correspond to filterable rows on an
// existing list page: orphaned-files' destination already IS the exact list
// with nothing to filter, and broken-paths/health-issues point at the
// (short, unfiltered) root folders list.
const STATIC_INSIGHT_LINKS: Record<string, string> = {
	'orphaned-files': '/library/unmatched',
	'broken-paths': '/settings/monitoring/status/folders',
	'health-issues': '/settings/monitoring/status/folders'
};

// untracked-by-cinephage has no destination at all: its items aren't in
// Cinephage's library by definition, so no list page - filtered or not -
// could ever show them. Each item's own "Search to add" link covers
// remediation instead.
const NO_FOOTER_LINK_INSIGHT_TYPES = new Set(['untracked-by-cinephage']);

/**
 * "View all in X" footer link target for an insight detail view, or null
 * when no destination applies. Shared by InsightDetailModal and the status
 * page's own detail dialog.
 */
export function getInsightFooterLink(insightType: string, insightId: string): string | null {
	if (NO_FOOTER_LINK_INSIGHT_TYPES.has(insightType)) return null;
	const filterableBase = FILTERABLE_INSIGHT_LINKS[insightType];
	if (filterableBase) {
		return `${filterableBase}?insightId=${insightId}`;
	}
	return STATIC_INSIGHT_LINKS[insightType] ?? '/settings/monitoring/status/insights';
}

export type LibraryBreakdownItem = {
	id: string;
	name: string;
	slug: string;
	isDefault: boolean;
	mediaType: string;
	mediaSubType: string;
	itemCount: number;
	usedBytes: number;
	path?: string | null;
	hasRootFolder?: boolean;
	rootFolderCount?: number;
	rootFolderIds?: string[];
	detachedItemCount?: number;
	defaultSearchOnAdd?: boolean;
	defaultWantsSubtitles?: boolean;
	unmatchedCount?: number;
	needsScan?: boolean;
	scanMode?: string | null;
};

export type RootFolderBreakdownItem = {
	id: string;
	name: string;
	mediaType: string;
	mediaSubType: string;
	itemCount: number;
	usedBytes: number;
	path?: string | null;
	accessible?: boolean;
	readOnly?: boolean;
	freeSpaceBytes?: number | null;
	totalSpaceBytes?: number | null;
	freeSpaceFormatted?: string | null;
	unmatchedCount?: number;
	lastScannedAt?: string | null;
	lastScanStatus?: string | null;
	needsScan?: boolean;
	freeRatio?: number | null;
};

export type StorageSummary = {
	totalUsedBytes: number;
	moviesUsedBytes: number;
	tvUsedBytes: number;
	subtitlesUsedBytes: number;
	movieCount: number;
	seriesCount: number;
	subtitleCount: number;
	libraryBreakdown: LibraryBreakdownItem[];
	rootFolderBreakdown: RootFolderBreakdownItem[];
	health: {
		librariesWithoutRootFolder: number;
		inaccessibleRootFolders: number;
		readOnlyRootFolders: number;
		unmatchedFiles: number;
		rootFoldersNeedingScan: number;
		lastScan: {
			status: string;
			scanType: string;
			startedAt: string | null;
			completedAt: string | null;
			filesScanned: number;
			filesAdded: number;
			filesUpdated: number;
			filesRemoved: number;
			unmatchedFiles: number;
			errorMessage: string | null;
			durationMs: number | null;
		} | null;
	};
};

export type ScanProgress = {
	phase: string;
	rootFolderId?: string;
	rootFolderPath?: string;
	filesFound: number;
	filesProcessed: number;
	filesAdded: number;
	filesUpdated: number;
	filesRemoved: number;
	unmatchedCount: number;
	currentFile?: string;
};

export type ScanSuccess = {
	message: string;
	unmatchedCount: number;
};

export type ServerStatus = {
	serverId: string;
	serverName: string;
	serverType: string;
	itemCount: number;
	lastSyncAt: string | null;
	lastSyncStatus: string | null;
};

export const DISK_SEGMENT_STYLES = {
	cinephage: 'background-color: #0ea5e9;',
	other: 'background-color: #f59e0b;',
	free: 'background-color: #22c55e;'
} as const;

export function libraryHref(
	item: Pick<LibraryBreakdownItem, 'mediaType' | 'slug' | 'isDefault'>
): string {
	const base = item.mediaType === 'movie' ? '/library/movies' : '/library/tv';
	return item.isDefault ? base : `${base}?library=${item.slug}`;
}

export function formatTimestamp(timestamp: string | null): string {
	if (!timestamp) return m.settings_general_never();
	return formatDisplayDate(timestamp, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}

export function formatDuration(durationMs: number | null): string {
	if (!durationMs || durationMs < 1000) return m.settings_general_underOneSecond();
	const totalSeconds = Math.round(durationMs / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function getStatusBadgeClass(enabled: boolean): string {
	return enabled
		? 'border-success/30 bg-success/10 text-success'
		: 'border-error/30 bg-error/10 text-error';
}

export function formatPercent(value: number | null | undefined): string {
	if (value === null || value === undefined) return 'N/A';
	return `${Math.round(value * 100)}%`;
}

export function getRootFolderTotalBytes(item: RootFolderBreakdownItem): number | null {
	if (item.totalSpaceBytes === null || item.totalSpaceBytes === undefined) return null;
	return item.totalSpaceBytes;
}

export function getUsedRatio(item: RootFolderBreakdownItem): number | null {
	if (item.freeSpaceBytes === null || item.freeSpaceBytes === undefined) return null;
	const totalBytes = item.usedBytes + Number(item.freeSpaceBytes);
	if (totalBytes <= 0) return null;
	return item.usedBytes / totalBytes;
}

export function getFreeRatio(item: RootFolderBreakdownItem): number | null {
	if (item.freeSpaceBytes === null || item.freeSpaceBytes === undefined) return null;
	const totalBytes = item.usedBytes + Number(item.freeSpaceBytes);
	if (totalBytes <= 0) return null;
	return Number(item.freeSpaceBytes) / totalBytes;
}

export function getNonCinephageUsedBytes(item: RootFolderBreakdownItem): number | null {
	const totalBytes = getRootFolderTotalBytes(item);
	if (!totalBytes || item.freeSpaceBytes === null || item.freeSpaceBytes === undefined) return null;
	return Math.max(0, totalBytes - Number(item.freeSpaceBytes) - item.usedBytes);
}

export function getNonCinephageRatio(item: RootFolderBreakdownItem): number | null {
	const totalBytes = getRootFolderTotalBytes(item);
	const bytes = getNonCinephageUsedBytes(item);
	if (!totalBytes || bytes === null) return null;
	return bytes / totalBytes;
}

export function segmentWidth(ratio: number | null | undefined): string {
	if (ratio === null || ratio === undefined || ratio <= 0) return '0%';
	return `${Math.round(ratio * 100)}%`;
}

export function getRootFolderScanLabel(item: RootFolderBreakdownItem): string {
	if (item.lastScanStatus === 'completed') return m.settings_general_scanned();
	if (item.lastScanStatus === 'failed') return m.settings_general_scanFailed();
	if (item.lastScanStatus === 'running') return m.settings_general_scanning();
	if (item.needsScan) return m.settings_general_needsScan();
	return m.settings_general_pending();
}

export function getRootFolderScanBadgeClass(item: RootFolderBreakdownItem): string {
	if (item.lastScanStatus === 'completed') return 'border-success/30 bg-success/10 text-success';
	if (item.lastScanStatus === 'failed') return 'border-error/30 bg-error/10 text-error';
	if (item.lastScanStatus === 'running') return 'border-warning/30 bg-warning/10 text-warning';
	if (item.needsScan) return 'border-warning/30 bg-warning/10 text-warning';
	return 'border-base-300 bg-base-200 text-base-content/70';
}

export function getScanTone(status: string | null | undefined): string {
	if (status === 'completed') return 'bg-success';
	if (status === 'failed') return 'bg-error';
	if (status === 'running') return 'bg-warning animate-pulse';
	return 'bg-base-300';
}

export function getServerTypeBadgeClass(type: string): string {
	// DaisyUI semantic colors map to the original purple/green/orange server-type dots.
	return type === 'jellyfin'
		? 'badge-primary'
		: type === 'emby'
			? 'badge-success'
			: 'badge-warning';
}

export function getSyncStatusColor(status: string | null, lastSyncAt: string | null): string {
	if (status === 'failed') return 'badge-error';
	if (!lastSyncAt) return 'badge-ghost';
	const hoursSinceSync = (Date.now() - new Date(lastSyncAt).getTime()) / (1000 * 60 * 60);
	if (hoursSinceSync > 24) return 'badge-warning';
	return 'badge-success';
}
