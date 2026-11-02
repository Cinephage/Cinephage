<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { Search, HardDrive, Film, Tv, X, SlidersHorizontal, ChevronDown } from '@lucide/svelte';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import { MediaExplorerTable } from '#lib/components/status/index.js';
	import { createProgressiveRenderer } from '#lib/utils/progressive-render.svelte.ts';
	import { formatBytes } from '#lib/utils/format.js';
	import type { PageData } from './$types';
	import * as m from '#lib/paraglide/messages.js';

	let { data }: { data: PageData } = $props();

	let searchQuery = $state('');

	let qualityExpanded = $derived(
		Object.entries(data.filters).some(
			([key, value]) =>
				!['sort', 'type', 'monitored', 'hasPlays', 'library'].includes(key) && value !== 'all'
		)
	);

	const filteredItems = $derived(
		searchQuery.trim()
			? data.items.filter((item) => item.title.toLowerCase().includes(searchQuery.toLowerCase()))
			: data.items
	);

	const renderer = createProgressiveRenderer(() => filteredItems);

	const hasActiveFilters = $derived(
		Object.entries(data.filters).some(([key, value]) => key !== 'sort' && value !== 'all')
	);

	const qualityActiveCount = $derived(
		[
			data.filters.classification,
			data.filters.resolution,
			data.filters.videoCodec,
			data.filters.hdrFormat,
			data.filters.audioCodec,
			data.filters.container,
			data.filters.rootFolder
		].filter((v) => v !== 'all').length
	);

	function updateUrlParam(key: string, value: string) {
		const url = new URL(page.url.href);
		if (value === 'all' || (key === 'sort' && value === 'title-asc')) {
			url.searchParams.delete(key);
		} else {
			url.searchParams.set(key, value);
		}
		goto(url.pathname + url.search, { reset: false });
	}

	function handleSortChange(sort: string) {
		updateUrlParam('sort', sort);
	}

	function handleClearAll() {
		searchQuery = '';
		goto(page.url.pathname, { reset: false });
	}

	function clearInsightScope() {
		const url = new URL(page.url.href);
		url.searchParams.delete('insightId');
		goto(url.pathname + url.search, { reset: false });
	}
</script>

<svelte:head>
	<title>{m.nav_mediaExplorer()}</title>
</svelte:head>

<SettingsPage
	title={m.status_media_title()}
	subtitle={m.status_media_subtitle()}
	backHref="/settings/monitoring/status"
	backLabel={m.nav_storageMaintenance()}
