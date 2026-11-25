<script lang="ts">
	import {
		CheckCircle2,
		Eye,
		EyeOff,
		Trash2,
		Clapperboard,
		Tv,
		Disc3,
		Mic2,
		Zap,
		Search,
		Download
	} from '@lucide/svelte';
	import type { LibraryKind, MediaRowView } from './media-view.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		row: MediaRowView;
		selected: boolean;
		selectable: boolean;
		isLoading: boolean;
		downloadingIds: Set<string>;
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
		isLoading,
		downloadingIds,
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
	const downloading = $derived(downloadingIds.has(row.id));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="cursor-pointer rounded-xl bg-base-200 p-3 transition-colors active:bg-base-300"
	onclick={(e) => {
		const target = e.target as HTMLElement;
		if (target.closest('button, input, [role=toolbar]')) return;
		// In select mode a tap anywhere on the card, title included, toggles the
		// selection, the same as the grid card.
		if (selectable) {
			e.preventDefault();
			onSelectChange(row.id, !selected);
			return;
		}
		onNavigate();
	}}
>
	<div class="flex items-start justify-between gap-2">
		{#if selectable}
			<input
				type="checkbox"
				class="checkbox checkbox-sm checkbox-primary"
				checked={selected}
				onchange={(e) => onSelectChange(row.id, e.currentTarget.checked)}
			/>
		{/if}
		<div class="flex flex-1 flex-wrap items-center gap-1.5">
			{#if row.monitored}
				<span
					class="badge gap-1.5 badge-sm {row.partiallyMonitored
						? 'badge-warning'
						: 'badge-success'}"
				>
					<Eye class="h-3.5 w-3.5" />
					{row.partiallyMonitored
						? m.library_monitorToggle_partiallyMonitored()
						: m.library_monitorToggle_monitored()}
				</span>
			{:else}
				<span class="badge gap-1.5 badge-sm badge-neutral">
					<EyeOff class="h-3.5 w-3.5" />
					{m.library_monitorToggle_notMonitored()}
				</span>
			{/if}
			{#if row.state?.icon === 'file'}
				<span class="badge gap-1.5 badge-sm badge-success">
					<CheckCircle2 class="h-3.5 w-3.5" />
					{m.common_downloaded()}
				</span>
			{:else if downloading}
				<span class="badge gap-1.5 badge-sm badge-info">
					<Download class="h-3.5 w-3.5 animate-pulse" />
					{m.status_downloading()}
				</span>
			{:else if row.state}
				<span class="badge gap-1.5 badge-ghost badge-sm">{row.state.label}</span>
			{/if}
			{#if row.sizeLabel}
				<span class="badge gap-1.5 badge-sm badge-info">{row.sizeLabel}</span>
			{/if}
		</div>
		{#if onMonitorToggle || onDelete}
			<div class="flex shrink-0 items-center gap-1" role="toolbar">
				{#if onMonitorToggle}
					<button
						class="btn btn-ghost px-2 btn-xs"
						disabled={isLoading}
						onclick={() => onMonitorToggle(row.id, row.monitored)}
						aria-label={row.monitored ? m.common_unmonitored() : m.common_monitored()}
					>
						{#if row.monitored}
							<EyeOff class="h-4 w-4" />
						{:else}
							<Eye class="h-4 w-4" />
						{/if}
					</button>
				{/if}
				{#if onAutoGrab}
					<button
						class="btn btn-ghost px-2 btn-xs"
						disabled={isLoading}
						onclick={() => onAutoGrab(row.id)}
						aria-label={m.library_libraryMediaTable_autoGrabButton()}
					>
						<Zap class="h-4 w-4" />
					</button>
				{/if}
				{#if onManualGrab}
					<button
						class="btn btn-ghost px-2 btn-xs"
						disabled={isLoading}
						onclick={() => onManualGrab(row.id)}
						aria-label={m.library_libraryMediaTable_manualGrabButton()}
					>
						<Search class="h-4 w-4" />
					</button>
				{/if}
				{#if onDelete}
					<button
						class="btn btn-ghost px-2 text-error btn-xs"
						disabled={isLoading}
						onclick={() => onDelete(row.id)}
						aria-label={m.action_delete()}
					>
						<Trash2 class="h-4 w-4" />
					</button>
				{/if}
			</div>
		{/if}
	</div>

	<div class="mt-2 flex items-center gap-2">
		<div class="h-16 w-11 shrink-0 overflow-hidden rounded bg-base-300">
			{#if row.art?.source === 'tmdb'}
				<img
					src={`https://image.tmdb.org/t/p/w92${row.art.path}`}
					alt={row.title}
					class="h-full w-full object-cover"
					loading="lazy"
				/>
			{:else if row.art?.source === 'url'}
				<img src={row.art.url} alt={row.title} class="h-full w-full object-cover" loading="lazy" />
			{:else}
				<div class="flex h-full w-full items-center justify-center">
					<FallbackIcon class="h-5 w-5 opacity-40" />
				</div>
			{/if}
		</div>
		<div class="min-w-0 flex-1">
			<a
				href={selectable ? undefined : row.href}
				class="block truncate text-sm font-semibold hover:text-primary"
			>
				{row.title}
			</a>
			<div class="truncate text-xs text-base-content/50">
				{row.year ?? ''}
				{#if row.subtitle}<span class="ml-1">{row.subtitle}</span>{/if}
			</div>
			{#if row.progressLabel}
				<div class="mt-1 flex items-center gap-2">
					<span class="text-xs text-base-content/60">{row.progressLabel}</span>
					{#if row.progress !== null && row.progress > 0 && row.progress < 100}
						<progress class="progress w-16 progress-primary" value={row.progress} max="100"
						></progress>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</div>
