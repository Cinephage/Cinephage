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
		MoreVertical,
		Zap,
		Search,
		Download
	} from '@lucide/svelte';
	import { resolvePath } from '#lib/utils/routing.js';
	import { formatBytes, getStatusColor } from '#lib/utils/format.js';
	import { formatRelativeDate } from '#lib/utils/format-relative-date.js';
	import { formatSeriesStatus } from '#lib/utils/format-status.js';
	import { getPosterUrl } from '#lib/utils/poster-url.js';
	import type { MediaType } from '#lib/utils/media-type.js';
	import {
		isMovie,
		isSeries,
		getItemSize,
		getQualityBadges,
		isItemMissing
	} from './mediaTableUtils.ts';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		item: LibraryMovie | LibrarySeries;
		mediaType: MediaType;
		selected: boolean;
		selectable: boolean;
		idx: number;
		isLoading: boolean;
		downloadingIds: Set<string>;
		hasStreamerProfile: boolean;
		profileName: string | null;
		isTv: boolean;
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
		mediaType,
		selected,
		selectable,
		idx,
		isLoading,
		downloadingIds,
		hasStreamerProfile,
		profileName,
		isTv,
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
	const missing = $derived(isItemMissing(item));
	const isNearBottom = $derived(idx >= 10);
	const relDate = $derived(formatRelativeDate(item.added));
	const partiallyMonitored = $derived(
		isSeries(item) && (item as LibrarySeries).partiallyMonitored === true
	);
</script>

<tr
	class="cursor-pointer transition-colors hover:bg-base-200/60 {missing
		? 'bg-warning/5'
		: idx % 2 === 1
			? 'bg-base-200/30'
			: ''}"
	onclick={(e) => {
		const target = e.target as HTMLElement;
		if (target.closest('button, input, a, .dropdown')) return;
		onNavigate();
	}}
