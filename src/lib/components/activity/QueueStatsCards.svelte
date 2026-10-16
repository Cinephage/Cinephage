<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Activity, AlertTriangle, Download, Pause, Upload, Link2 } from '@lucide/svelte';
	import type {
		QueueCardStats,
		QueueCardStatusFilter
	} from '../../../routes/activity/activity-constants.js';

	interface Props {
		stats: QueueCardStats;
		activeFilter: QueueCardStatusFilter;
		onFilterSelect: (status: QueueCardStatusFilter) => void;
		unmatchedCount?: number | null;
		unmatchedActive?: boolean;
		onUnmatchedSelect?: () => void;
	}

	let {
		stats,
		activeFilter,
		onFilterSelect,
		unmatchedCount,
		unmatchedActive = false,
		onUnmatchedSelect
	}: Props = $props();

	function cardClass(status: QueueCardStatusFilter): string {
		// Status filters don't apply on the unmatched tab (different data
		// source) — only the Unmatched card highlights there.
		if (unmatchedActive) {
			return 'border-base-300 bg-base-200 hover:border-base-content/25';
		}
		return activeFilter === status
			? 'border-primary/80 bg-base-200'
			: 'border-base-300 bg-base-200 hover:border-base-content/25';
	}
</script>

<div class="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-3 xl:grid-cols-6">
	<button
		type="button"
		class="min-h-26 rounded-xl border p-3 text-left transition-colors sm:p-4 {cardClass('all')}"
		onclick={() => onFilterSelect('all')}
	>
		<div class="flex items-center justify-between">
			<span class="text-xs font-medium text-base-content/70 sm:text-sm"
				>{m.activity_queueStats_total()}</span
			>
			<Activity class="h-4 w-4 text-base-content/50" />
		</div>
		<div class="text-2xl font-bold">
			{stats.totalCount}
		</div>
	</button>

	<button
		type="button"
		class="min-h-26 rounded-xl border p-3 text-left transition-colors sm:p-4 {cardClass(
			'downloading'
		)}"
		onclick={() => onFilterSelect('downloading')}
	>
		<div class="flex items-center justify-between">
			<span class="text-xs font-medium text-base-content/70 sm:text-sm"
				>{m.status_downloading()}</span
			>
			<Download class="h-4 w-4 text-info" />
		</div>
		<div class="text-2xl font-bold">
			{stats.downloadingCount}
		</div>
	</button>

	<button
		type="button"
		class="min-h-26 rounded-xl border p-3 text-left transition-colors sm:p-4 {cardClass('seeding')}"
		onclick={() => onFilterSelect('seeding')}
	>
		<div class="flex items-center justify-between">
			<span class="text-xs font-medium text-base-content/70 sm:text-sm">{m.status_seeding()}</span>
			<Upload class="h-4 w-4 text-success" />
		</div>
		<div class="text-2xl font-bold">
			{stats.seedingCount}
		</div>
	</button>

	<button
		type="button"
		class="min-h-26 rounded-xl border p-3 text-left transition-colors sm:p-4 {cardClass('paused')}"
		onclick={() => onFilterSelect('paused')}
	>
		<div class="flex items-center justify-between">
			<span class="text-xs font-medium text-base-content/70 sm:text-sm">{m.status_paused()}</span>
			<Pause class="h-4 w-4 text-warning" />
		</div>
		<div class="text-2xl font-bold">
			{stats.pausedCount}
		</div>
	</button>

	<button
		type="button"
		class="min-h-26 rounded-xl border p-3 text-left transition-colors sm:p-4 {cardClass('failed')}"
		onclick={() => onFilterSelect('failed')}
	>
		<div class="flex items-center justify-between">
			<span class="text-xs font-medium text-base-content/70 sm:text-sm">{m.status_failed()}</span>
			<AlertTriangle class="h-4 w-4 text-error" />
		</div>
		<div class="text-2xl font-bold">
			{stats.failedCount}
		</div>
	</button>

	<button
		type="button"
		class="min-h-26 rounded-xl border p-3 text-left transition-colors sm:p-4 {unmatchedActive
			? 'border-primary/80 bg-base-200'
			: 'border-base-300 bg-base-200 hover:border-base-content/25'}"
		onclick={() => onUnmatchedSelect?.()}
	>
		<div class="flex items-center justify-between">
			<span class="text-xs font-medium text-base-content/70 sm:text-sm"
				>{m.activity_queueStats_unmatched()}</span
			>
			<Link2 class="h-4 w-4 text-primary" />
		</div>
		<div class="text-2xl font-bold">
			{unmatchedCount ?? '–'}
		</div>
	</button>
</div>
