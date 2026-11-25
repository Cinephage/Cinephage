<script lang="ts">
	import {
		CheckCircle2,
		XCircle,
		Eye,
		EyeOff,
		Trash2,
		Clapperboard,
		Tv,
		Disc3,
		Mic2,
		MoreVertical,
		Zap,
		Search,
		Download
	} from '@lucide/svelte';
	import { resolvePath } from '#lib/utils/routing.js';
	import { formatRelativeDate } from '#lib/utils/format-relative-date.js';
	import type { LibraryKind, MediaRowView } from './media-view.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		row: MediaRowView;
		selected: boolean;
		selectable: boolean;
		idx: number;
		isLoading: boolean;
		downloadingIds: Set<string>;
		showProgress: boolean;
		onSelectChange: (id: string, selected: boolean) => void;
		onMonitorToggle?: (id: string, monitored: boolean) => void;
		onAutoGrab?: (id: string) => void;
		onManualGrab?: (id: string) => void;
		onDelete?: (id: string) => void;
		onNavigate: () => void;
	}

	let {
		row,
		selected,
		selectable,
		idx,
		isLoading,
		downloadingIds,
		showProgress,
		onSelectChange,
		onMonitorToggle,
		onAutoGrab,
		onManualGrab,
		onDelete,
		onNavigate
	}: Props = $props();

	const FALLBACK_ICON: Record<LibraryKind, typeof Clapperboard> = {
		movie: Clapperboard,
		tv: Tv,
		album: Disc3,
		artist: Mic2
	};
	const FallbackIcon = $derived(FALLBACK_ICON[row.kind]);
	const missing = $derived(row.state?.tone === 'error');
	const relDate = $derived(row.added ? formatRelativeDate(row.added) : null);
	const isNearBottom = $derived(idx >= 10);
	const downloading = $derived(downloadingIds.has(row.id));
</script>

<tr
	class="cursor-pointer transition-colors hover:bg-base-200/60 {missing
		? 'bg-warning/5'
		: idx % 2 === 1
			? 'bg-base-200/30'
			: ''}"
	onclick={(e) => {
		const target = e.target as HTMLElement;
		if (target.closest('button, input, .dropdown')) return;
		// In select mode a click on the row, poster and title included, toggles
		// the selection instead of navigating, the same as the grid card.
		if (selectable) {
			e.preventDefault();
			onSelectChange(row.id, !selected);
			return;
		}
		if (target.closest('a')) return;
		onNavigate();
	}}
>
	{#if selectable}
		<td>
			<input
				type="checkbox"
				class="checkbox checkbox-sm checkbox-primary"
				checked={selected}
				onchange={(e) => onSelectChange(row.id, e.currentTarget.checked)}
			/>
		</td>
	{/if}

	<td>
		<a
			href={selectable ? undefined : resolvePath(row.href)}
			class="block h-14 w-10 overflow-hidden rounded bg-base-300"
		>
			{#if row.art?.source === 'tmdb'}
				<img
					src={`/api/images/tmdb/w92${row.art.path}`}
					alt={row.title}
					class="h-full w-full object-cover"
					loading="lazy"
				/>
			{:else if row.art?.source === 'url'}
				<img src={row.art.url} alt={row.title} class="h-full w-full object-cover" loading="lazy" />
			{:else}
				<div class="flex h-full w-full items-center justify-center">
					<FallbackIcon class="h-4 w-4 opacity-40" />
				</div>
			{/if}
		</a>
	</td>

	<td>
		<a
			href={selectable ? undefined : resolvePath(row.href)}
			class="block max-w-xs truncate text-base font-medium hover:text-primary"
		>
			{row.title}
		</a>
		{#if row.tag}
			<span class="mt-0.5 badge badge-outline badge-xs">{row.tag}</span>
		{:else if row.subtitle}
			<span class="mt-0.5 block max-w-xs truncate text-xs text-base-content/50">{row.subtitle}</span
			>
		{/if}
	</td>

	<td>
		<span class="text-base">{row.year ?? '-'}</span>
	</td>

	<td>
		<div class="flex items-center gap-1.5">
			{#if row.monitored}
				<span
					class="badge gap-1.5 badge-sm {row.partiallyMonitored
						? 'badge-warning'
						: 'badge-success'}"
					title={row.partiallyMonitored
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
			{#if row.state?.icon === 'file'}
				<span class="badge gap-1 badge-sm badge-success">
					<CheckCircle2 class="h-3 w-3" />
					{m.common_downloaded()}
				</span>
			{:else if downloading}
				<span class="badge gap-1 badge-sm badge-info">
					<Download class="h-3 w-3 animate-pulse" />
					{m.status_downloading()}
				</span>
			{:else if row.state?.icon === 'cross'}
				<span class="badge gap-1 badge-sm badge-warning">
					<XCircle class="h-3 w-3" />
					{m.common_missing()}
				</span>
			{:else if row.state}
				<span class="badge badge-ghost badge-sm" title={row.state.label}>{row.state.label}</span>
			{/if}
		</div>
	</td>

	<td>
		{#if row.profileLabel}
			<span class="badge badge-outline badge-sm">{row.profileLabel}</span>
		{:else if row.qualityBadges.length > 0}
			<div class="flex flex-wrap gap-1.5">
				{#each row.qualityBadges as badge (`${badge.type}-${badge.label}`)}
					<span class="badge badge-outline badge-sm">{badge.label}</span>
				{/each}
			</div>
		{:else}
			<span class="text-base text-base-content/40">-</span>
		{/if}
	</td>

	<td>
		<span class="text-base">{row.sizeLabel ?? '-'}</span>
	</td>

	{#if showProgress}
		<td>
			<div class="flex items-center gap-2">
				<span class="text-base">{row.progressLabel ?? '-'}</span>
				{#if row.progress !== null && row.progress > 0 && row.progress < 100}
					<progress class="progress w-16 progress-primary" value={row.progress} max="100"
					></progress>
				{/if}
				{#if row.progress === 100}
					<span class="badge badge-sm badge-success">
						<CheckCircle2 class="h-3 w-3" />
						{m.library_libraryMediaTable_completeBadge()}
					</span>
				{/if}
			</div>
		</td>
	{/if}

	<td>
		<span class="text-base text-base-content/60" title={relDate?.full ?? ''}>
			{relDate?.display ?? '-'}
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
					class="dropdown-content menu z-50 w-40 rounded-box border border-base-content/10 bg-base-200 p-2 shadow-lg"
				>
					{#if onMonitorToggle}
						<li>
							<button onclick={() => onMonitorToggle(row.id, row.monitored)}>
								{#if row.monitored}
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
							<button onclick={() => onAutoGrab(row.id)}>
								<Zap class="mr-2 h-4 w-4" />
								{m.library_libraryMediaTable_autoGrabButton()}
							</button>
						</li>
					{/if}
					{#if onManualGrab}
						<li>
							<button onclick={() => onManualGrab(row.id)}>
								<Search class="mr-2 h-4 w-4" />
								{m.library_libraryMediaTable_manualGrabButton()}
							</button>
						</li>
					{/if}
					{#if onDelete}
						<li>
							<button class="text-error" onclick={() => onDelete(row.id)}>
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
