<script lang="ts">
	import type { LibraryMovie, LibrarySeries } from '#lib/types/library.js';
	import { displayTitle } from '#lib/types/library.js';
	import {
		CheckCircle2,
		XCircle,
		Eye,
		EyeOff,
		Trash2,
		Clapperboard,
		Tv,
		Zap,
		Search,
		Download
	} from '@lucide/svelte';
	import { formatBytes, getStatusColor } from '#lib/utils/format.js';
	import { formatSeriesStatus } from '#lib/utils/format-status.js';
	import { getPosterUrl } from '#lib/utils/poster-url.js';
	import { isMovie, isSeries, getItemSize, getQualityBadges } from './mediaTableUtils.ts';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		item: LibraryMovie | LibrarySeries;
		selected: boolean;
		selectable: boolean;
		isLoading: boolean;
		downloadingIds: Set<string>;
		hasStreamerProfile: boolean;
		onSelectChange: (id: string, selected: boolean) => void;
		onMonitorToggle?: (id: string) => void;
		onAutoGrab?: (id: string) => void;
		onManualGrab?: (id: string) => void;
		onDelete?: (id: string) => void;
		onNavigate: () => void;
		/** Instance default for items with no explicit prefer-original flag. */
		preferOriginalTitleDefault?: boolean | null;
	}

	let {
		item,
		selected,
		selectable,
		isLoading,
		downloadingIds,
		hasStreamerProfile,
		onSelectChange,
		onMonitorToggle,
		onAutoGrab,
		onManualGrab,
		onDelete,
		onNavigate,
		preferOriginalTitleDefault = false
	}: Props = $props();

	const itemIsMovie = $derived(isMovie(item));
	const size = $derived(getItemSize(item));
	const qualityBadges = $derived(getQualityBadges(item, () => hasStreamerProfile));
	const partiallyMonitored = $derived(
		isSeries(item) && (item as LibrarySeries).partiallyMonitored === true
	);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="cursor-pointer rounded-xl bg-base-200 p-3 transition-colors active:bg-base-300"
	onclick={(e) => {
		const target = e.target as HTMLElement;
		if (target.closest('button, input, [role=toolbar]')) return;
		onNavigate();
	}}
