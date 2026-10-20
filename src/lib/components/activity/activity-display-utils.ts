import type { UnifiedActivity } from '#lib/types/activity.js';
import { isImportFailedActivity, TASK_TYPE_LABELS } from '#lib/types/activity.js';
import * as m from '#lib/paraglide/messages.js';
import { getLocale } from '#lib/paraglide/runtime.js';
import {
	CheckCircle2,
	XCircle,
	AlertCircle,
	Loader2,
	Upload,
	Pause,
	Minus,
	SearchX
} from '@lucide/svelte';

/**
 * Status → display metadata mapping shared across all activity UI components.
 *
 * Note: `icon` is typed loosely (`typeof CheckCircle2`) because every
 * @lucide/svelte icon shares the same component signature.
 *
 * Labels are resolved at call time via paraglide so the config object
 * stores getter functions instead of static strings.
 */
export const statusConfig: Record<
	string,
	{ label: string; variant: string; icon: typeof CheckCircle2 }
> = {
	get imported() {
		return { label: m.status_imported(), variant: 'badge-success', icon: CheckCircle2 };
	},
	get streaming() {
		return { label: m.status_streaming(), variant: 'badge-info', icon: CheckCircle2 };
	},
	get downloading() {
		return { label: m.status_downloading(), variant: 'badge-info', icon: Loader2 };
	},
	get importing() {
		return { label: m.status_importing(), variant: 'badge-info', icon: Loader2 };
	},
	get seeding() {
		return { label: m.status_seeding(), variant: 'badge-success', icon: Upload };
	},
	get paused() {
		return { label: m.status_paused(), variant: 'badge-warning', icon: Pause };
	},
	get failed() {
		return { label: m.status_failed(), variant: 'badge-error', icon: XCircle };
	},
	get search_error() {
		return { label: m.status_searchError(), variant: 'badge-warning', icon: SearchX };
	},
	get rejected() {
		return { label: m.status_rejected(), variant: 'badge-warning', icon: AlertCircle };
	},
	get removed() {
		return { label: m.status_removed(), variant: 'badge-ghost', icon: XCircle };
	},
	get no_results() {
		return { label: m.status_noResults(), variant: 'badge-ghost', icon: Minus };
	},
	get searching() {
		return { label: m.status_searching(), variant: 'badge-info', icon: Loader2 };
	}
} as Record<string, { label: string; variant: string; icon: typeof CheckCircle2 }>;

/**
 * Return the user-facing label for an activity's status.
 *
 * Handles special cases:
 * - "Import Failed" for queue items whose download succeeded but import failed
 * - Task-type-specific labels for search errors (e.g. "Missing Search Error")
 *
 * When no explicit fallback is provided, the label is looked up from
 * {@link statusConfig}.
 */
export function getStatusLabel(activity: UnifiedActivity, fallbackLabel?: string): string {
	if (isDebridMaterializing(activity)) {
		return m.status_materializing();
	}
	if (activity.status === 'failed' && isImportFailedActivity(activity)) {
		return m.activity_importFailed();
	}
	if (activity.status === 'search_error' && activity.taskType) {
		const taskLabel = TASK_TYPE_LABELS[activity.taskType];
		if (taskLabel) return m.activity_taskError({ task: taskLabel });
	}
	return fallbackLabel ?? statusConfig[activity.status]?.label ?? activity.status;
}

export function isDebridMaterializing(
	activity: Pick<UnifiedActivity, 'protocol' | 'queueStatus'>
): boolean {
	return activity.protocol === 'debrid' && activity.queueStatus === 'postprocessing';
}

/** Debrid providers do not expose pause or resume operations. */
export function supportsQueuePauseResume(activity: Pick<UnifiedActivity, 'protocol'>): boolean {
	return activity.protocol !== 'debrid';
}

/**
 * Compact progress-cell text for table layouts.
 *
 * Failed queue items may carry very long client error messages which do not fit
 * well in summary tables. In those cases we surface a short status label and
 * leave the full reason for the expanded detail view / tooltip.
 */
export function getCompactProgressLabel(activity: UnifiedActivity): string | null {
	if (!activity.statusReason) {
		return null;
	}

	if (activity.status === 'failed') {
		return m.status_error();
	}

	if (activity.status === 'search_error') {
		return m.status_searchError();
	}

	return activity.statusReason;
}

/**
 * Mobile-width progress-cell text.
 *
 * `statusReason` is free-form text (not a fixed set of reason codes), so unlike
 * `getMobileCompactStatusLabel` there's no small switch to hand-pick short copy
 * from - truncating it further would just cut words mid-way. Instead, narrow
 * widths fall back to the short status word alone (e.g. "No Results", "Paused");
 * the full reason stays available in the row's expanded detail view.
 */
export function getMobileCompactProgressLabel(
	activity: UnifiedActivity,
	fallbackLabel: string
): string | null {
	if (!activity.statusReason) {
		return null;
	}

	if (activity.status === 'failed') {
		return m.status_error();
	}

	if (activity.status === 'search_error') {
		return m.status_searchError();
	}

	return getStatusLabel(activity, fallbackLabel);
}

