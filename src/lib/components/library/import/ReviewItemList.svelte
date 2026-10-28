<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { ChevronDown } from '@lucide/svelte';
	import type { DetectionGroup, DetectionSection, MatchResult } from './types.js';

	type ReviewStatus = 'needsInput' | 'ready' | 'skipped' | 'imported';

	let {
		movieSections = [],
		tvSections = [],
		selectedGroupId = null as string | null,
		importedGroupIds = [],
		skippedGroupIds = [],
		canImportGroup = (_group: DetectionGroup) => false,
		suggestsTvFromMovie = (_group: DetectionGroup) => false,
		getSeriesSectionStatus = (_section: DetectionSection) => 'needsInput' as ReviewStatus,
		getGroupSelectedMatch = (_group: DetectionGroup) => null as MatchResult | null,
		getGroupActionLabel = (_group: DetectionGroup) => null as 'link' | 'enroll' | null,
		onSelectGroup = (_id: string) => {},
		onSelectSeries = (_id: string) => {}
	}: {
		movieSections: DetectionSection[];
		tvSections: DetectionSection[];
		selectedGroupId?: string | null;
		importedGroupIds?: string[];
		skippedGroupIds?: string[];
		canImportGroup: (group: DetectionGroup) => boolean;
		suggestsTvFromMovie?: (group: DetectionGroup) => boolean;
		getSeriesSectionStatus: (section: DetectionSection) => ReviewStatus;
		getGroupSelectedMatch?: (group: DetectionGroup) => MatchResult | null;
		getGroupActionLabel?: (group: DetectionGroup) => 'link' | 'enroll' | null;
		onSelectGroup: (id: string) => void;
		onSelectSeries: (id: string) => void;
	} = $props();

	const movieCount = $derived(
		movieSections.reduce((total, section) => total + section.items.length, 0)
	);

	let moviesExpanded = $state(true);
	let tvExpanded = $state(true);
</script>