>
	{#snippet actions()}
		<div class="group relative w-56">
			<Search
				class="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-base-content/40 transition-colors group-focus-within:text-primary"
			/>
			<input
				type="text"
				placeholder="Search media..."
				class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
				bind:value={searchQuery}
			/>
			{#if searchQuery}
				<button
					class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 transition-colors hover:bg-base-300 hover:text-base-content"
					onclick={() => (searchQuery = '')}
					aria-label="Clear search"
				>
					<X class="h-3.5 w-3.5" />
				</button>
			{/if}
		</div>
	{/snippet}

	{#if data.insightContext}
		<div
			class="alert flex items-center justify-between gap-2 border border-info/20 bg-info/10 py-2 text-sm"
		>
			<span>
				{m.status_media_insightScope({
					count: data.totalCount,
					rawCount: data.insightContext.rawItemCount,
					title: data.insightContext.title
				})}
			</span>
			<button class="btn gap-1 btn-ghost btn-xs" onclick={clearInsightScope}>
				<X class="h-3 w-3" />
				{m.action_clear()}
			</button>
		</div>
	{/if}

	<!-- Stats bar -->
	<div class="flex flex-wrap items-center gap-3 text-sm text-base-content/70">
		<span class="badge badge-ghost badge-sm">
			{data.totalCount} item{data.totalCount !== 1 ? 's' : ''}
		</span>
		{#if data.totalFileSize > 0}
			<span class="badge badge-ghost badge-sm">
				<HardDrive class="h-3 w-3" />
				{formatBytes(data.totalFileSize)}
			</span>
		{/if}
		<span class="badge badge-ghost badge-sm">
			<Film class="h-3 w-3" />
			{data.movieCount} Movie{data.movieCount !== 1 ? 's' : ''}
		</span>
		<span class="badge badge-ghost badge-sm">
			<Tv class="h-3 w-3" />
			{data.seriesCount} Series
		</span>
		{#if hasActiveFilters}
			<button class="btn gap-1 btn-ghost text-base-content/50 btn-xs" onclick={handleClearAll}>
				<X class="h-3 w-3" />
				Clear filters
			</button>
		{/if}
	</div>

	<!-- Filter bar -->
	<div class="space-y-2">
		<!-- Tier 1: Primary filter chips -->
		<div class="flex flex-wrap items-center gap-2">
			<!-- Type filter -->
			<div class="join">
				<button
					class="btn join-item btn-sm {data.filters.type === 'all' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => updateUrlParam('type', 'all')}
				>
					All
				</button>
				<button
					class="btn join-item btn-sm {data.filters.type === 'movie' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => updateUrlParam('type', 'movie')}
				>
					<Film class="h-3.5 w-3.5" />
					Movies
				</button>
				<button
					class="btn join-item btn-sm {data.filters.type === 'tv' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => updateUrlParam('type', 'tv')}
				>
					<Tv class="h-3.5 w-3.5" />
					TV
				</button>
			</div>

			<!-- Status filter -->
			<div class="join">
				<button
					class="btn join-item btn-sm {data.filters.monitored === 'all'
						? 'btn-primary'
						: 'btn-ghost'}"
					onclick={() => updateUrlParam('monitored', 'all')}
				>
					All Status
				</button>
				<button
					class="btn join-item btn-sm {data.filters.monitored === 'monitored'
						? 'btn-primary'
						: 'btn-ghost'}"
					onclick={() => updateUrlParam('monitored', 'monitored')}
				>
					Monitored
				</button>
				<button
					class="btn join-item btn-sm {data.filters.monitored === 'unmonitored'
						? 'btn-primary'
						: 'btn-ghost'}"
					onclick={() => updateUrlParam('monitored', 'unmonitored')}
				>
					Unmonitored
				</button>
			</div>

			<!-- Plays filter -->
			<div class="join">
				<button
					class="btn join-item btn-sm {data.filters.hasPlays === 'all'
						? 'btn-primary'
						: 'btn-ghost'}"
					onclick={() => updateUrlParam('hasPlays', 'all')}
				>
					All Plays
				</button>
				<button
					class="btn join-item btn-sm {data.filters.hasPlays === 'played'
						? 'btn-primary'
						: 'btn-ghost'}"
					onclick={() => updateUrlParam('hasPlays', 'played')}
				>
					Played
				</button>
				<button
					class="btn join-item btn-sm {data.filters.hasPlays === 'neverPlayed'
						? 'btn-primary'
						: 'btn-ghost'}"
					onclick={() => updateUrlParam('hasPlays', 'neverPlayed')}
				>
					Never Played
				</button>
			</div>

			{#if (data.libraries?.length ?? 0) > 1}
				<select
					class="select-bordered select w-auto select-sm"
					value={data.filters.library}
					onchange={(e) => updateUrlParam('library', (e.target as HTMLSelectElement).value)}
				>
					<option value="all">All Libraries</option>
					{#each data.libraries ?? [] as lib (lib.id)}
						<option value={lib.id}>{lib.name}</option>
					{/each}
				</select>
			{/if}

			<!-- Quality toggle button -->
			<button
				class="btn btn-sm {qualityExpanded ? 'btn-active' : 'btn-ghost'} gap-1"
				onclick={() => (qualityExpanded = !qualityExpanded)}
			>
				<SlidersHorizontal class="h-4 w-4" />
				Quality &amp; Technical
				{#if qualityActiveCount > 0}
					<span class="badge badge-xs badge-primary">{qualityActiveCount}</span>
				{/if}
				<ChevronDown
					class="h-3.5 w-3.5 transition-transform {qualityExpanded ? 'rotate-180' : ''}"
				/>
			</button>
		</div>

		<!-- Tier 2: Quality & Technical filters (expandable) -->
		{#if qualityExpanded}
			<div class="flex flex-wrap items-center gap-2 rounded-lg bg-base-200/50 p-2">
				<select
					class="select-bordered select w-auto select-sm"
					value={data.filters.classification}
					onchange={(e) => updateUrlParam('classification', (e.target as HTMLSelectElement).value)}
				>
					<option value="all">All Classes</option>
					<option value="standard">Standard</option>
					<option value="anime">Anime</option>
				</select>

				{#if data.filterOptions.resolutions.length > 0}
					<select
						class="select-bordered select w-auto select-sm"
						value={data.filters.resolution}
						onchange={(e) => updateUrlParam('resolution', (e.target as HTMLSelectElement).value)}
					>
						<option value="all">All Resolutions</option>
						{#each data.filterOptions.resolutions as opt (opt)}
							<option value={opt}>{opt}</option>
						{/each}
					</select>
				{/if}

				{#if data.filterOptions.videoCodecs.length > 0}
					<select
						class="select-bordered select w-auto select-sm"
						value={data.filters.videoCodec}
						onchange={(e) => updateUrlParam('videoCodec', (e.target as HTMLSelectElement).value)}
					>
						<option value="all">All Codecs</option>
						{#each data.filterOptions.videoCodecs as opt (opt)}
							<option value={opt}>{opt}</option>
						{/each}
					</select>
				{/if}

				{#if data.filterOptions.hdrFormats.length > 0}
					<select
						class="select-bordered select w-auto select-sm"
						value={data.filters.hdrFormat}
						onchange={(e) => updateUrlParam('hdrFormat', (e.target as HTMLSelectElement).value)}
					>
						<option value="all">All HDR</option>
						{#each data.filterOptions.hdrFormats as opt (opt)}
							<option value={opt}>{opt}</option>
						{/each}
					</select>
				{/if}

				{#if data.filterOptions.audioCodecs.length > 0}
					<select
						class="select-bordered select w-auto select-sm"
						value={data.filters.audioCodec}
						onchange={(e) => updateUrlParam('audioCodec', (e.target as HTMLSelectElement).value)}
					>
						<option value="all">All Audio</option>
						{#each data.filterOptions.audioCodecs as opt (opt)}
							<option value={opt}>{opt}</option>
						{/each}
					</select>
				{/if}

				{#if data.filterOptions.containers.length > 0}
					<select
						class="select-bordered select w-auto select-sm"
						value={data.filters.container}
						onchange={(e) => updateUrlParam('container', (e.target as HTMLSelectElement).value)}
					>
						<option value="all">All Containers</option>
						{#each data.filterOptions.containers as opt (opt)}
							<option value={opt}>{opt}</option>
						{/each}
					</select>
				{/if}

				{#if (data.rootFolders?.length ?? 0) > 1}
					<select
						class="select-bordered select w-auto select-sm"
						value={data.filters.rootFolder}
						onchange={(e) => updateUrlParam('rootFolder', (e.target as HTMLSelectElement).value)}
					>
						<option value="all">All Folders</option>
						{#each data.rootFolders ?? [] as rf (rf.id)}
							<option value={rf.id}>{rf.name || rf.path}</option>
						{/each}
					</select>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Results -->
	{#if filteredItems.length === 0}
		<div class="py-16 text-center text-base-content/60">
			<HardDrive class="mx-auto mb-4 h-12 w-12 opacity-40" />
			<p class="text-lg font-medium">
				{#if searchQuery.trim()}
					No media matches "{searchQuery}"
				{:else if hasActiveFilters}
					No media matches the current filters
				{:else}
					No media in your library yet
				{/if}
			</p>
			{#if searchQuery.trim() || hasActiveFilters}
				<button class="btn mt-4 btn-ghost btn-sm" onclick={handleClearAll}>
					Clear all filters
				</button>
			{/if}
		</div>
	{:else}
		<MediaExplorerTable
			items={renderer.visible}
			currentSort={data.filters.sort}
			onSortChange={handleSortChange}
		/>

		{#if renderer.hasMore}
			<div bind:this={renderer.sentinel} class="h-1"></div>
		{/if}

		<div class="text-center text-xs text-base-content/50">
			Showing {renderer.visible.length} of {filteredItems.length} items
		</div>
	{/if}
</SettingsPage>