/**
 * Human-readable relative timestamp ("3m ago", "2d ago", etc.).
 *
 * Returns `'-'` when `dateStr` is null/undefined so callers don't need to
 * guard against missing values.
 */
export function formatRelativeTime(dateStr: string | null | undefined): string {
	if (!dateStr) return '-';
	const date = new Date(dateStr);
	const now = new Date();
	const diff = now.getTime() - date.getTime();
	const minutes = Math.floor(diff / 60000);
	const hours = Math.floor(diff / 3600000);
	const days = Math.floor(diff / 86400000);

	if (minutes < 1) return m.activity_relativeTime_justNow();
	if (minutes < 60) return m.activity_relativeTime_minutesAgo({ count: minutes });
	if (hours < 24) return m.activity_relativeTime_hoursAgo({ count: hours });
	return m.activity_relativeTime_daysAgo({ count: days });
}

/**
 * Extract a meaningful resolution badge string from an activity, or `null`
 * when no badge should be shown.
 *
 * Special-cases "Cinephage Library" streaming items that have no explicit
 * resolution by returning `'Auto'`.
 */
export function getResolutionBadge(activity: UnifiedActivity): string | null {
	const rawResolution = activity.quality?.resolution?.trim();
	if (rawResolution && rawResolution.toLowerCase() !== 'unknown') {
		return rawResolution;
	}

	const isCinephageLibraryStream =
		activity.protocol === 'streaming' &&
		(activity.indexerName?.toLowerCase().includes('cinephage library') ?? false);
	if (isCinephageLibraryStream) {
		return m.activity_resolutionAuto();
	}

	return null;
}

/**
 * Pick the most informative timestamp to show for an activity row.
 *
 * - Completed / streaming / monitoring-terminal → `completedAt`
 * - Failed → `lastAttemptAt` (most recent retry)
 * - Otherwise → `startedAt`
 */
export function getDisplayTime(activity: UnifiedActivity): string | null {
	if (activity.completedAt && (activity.status === 'imported' || activity.status === 'streaming')) {
		return activity.completedAt;
	}
	if (activity.completedAt && ['removed', 'rejected', 'no_results'].includes(activity.status)) {
		return activity.completedAt;
	}
	if (activity.status === 'failed' && activity.lastAttemptAt) {
		return activity.lastAttemptAt;
	}
	return activity.startedAt;
}

/**
 * Simple HH:MM time formatter for timeline displays.
 */
export function formatTimestamp(dateStr: string): string {
	const date = new Date(dateStr);
	return date.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
}

const SUBTITLE_TASK_TYPES = new Set(['missingSubtitles', 'subtitleUpgrade']);

const MEDIA_TASK_TYPES = new Set([
	'missing',
	'upgrade',
	'cutoffUnmet',
	'cutoff_unmet',
	'new_episode'
]);

interface ActivityCategoryTag {
	label: string;
	variant: string;
}

export function getCompactStatusLabel(
	activity: UnifiedActivity,
	fallbackLabel: string
): string | undefined {
	const tag = getActivityCategoryTag(activity);
	if (tag) return `${tag.label} ${getStatusLabel(activity, fallbackLabel)}`;
	return getStatusLabel(activity, fallbackLabel);
}

export function getMobileCompactStatusLabel(
	activity: UnifiedActivity,
	fallbackLabel: string
): string | undefined {
	if (activity.status === 'search_error') return m.action_search();
	if (activity.status === 'no_results') return m.status_noResults();

	const tag = getActivityCategoryTag(activity);
	if (tag?.label === m.activity_tag_download()) return getStatusLabel(activity, fallbackLabel);
	if (tag) return `${tag.label} ${fallbackLabel}`;
	return getStatusLabel(activity, fallbackLabel);
}

function getActivityCategoryTag(
	activity: Pick<UnifiedActivity, 'taskType' | 'activitySource'>
): ActivityCategoryTag | null {
	if (activity.taskType && SUBTITLE_TASK_TYPES.has(activity.taskType)) {
		return { label: m.activity_tag_sub(), variant: 'badge-ghost badge-xs' };
	}
	if (activity.taskType && MEDIA_TASK_TYPES.has(activity.taskType)) {
		return { label: m.activity_tag_media(), variant: 'badge-primary badge-xs' };
	}
	if (activity.taskType === 'smartListRefresh') {
		return { label: m.activity_tag_list(), variant: 'badge-ghost badge-xs' };
	}
	if (activity.taskType === 'media_move') {
		return { label: m.activity_tag_move(), variant: 'badge-ghost badge-xs' };
	}
	if (
		!activity.taskType &&
		(activity.activitySource === 'queue' || activity.activitySource === 'download_history')
	) {
		return { label: m.activity_tag_download(), variant: 'badge-accent badge-xs' };
	}
	return null;
}