<div class="space-y-3">
	{#if movieSections.length > 0}
		<button
			type="button"
			class="flex w-full items-center justify-between rounded-md bg-base-200/60 px-2 py-1"
			onclick={() => (moviesExpanded = !moviesExpanded)}
		>
			<span class="flex items-center gap-1.5">
				<ChevronDown
					class="h-3.5 w-3.5 text-base-content/60 transition-transform {moviesExpanded
						? ''
						: '-rotate-90'}"
				/>
				<span class="text-[11px] font-bold tracking-widest text-base-content/90 uppercase"
					>{m.common_movies()}</span
				>
			</span>
			<span class="badge text-xs font-medium text-base-content/90 badge-info">{movieCount}</span>
		</button>
	{/if}
	{#if movieSections.length > 0 && moviesExpanded}
		<div class="max-h-72 space-y-2 overflow-y-auto pr-1">
			{#each movieSections as section (section.id)}
				{#each section.items as group (group.id)}
					{@const groupMatch = getGroupSelectedMatch(group)}
					{@const isActive = selectedGroupId === group.id}
					<button
						type="button"
						class="w-full rounded-lg border p-2 text-left transition-colors sm:p-3 {isActive
							? 'border-primary bg-primary/5'
							: 'border-base-300 hover:bg-base-200/50'}"
						onclick={() => onSelectGroup(group.id)}
					>
						<div class="flex items-center justify-between gap-2">
							<div class="min-w-0 flex-1">
								<div class="truncate text-sm font-medium sm:text-base">
									{groupMatch
										? `${groupMatch.title}${groupMatch.year ? ` (${groupMatch.year})` : ''}`
										: group.displayName}
								</div>
								<div class="mt-0.5 flex items-center gap-1 truncate text-xs text-base-content/50">
									<span class="truncate">{group.fileName}</span>
									{#if !groupMatch && !importedGroupIds.includes(group.id) && !skippedGroupIds.includes(group.id)}
										<span class="shrink-0">· {m.library_import_noMatchFoundInline()}</span>
									{/if}
								</div>
								{#if suggestsTvFromMovie(group)}
									<span class="mt-1 badge badge-outline badge-xs text-info"
										>{m.library_import_looksLikeTvBadge()}</span
									>
								{/if}
							</div>
							<div class="flex shrink-0 items-center gap-2">
								{#if importedGroupIds.includes(group.id)}
									<span class="badge badge-sm badge-success"
										>{m.library_import_badgeImported()}</span
									>
								{:else if skippedGroupIds.includes(group.id)}
									<span class="badge badge-ghost badge-sm">{m.library_import_badgeSkipped()}</span>
								{:else if getGroupActionLabel(group) === 'link'}
									<span class="badge badge-sm badge-info">{m.activity_unmatched_linkNow()}</span>
								{:else if getGroupActionLabel(group) === 'enroll'}
									<span class="badge badge-outline badge-sm"
										>{m.activity_unmatched_enrollAction()}</span
									>
								{:else if canImportGroup(group)}
									<span class="badge badge-sm badge-success">{m.library_import_ready()}</span>
								{:else}
									<span class="badge badge-sm badge-warning">{m.library_import_needsInput()}</span>
								{/if}
							</div>
						</div>
					</button>
				{/each}
			{/each}
		</div>
		<!-- Divider -->
		<div class="border-t border-base-300"></div>
	{/if}

	{#if tvSections.length > 0}
		<button
			type="button"
			class="flex w-full items-center justify-between rounded-md bg-base-200/60 px-2 py-1"
			onclick={() => (tvExpanded = !tvExpanded)}
		>
			<span class="flex items-center gap-1.5">
				<ChevronDown
					class="h-3.5 w-3.5 text-base-content/60 transition-transform {tvExpanded
						? ''
						: '-rotate-90'}"
				/>
				<span class="text-[11px] font-bold tracking-widest text-base-content/90 uppercase"
					>{m.common_tvShows()}</span
				>
			</span>
			<span class="badge text-xs font-medium text-base-content/90 badge-info"
				>{tvSections.length}</span
			>
		</button>
	{/if}
	{#if tvSections.length > 0 && tvExpanded}
		<div class="max-h-80 space-y-2 overflow-y-auto pr-1">
			{#each tvSections as section (section.id)}
				{@const seriesStatus = getSeriesSectionStatus(section)}
				{@const isActiveSeries = section.items.some((group) => group.id === selectedGroupId)}
				<button
					type="button"
					class="w-full rounded-lg border p-2 text-left transition-colors sm:p-3 {isActiveSeries
						? 'border-primary bg-primary/5'
						: 'border-base-300 hover:bg-base-200/50'}"
					onclick={() => onSelectSeries(section.id)}
				>
					<div class="flex items-center justify-between gap-2">
						<div class="min-w-0 flex-1">
							<div class="truncate text-sm font-medium sm:text-base">{section.label}</div>
							<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-base-content/70">
								<span
									>{section.items.length === 1
										? m.library_import_episodeCountSingular({ count: section.items.length })
										: m.library_import_episodeCount({ count: section.items.length })}</span
								>
								{#if section.seasonSections && section.seasonSections.length > 0}
									<span>•</span>
									<span
										>{section.seasonSections.length === 1
											? m.library_import_seasonNumber({
													number: section.seasonSections[0].seasonNumber ?? 0
												})
											: m.library_import_seasonCount({
													count: section.seasonSections.length
												})}</span
									>
								{/if}
								<!-- Divider -->
								<div class="border-t border-base-300"></div>
							</div>
						</div>
						<div class="flex shrink-0 items-center gap-2">
							{#if seriesStatus === 'imported'}
								<span class="badge badge-sm badge-success">{m.library_import_badgeImported()}</span>
							{:else if seriesStatus === 'ready'}
								<span class="badge badge-sm badge-success">{m.library_import_ready()}</span>
							{:else}
								<span class="badge badge-sm badge-warning">{m.library_import_needsInput()}</span>
							{/if}
						</div>
					</div>
				</button>
			{/each}
		</div>
	{/if}
</div>
