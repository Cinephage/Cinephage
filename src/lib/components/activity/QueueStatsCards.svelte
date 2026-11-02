<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
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

	const INACTIVE_TILE =
		'border-base-content/12 bg-base-200 hover:border-base-content/25 hover:bg-base-200/80';
	const ACTIVE_TILE = 'border-primary/60 bg-primary/8 ring-1 ring-primary/30';

	function cardClass(status: QueueCardStatusFilter): string {
		// Status filters don't apply on the unmatched tab (different data
		// source) — only the Unmatched tile highlights there.
		if (unmatchedActive) return INACTIVE_TILE;
		return activeFilter === status ? ACTIVE_TILE : INACTIVE_TILE;
	}
</script>

<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
	<button
		type="button"
		class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all {cardClass(
			'all'
		)}"
		onclick={() => onFilterSelect('all')}
	>
		<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
			{m.activity_queueStats_total()}
		</p>
		<p class="text-3xl font-bold">{stats.totalCount}</p>
	</button>

	<button
		type="button"
		class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all {cardClass(
			'downloading'
		)}"
		onclick={() => onFilterSelect('downloading')}
	>
		<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
			{m.status_downloading()}
		</p>
		<p class="text-3xl font-bold text-info">{stats.downloadingCount}</p>
	</button>

	<button
		type="button"
		class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all {cardClass(
			'seeding'
		)}"
		onclick={() => onFilterSelect('seeding')}
	>
		<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
			{m.status_seeding()}
		</p>
		<p class="text-3xl font-bold text-success">{stats.seedingCount}</p>
	</button>

	<button
		type="button"
		class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all {cardClass(
			'paused'
		)}"
		onclick={() => onFilterSelect('paused')}
	>
		<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
			{m.status_paused()}
		</p>
		<p class="text-3xl font-bold text-warning">{stats.pausedCount}</p>
	</button>

	<button
		type="button"
		class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all {cardClass(
			'failed'
		)}"
		onclick={() => onFilterSelect('failed')}
	>
		<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
			{m.status_failed()}
		</p>
		<p class="text-3xl font-bold text-error">{stats.failedCount}</p>
	</button>

	<button
		type="button"
		class="flex cursor-pointer flex-col gap-1 rounded-lg border px-4 py-3 text-left shadow-sm transition-all {unmatchedActive
			? ACTIVE_TILE
			: INACTIVE_TILE}"
		onclick={() => onUnmatchedSelect?.()}
	>
		<p class="text-[11px] font-medium tracking-wide text-base-content/50 uppercase">
			{m.activity_queueStats_unmatched()}
		</p>
		<p class="text-3xl font-bold text-primary">{unmatchedCount ?? '–'}</p>
	</button>
</div>
