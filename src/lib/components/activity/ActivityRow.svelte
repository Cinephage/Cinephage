<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		isImportFailedActivity,
		TASK_TYPE_LABELS,
		type UnifiedActivity
	} from '#lib/types/activity.js';
	import {
		Clapperboard,
		Tv,
		ChevronRight,
		Pause,
		Play,
		RotateCcw,
		Trash2,
		Ban
	} from '@lucide/svelte';
	import { getMediaLink, canLinkToMedia } from '#lib/utils/media-link.js';
	import { formatBytes } from '#lib/utils/format.js';
	import {
		statusConfig,
		getCompactStatusLabel,
		getMobileCompactStatusLabel,
		getResolutionBadge,
		supportsQueuePauseResume,
		formatRelativeTime,
		formatTimestamp,
		getDisplayTime
	} from './activity-display-utils.js';
	import ActivityStatusPopover from './ActivityStatusPopover.svelte';

	interface Props {
		activity: UnifiedActivity;
		isSelected: boolean;
		isSelectable: boolean;
		isExpanded: boolean;
		isQueueActionLoading: boolean;
		isBlocklistLoading: boolean;
		onToggle: () => void;
		onToggleSelection: (selected: boolean) => void;
		onQueueAction: (action: 'pause' | 'resume' | 'remove' | 'retry') => Promise<void>;
		onBlocklistHistory?: () => Promise<void>;
	}

	let {
		activity,
		isSelected,
		isSelectable,
		isExpanded,
		isQueueActionLoading,
		isBlocklistLoading,
		onToggle,
		onToggleSelection,
		onQueueAction,
		onBlocklistHistory
	}: Props = $props();

	const protocolLabels: Record<string, string> = {
		torrent: 'torrent',
		usenet: 'usenet',
		streaming: 'stream'
	};

	const config = $derived(statusConfig[activity.status] || statusConfig.no_results);

	const compactLabel = $derived(getCompactStatusLabel(activity, config.label));
	const mobileCompactLabel = $derived(getMobileCompactStatusLabel(activity, config.label));

	const timelineColspan = 9;

	const hasTimeline = $derived((activity.timeline?.length ?? 0) > 0);
	const canBlocklist = $derived(
		!!activity.downloadHistoryId && (activity.status === 'failed' || activity.status === 'rejected')
	);
	const hasExpandable = $derived(
		hasTimeline ||
			!!activity.queueItemId ||
			!!activity.statusReason ||
			!!activity.releaseTitle ||
			canBlocklist
	);

	function handleRowClick() {
		onToggle();
	}

	function handleCheckboxClick(e: MouseEvent) {
		e.stopPropagation();
		onToggleSelection((e.currentTarget as HTMLInputElement).checked);
	}
</script>

<tr
	class="cursor-pointer transition-colors {isSelected
		? 'bg-primary/5'
		: isExpanded
			? 'bg-base-200/60'
			: 'hover:bg-base-200/50'}"
	onclick={handleRowClick}