>
	<div class="flex items-start justify-between gap-2">
		{#if selectable}
			<input
				type="checkbox"
				class="checkbox checkbox-sm checkbox-primary"
				checked={selected}
				onchange={(e) => onSelectChange(item.id, e.currentTarget.checked)}
			/>
		{/if}
		<div class="flex flex-1 flex-wrap items-center gap-1.5">
			{#if item.monitored}
				<span
					class="badge gap-1.5 badge-sm {partiallyMonitored ? 'badge-warning' : 'badge-success'}"
				>
					<Eye class="h-3.5 w-3.5" />
					{partiallyMonitored
						? m.library_monitorToggle_partiallyMonitored()
						: m.library_monitorToggle_monitored()}
				</span>
			{:else}
				<span class="badge gap-1.5 badge-sm badge-neutral">
					<EyeOff class="h-3.5 w-3.5" />
					{m.library_monitorToggle_notMonitored()}
				</span>
			{/if}
			{#if itemIsMovie}
				{#if 'hasFile' in item && item.hasFile}
					<span class="badge gap-1.5 badge-sm badge-success">
						<CheckCircle2 class="h-3.5 w-3.5" />
						{m.common_downloaded()}
					</span>
				{:else if downloadingIds.has(item.id)}
					<span class="badge gap-1.5 badge-sm badge-info">
						<Download class="h-3.5 w-3.5 animate-pulse" />
						{m.status_downloading()}
					</span>
				{:else}
					<span class="badge gap-1.5 badge-sm badge-warning">
						<XCircle class="h-3.5 w-3.5" />
						{m.common_missing()}
					</span>
				{/if}
			{/if}
			{#if size > 0}
				<span class="badge gap-1.5 badge-sm badge-info">{formatBytes(size)}</span>
			{/if}
			{#if isSeries(item) && item.status}
				<span class="badge badge-sm {getStatusColor(item.status)}">
					{formatSeriesStatus(item.status)}
				</span>
			{/if}
		</div>
	</div>

	<div class="mt-2 flex items-start gap-3">
		{#if item.posterPath}
			<div class="shrink-0">
				<img
					src={getPosterUrl(item.posterPath)}
					alt={item.title}
					class="h-20 w-14 rounded object-cover"
					loading="lazy"
				/>
			</div>
		{:else}
			<div class="flex h-20 w-14 shrink-0 items-center justify-center rounded bg-base-300">
				{#if itemIsMovie}
					<Clapperboard class="h-6 w-6 opacity-40" />
				{:else}
					<Tv class="h-6 w-6 opacity-40" />
				{/if}
			</div>
		{/if}

		<div class="min-w-0 flex-1">
			<span class="line-clamp-2 text-sm font-medium">
				{displayTitle(item, preferOriginalTitleDefault)}
			</span>
			{#if itemIsMovie && 'collectionName' in item && item.collectionName}
				<span class="mt-1 badge badge-outline badge-xs">{item.collectionName}</span>
			{/if}
			<div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
				{#if item.year}
					<span class="text-xs text-base-content/60">({item.year})</span>
				{/if}
			</div>
			<div class="mt-1.5">
				{#if qualityBadges.length > 0}
					{#each qualityBadges as badge (`${badge.type}-${badge.label}`)}
						<span class="badge badge-outline badge-xs">{badge.label}</span>
					{/each}
				{/if}
			</div>

			{#if isSeries(item)}
				<div class="mt-1.5">
					<div class="flex items-center gap-2 text-xs text-base-content/60">
						<span>
							{m.library_libraryMediaTable_episodesCount({ count: item.episodeCount ?? 0 })}
						</span>
						{#if item.percentComplete === 100}
							<span class="badge badge-sm badge-success">
								<CheckCircle2 class="h-3 w-3" />
								{m.library_libraryMediaTable_completeBadge()}
							</span>
						{:else if item.percentComplete > 0}
							<span class="badge badge-xs badge-primary">{item.percentComplete}%</span>
						{/if}
						{#if downloadingIds.has(item.id)}
							<Download class="h-3.5 w-3.5 animate-pulse text-info" />
						{/if}
					</div>
					{#if (item.episodeCount ?? 0) > 0}
						<progress
							class="progress mt-1 h-1.5 w-full max-w-40 {item.percentComplete === 100
								? 'progress-success'
								: 'progress-primary'}"
							value={item.percentComplete}
							max="100"
						></progress>
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<div class="mt-2 flex justify-center gap-1 overflow-x-auto" role="toolbar">
		{#if onMonitorToggle}
			<button
				class="btn shrink-0 gap-1 btn-ghost btn-xs"
				onclick={() => onMonitorToggle(item.id)}
				disabled={isLoading}
			>
				{#if item.monitored}
					<EyeOff class="h-3.5 w-3.5" />
					{m.library_libraryMediaTable_unmonitorButton()}
				{:else}
					<Eye class="h-3.5 w-3.5" />
					{m.library_libraryMediaTable_monitorButton()}
				{/if}
			</button>
		{/if}
		{#if onAutoGrab}
			<button
				class="btn shrink-0 gap-1 btn-ghost btn-xs"
				onclick={() => onAutoGrab(item.id)}
				disabled={isLoading}
			>
				<Zap class="h-3.5 w-3.5" />
				{m.library_libraryMediaTable_autoButton()}
			</button>
		{/if}
		{#if onManualGrab}
			<button
				class="btn shrink-0 gap-1 btn-ghost btn-xs"
				onclick={() => onManualGrab(item.id)}
				disabled={isLoading}
			>
				<Search class="h-3.5 w-3.5" />
				{m.library_libraryMediaTable_manualButton()}
			</button>
		{/if}
		{#if onDelete}
			<button
				class="btn shrink-0 gap-1 btn-ghost btn-error btn-xs"
				onclick={() => onDelete(item.id)}
				disabled={isLoading}
			>
				<Trash2 class="h-3.5 w-3.5" />
				{m.action_delete()}
			</button>
		{/if}
	</div>
</div>