>
	{#if selectable}
		<td>
			<input
				type="checkbox"
				class="checkbox checkbox-sm checkbox-primary"
				checked={selected}
				onchange={(e) => onSelectChange(item.id, e.currentTarget.checked)}
			/>
		</td>
	{/if}

	<td>
		{#if item.posterPath}
			<a href={resolvePath(`/library/${mediaType}/${item.id}`)}>
				<img
					src={getPosterUrl(item.posterPath)}
					alt={item.title}
					class="h-14 w-10 rounded object-cover"
					loading="lazy"
				/>
			</a>
		{:else}
			<div class="flex h-14 w-10 items-center justify-center rounded bg-base-300">
				{#if itemIsMovie}
					<Clapperboard class="h-4 w-4 opacity-40" />
				{:else}
					<Tv class="h-4 w-4 opacity-40" />
				{/if}
			</div>
		{/if}
	</td>

	<td>
		<a
			href={resolvePath(`/library/${mediaType}/${item.id}`)}
			class="block max-w-xs truncate text-base font-medium hover:text-primary"
		>
			{displayTitle(item, preferOriginalTitleDefault)}
		</a>
		{#if itemIsMovie && 'collectionName' in item && item.collectionName}
			<span class="mt-0.5 badge badge-outline badge-xs">{item.collectionName}</span>
		{/if}
	</td>

	<td>
		<span class="text-base">{item.year ?? '-'}</span>
	</td>

	<td>
		<div class="flex items-center gap-1.5">
			{#if item.monitored}
				<span
					class="badge gap-1.5 badge-sm {partiallyMonitored ? 'badge-warning' : 'badge-success'}"
					title={partiallyMonitored
						? m.library_monitorToggle_partiallyMonitored()
						: m.common_monitored()}
				>
					<Eye class="h-3.5 w-3.5" />
				</span>
			{:else}
				<span class="badge gap-1.5 badge-ghost badge-sm" title={m.common_unmonitored()}>
					<EyeOff class="h-3.5 w-3.5" />
				</span>
			{/if}
			{#if itemIsMovie}
				{#if 'hasFile' in item && item.hasFile}
					<span class="badge gap-1 badge-sm badge-success">
						<CheckCircle2 class="h-3 w-3" />
						{m.common_downloaded()}
					</span>
				{:else if downloadingIds.has(item.id)}
					<span class="badge gap-1 badge-sm badge-info">
						<Download class="h-3 w-3 animate-pulse" />
						{m.status_downloading()}
					</span>
				{:else}
					<span class="badge gap-1 badge-sm badge-warning">
						<XCircle class="h-3 w-3" />
						{m.common_missing()}
					</span>
				{/if}
			{/if}
			{#if isSeries(item) && item.status}
				<span class="badge badge-sm {getStatusColor(item.status)}">
					{formatSeriesStatus(item.status)}
				</span>
			{/if}
		</div>
	</td>

	<td>
		{#if isTv && isSeries(item)}
			{#if profileName}
				<span class="badge badge-outline badge-sm">{profileName}</span>
			{:else}
				<span class="text-base text-base-content/40">-</span>
			{/if}
		{:else if qualityBadges.length > 0}
			<div class="flex flex-wrap gap-1.5">
				{#each qualityBadges as badge (`${badge.type}-${badge.label}`)}
					<span class="badge badge-outline badge-sm">{badge.label}</span>
				{/each}
			</div>
		{:else}
			<span class="text-base text-base-content/40">-</span>
		{/if}
	</td>

	<td>
		<span class="text-base">{size > 0 ? formatBytes(size) : '-'}</span>
	</td>

	{#if isTv}
		<td>
			{#if isSeries(item)}
				<div class="flex items-center gap-2">
					<span class="text-base">
						{item.episodeFileCount ?? 0}/{item.episodeCount ?? 0}
					</span>
					{#if item.percentComplete > 0 && item.percentComplete < 100}
						<progress class="progress w-16 progress-primary" value={item.percentComplete} max="100"
						></progress>
					{/if}
					{#if item.percentComplete === 100}
						<span class="badge badge-sm badge-success">
							<CheckCircle2 class="h-3 w-3" />
							{m.library_libraryMediaTable_completeBadge()}
						</span>
					{/if}
					{#if downloadingIds.has(item.id)}
						<Download class="h-4 w-4 animate-pulse text-info" />
					{/if}
				</div>
			{/if}
		</td>
	{/if}

	<td>
		<span class="text-base text-base-content/60" title={relDate.full}>
			{relDate.display}
		</span>
	</td>

	<td>
		{#if onMonitorToggle || onAutoGrab || onManualGrab || onDelete}
			<div class="dropdown dropdown-end" class:dropdown-top={isNearBottom}>
				<div
					tabindex={isLoading ? -1 : 0}
					role="button"
					class="btn btn-ghost btn-xs"
					class:btn-disabled={isLoading}
				>
					<MoreVertical class="h-4 w-4" />
				</div>
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<ul
					tabindex="0"
					class="menu dropdown-content z-50 w-40 rounded-box border border-base-content/10 bg-base-200 p-2 shadow-lg"
				>
					{#if onMonitorToggle}
						<li>
							<button onclick={() => onMonitorToggle(item.id)}>
								{#if item.monitored}
									<EyeOff class="mr-2 h-4 w-4" />
									{m.library_libraryMediaTable_unmonitorButton()}
								{:else}
									<Eye class="mr-2 h-4 w-4" />
									{m.library_libraryMediaTable_monitorButton()}
								{/if}
							</button>
						</li>
					{/if}
					{#if onAutoGrab}
						<li>
							<button onclick={() => onAutoGrab(item.id)}>
								<Zap class="mr-2 h-4 w-4" />
								{m.library_libraryMediaTable_autoGrabButton()}
							</button>
						</li>
					{/if}
					{#if onManualGrab}
						<li>
							<button onclick={() => onManualGrab(item.id)}>
								<Search class="mr-2 h-4 w-4" />
								{m.library_libraryMediaTable_manualGrabButton()}
							</button>
						</li>
					{/if}
					{#if onDelete}
						<li>
							<button class="text-error" onclick={() => onDelete(item.id)}>
								<Trash2 class="mr-2 h-4 w-4" />
								{m.action_delete()}
							</button>
						</li>
					{/if}
				</ul>
			</div>
		{/if}
	</td>
</tr>