>
	<td class="w-10 px-2" onclick={(e) => e.stopPropagation()}>
		<input
			type="checkbox"
			class="checkbox checkbox-xs checkbox-primary"
			checked={isSelected}
			disabled={!isSelectable}
			aria-label={`Select ${activity.mediaTitle}`}
			onclick={handleCheckboxClick}
		/>
	</td>
	<td class="px-2">
		<div class="flex items-center gap-1">
			{#if hasExpandable}
				<ChevronRight
					class="h-3.5 w-3.5 shrink-0 text-base-content/30 transition-transform {isExpanded
						? 'rotate-90'
						: ''}"
				/>
			{/if}
			<ActivityStatusPopover {activity} {compactLabel} {mobileCompactLabel} />
		</div>
	</td>

	<td class="px-2">
		{#if canLinkToMedia(activity)}
			<a
				href={getMediaLink(activity)}
				class="flex items-center gap-1.5 hover:text-primary"
				onclick={(e) => e.stopPropagation()}
			>
				{#if activity.mediaType === 'movie'}
					<Clapperboard class="h-4 w-4 shrink-0" />
				{:else}
					<Tv class="h-4 w-4 shrink-0" />
				{/if}
				<span class="max-w-28 truncate sm:max-w-48" title={activity.mediaTitle}>
					{activity.mediaTitle}
					{#if activity.mediaYear}
						<span class="text-base-content/60">({activity.mediaYear})</span>
					{/if}
				</span>
			</a>
		{:else}
			<div class="flex items-center gap-1.5">
				{#if activity.mediaType === 'movie'}
					<Clapperboard class="h-4 w-4 shrink-0" />
				{:else}
					<Tv class="h-4 w-4 shrink-0" />
				{/if}
				<span class="max-w-28 truncate sm:max-w-48" title={activity.mediaTitle}>
					{activity.mediaTitle}
					{#if activity.mediaYear}
						<span class="text-base-content/60">({activity.mediaYear})</span>
					{/if}
				</span>
			</div>
		{/if}
	</td>

	<td class="hidden lg:table-cell">
		<span class="block max-w-64 truncate text-sm" title={activity.releaseTitle || '-'}>
			{activity.releaseTitle || '-'}
		</span>
	</td>

	<td class="hidden lg:table-cell">
		{#if activity.quality}
			<div class="flex flex-wrap gap-1">
				{#if getResolutionBadge(activity)}
					<span class="badge badge-outline badge-xs">{getResolutionBadge(activity)}</span>
				{/if}
				{#if activity.quality.source}
					<span class="badge badge-outline badge-xs">{activity.quality.source}</span>
				{/if}
				{#if activity.quality.codec}
					<span class="badge badge-outline badge-xs">{activity.quality.codec}</span>
				{/if}
				{#if activity.quality.hdr}
					<span class="badge badge-outline badge-xs">{activity.quality.hdr}</span>
				{/if}
			</div>
		{:else}
			<span class="text-base-content/40">-</span>
		{/if}
	</td>

	<td class="hidden lg:table-cell">
		<span class="text-sm">{activity.releaseGroup || '-'}</span>
	</td>

	<td class="hidden lg:table-cell">
		<span class="text-sm">{formatBytes(activity.size)}</span>
	</td>

	<td class="hidden lg:table-cell">
		{#if activity.activitySource === 'monitoring' && activity.taskType}
			{@const taskLabel = TASK_TYPE_LABELS[activity.taskType]}
			<div class="text-sm">
				<span class="text-base-content/70">{taskLabel ?? activity.taskType}</span>
			</div>
		{:else if activity.indexerName}
			<div class="text-sm">
				<span>{activity.indexerName}</span>
				{#if activity.protocol}
					<span class="text-base-content/50"
						>({protocolLabels[activity.protocol] || activity.protocol})</span
					>
				{/if}
			</div>
		{:else}
			<span class="text-base-content/40">-</span>
		{/if}
	</td>

	<td class="px-2">
		<div class="text-xs text-base-content/50" title={getDisplayTime(activity)}>
			{formatRelativeTime(getDisplayTime(activity))}
		</div>
	</td>
</tr>

{#if isExpanded && hasExpandable}
	<tr>
		<td colspan={timelineColspan} class="border-b border-base-content/10 p-0">
			<div class="border-l-4 border-l-primary bg-base-200 py-3 pr-6 pl-10">
				<div class="flex flex-wrap items-start gap-x-6 gap-y-2">
					{#if hasTimeline}
						<div class="flex flex-wrap items-center gap-1.5 text-sm">
							<span
								class="mr-1 text-[10px] font-bold tracking-widest text-base-content/50 uppercase"
								>{m.activity_table_timeline()}</span
							>
							{#each activity.timeline ?? [] as event, i (event.timestamp + event.type)}
								<span class="flex items-center gap-1 rounded bg-base-100 px-2 py-1">
									<span class="capitalize">{event.type}</span>
									<span class="text-base-content/50">({formatTimestamp(event.timestamp)})</span>
								</span>
								{#if i < (activity.timeline?.length ?? 0) - 1}
									<span class="text-base-content/30">→</span>
								{/if}
							{/each}
						</div>
					{/if}

					{#if activity.isUpgrade && activity.oldScore !== undefined && activity.newScore !== undefined}
						<div class="text-sm">
							<span class="font-medium text-base-content/55">{m.activity_table_upgrade()}</span>
							<span class="font-semibold">{activity.oldScore} → {activity.newScore}</span>
						</div>
					{/if}

					{#if activity.transferMode}
						<div class="flex flex-wrap items-center gap-1.5 text-sm">
							<span
								class="mr-1 text-[10px] font-bold tracking-widest text-base-content/50 uppercase"
								>{m.activity_detail_transferMode()}</span
							>
							<span
								class="rounded bg-base-100 px-2 py-1 font-semibold"
								class:text-warning={activity.transferMode === 'copy'}
								title={activity.transferMode === 'copy'
									? m.activity_detail_transferModeCopyWarning()
									: undefined}
							>
								{activity.transferMode === 'hardlink'
									? m.activity_detail_transferModeHardlink()
									: activity.transferMode === 'copy'
										? m.activity_detail_transferModeCopy()
										: activity.transferMode === 'move'
											? m.activity_detail_transferModeMove()
											: activity.transferMode === 'skip-duplicate'
												? m.activity_detail_transferModeSkipDuplicate()
												: m.activity_detail_transferModeSymlink()}
							</span>
						</div>
					{/if}

					{#if activity.queueItemId || canBlocklist}
						<div class="ml-auto flex flex-wrap items-center gap-2">
							{#if activity.queueItemId}
								{#if supportsQueuePauseResume(activity) && (activity.status === 'downloading' || activity.status === 'seeding')}
									<button
										class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-sm hover:bg-base-200"
										onclick={() => onQueueAction('pause')}
										disabled={isQueueActionLoading}
									>
										<Pause class="h-3.5 w-3.5" />
										{m.action_pause()}
									</button>
								{:else if supportsQueuePauseResume(activity) && activity.status === 'paused'}
									<button
										class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-sm hover:bg-base-200"
										onclick={() => onQueueAction('resume')}
										disabled={isQueueActionLoading}
									>
										<Play class="h-3.5 w-3.5" />
										{m.action_resume()}
									</button>
								{/if}

								{#if activity.status === 'failed'}
									<button
										class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-sm hover:bg-base-200"
										onclick={() => onQueueAction('retry')}
										disabled={isQueueActionLoading}
									>
										<RotateCcw class="h-3.5 w-3.5" />
										{isImportFailedActivity(activity)
											? m.activity_detail_retryImport()
											: m.common_retry()}
									</button>
								{/if}

								<button
									class="btn gap-1.5 border border-error/30 bg-base-100 text-error btn-sm hover:bg-error/10"
									onclick={() => onQueueAction('remove')}
									disabled={isQueueActionLoading}
								>
									<Trash2 class="h-3.5 w-3.5" />
									{m.action_remove()}
								</button>
							{/if}

							{#if canBlocklist}
								{#if activity.isBlocklisted}
									<span class="badge gap-1.5 badge-ghost">
										<Ban class="h-3 w-3" />
										{m.activity_detail_alreadyBlocklisted()}
									</span>
								{:else if onBlocklistHistory}
									<button
										class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-sm hover:bg-base-200"
										onclick={onBlocklistHistory}
										disabled={isBlocklistLoading}
									>
										<Ban class="h-3.5 w-3.5" />
										{m.activity_detail_addToBlocklist()}
									</button>
								{/if}
							{/if}
						</div>
					{/if}
				</div>

				{#if activity.releaseTitle}
					<div
						class="mt-2 rounded-lg border border-base-content/12 bg-base-100 px-3 py-2 font-mono text-sm break-all"
					>
						<span class="mr-2 font-semibold text-base-content/50">{m.activity_table_release()}</span
						>
						<span class="text-base-content/80">{activity.releaseTitle}</span>
					</div>
				{/if}

				<!-- Narrow viewports hide the Quality/Group/Size/Source columns (see
				     ActivityTableHeader); surface them here instead of losing them. -->
				<div
					class="mt-2 overflow-hidden rounded-lg border border-base-content/12 bg-base-100 shadow-sm lg:hidden"
				>
					<div
						class="flex items-center justify-between border-b border-base-content/8 px-3 py-2 text-sm"
					>
						<span class="font-medium text-base-content/55">{m.activity_detail_mediaType()}</span>
						<span class="badge badge-outline badge-sm capitalize">{activity.mediaType}</span>
					</div>
					{#if activity.quality}
						<div
							class="flex items-center justify-between border-b border-base-content/8 px-3 py-2 text-sm"
						>
							<span class="font-medium text-base-content/55">{m.activity_table_quality()}</span>
							<div class="flex flex-wrap justify-end gap-1">
								{#if getResolutionBadge(activity)}
									<span class="badge badge-outline badge-xs">{getResolutionBadge(activity)}</span>
								{/if}
								{#if activity.quality.source}
									<span class="badge badge-outline badge-xs">{activity.quality.source}</span>
								{/if}
								{#if activity.quality.codec}
									<span class="badge badge-outline badge-xs">{activity.quality.codec}</span>
								{/if}
								{#if activity.quality.hdr}
									<span class="badge badge-outline badge-xs">{activity.quality.hdr}</span>
								{/if}
							</div>
						</div>
					{/if}
					<div
						class="flex items-center justify-between border-b border-base-content/8 px-3 py-2 text-sm"
					>
						<span class="font-medium text-base-content/55">{m.common_size()}</span>
						<span class="font-semibold">{formatBytes(activity.size)}</span>
					</div>
					<div
						class="flex items-center justify-between border-b border-base-content/8 px-3 py-2 text-sm"
					>
						<span class="font-medium text-base-content/55">{m.activity_table_group()}</span>
						<span class="text-base-content/70">{activity.releaseGroup || '-'}</span>
					</div>
					<div class="flex items-center justify-between px-3 py-2 text-sm">
						<span class="font-medium text-base-content/55">{m.activity_table_source()}</span>
						<span class="text-base-content/70"
							>{activity.indexerName || '-'}{#if activity.protocol}
								<span class="text-base-content/40"
									>({protocolLabels[activity.protocol] || activity.protocol})</span
								>
							{/if}</span
						>
					</div>
				</div>

				{#if activity.importedPath}
					<div
						class="mt-2 rounded-lg border border-base-content/12 bg-base-100 px-3 py-2 font-mono text-sm break-all"
					>
						<span class="mr-2 font-semibold text-base-content/50"
							>{m.activity_table_importedTo()}</span
						>
						<span class="text-base-content/80">{activity.importedPath}</span>
					</div>
				{/if}

				{#if activity.statusReason}
					<div
						class="mt-2 rounded-lg border px-3 py-2 text-sm{activity.status === 'failed'
							? 'border-error/30 bg-error/5'
							: 'border-base-content/12 bg-base-100'}"
					>
						<span
							class="mr-2 font-semibold {activity.status === 'failed'
								? 'text-error'
								: 'text-base-content/50'}">{m.activity_detail_statusReason()}</span
						>
						<span class={activity.status === 'failed' ? 'text-error/90' : 'text-base-content/70'}
							>{activity.statusReason}</span
						>
					</div>
				{/if}
			</div>
		</td>
	</tr>
{/if}
