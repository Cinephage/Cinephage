<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { untrack } from 'svelte';
	import {
		Check,
		ChevronDown,
		ChevronUp,
		Clapperboard,
		Loader2,
		Search,
		Tv,
		X
	} from '@lucide/svelte';
	import type {
		MediaType,
		DetectionGroup,
		DetectionSection,
		TvSeasonSection,
		MatchResult
	} from './types.js';

	type ReviewStatus = 'needsInput' | 'ready' | 'skipped' | 'imported';

	interface ImportRouteContext {
		mediaType: MediaType;
		tmdbId: number;
		libraryId: string | null;
		title: string | null;
		year: number | null;
	}

	let {
		activeGroup = null as DetectionGroup | null,
		selectedMediaType = 'movie' as MediaType,
		selectedMatch = null as MatchResult | null,
		searchQuery = $bindable(''),
		matchCandidates = [],
		// eslint-disable-next-line no-useless-assignment, @typescript-eslint/no-unused-vars
		importTarget = $bindable('new' as 'new' | 'existing'),
		seasonNumber = $bindable(1),
		episodeNumber = $bindable(1),
		batchSeasonOverride = $bindable(null as number | null),
		// eslint-disable-next-line no-useless-assignment, @typescript-eslint/no-unused-vars
		selectedRootFolder = $bindable(''),
		isMediaTypeLockedByContext = false,
		isBatchTvImport = false,
		isGroupImported = false,
		isGroupSkipped = false,
		skipActionsEnabled = false,
		searchingMatches = false,
		routeImportContext = null as ImportRouteContext | null,
		selectedMatchContextMismatch = false,
		parsedSourceContextMismatch = false,
		canApplyMatchSelectionToActiveSeason = false,
		applyMatchToSeasonOnSelect = $bindable(false),
		canImportGroup = (_group: DetectionGroup) => false,
		canApplyActiveSeasonOverride = () => false,
		suggestsTvFromMovie = (_group: DetectionGroup) => false,
		activeReviewTvSection = null as DetectionSection | null,
		activeReviewSeasonSection = null as TvSeasonSection | null,
		getGroupStatus = (_group: DetectionGroup) => 'needsInput' as ReviewStatus,
		getSeriesSectionStatus = (_section: DetectionSection) => 'needsInput' as ReviewStatus,
		getSeasonSectionStatus = (_season: TvSeasonSection) => 'needsInput' as ReviewStatus,
		hasUnknownSeasonItems = (_section: DetectionSection) => false,
		getSectionSeasonOverride = (_section: DetectionSection) => null as number | null,
		getSkippableSeasonGroups = (_season: TvSeasonSection) => [] as DetectionGroup[],
		getSeasonSectionSkippedCount = (_season: TvSeasonSection) => 0,
		isSeasonSectionFullySkipped = (_season: TvSeasonSection) => false,
		isSeriesSectionFullySkipped = (_section: DetectionSection) => false,
		canApplySelectedMatchToSeason = (_season: TvSeasonSection) => false,
		canApplySelectedMatchToSeries = (_section: DetectionSection) => false,
		getGroupEpisodeInfo = (_group: DetectionGroup) =>
			null as { season: number; episode: number; title?: string } | null,
		onSwitchMediaType = (_type: MediaType) => {},
		onChooseMatch = (_match: MatchResult) => {},
		onSearchInput = (_event: Event) => {},
		onSearch = () => {},
		onClearSearch = () => {},
		onSeasonNumberChange = () => {},
		onEpisodeNumberChange = () => {},
		onToggleSkip = () => {},
		onSwitchGroup = (_id: string) => {},
		onSkipGroup = (_id: string) => {},
		onUnskipGroup = (_id: string) => {},
		onSelectReviewSeasonSection = (_key: string) => {},
		onApplyMatchToSeason = (_season: TvSeasonSection) => {},
		onToggleSeasonSkipped = (_season: TvSeasonSection) => {},
		onApplyMatchToAllSeasons = (_section: DetectionSection) => {},
		onToggleSeriesSkipped = (_section: DetectionSection) => {},
		onSeasonOverrideChange = (_section: DetectionSection, _seasonNumber: number | null) => {}
	}: {
		activeGroup: DetectionGroup | null;
		selectedMediaType: MediaType;
		selectedMatch: MatchResult | null;
		searchQuery: string;
		matchCandidates: MatchResult[];
		importTarget: 'new' | 'existing';
		seasonNumber: number;
		episodeNumber: number;
		batchSeasonOverride: number | null;
		selectedRootFolder: string;
		isMediaTypeLockedByContext: boolean;
		isBatchTvImport: boolean;
		isGroupImported: boolean;
		isGroupSkipped: boolean;
		skipActionsEnabled: boolean;
		searchingMatches: boolean;
		routeImportContext: ImportRouteContext | null;
		selectedMatchContextMismatch: boolean;
		parsedSourceContextMismatch: boolean;
		canApplyMatchSelectionToActiveSeason: boolean;
		applyMatchToSeasonOnSelect: boolean;
		canImportGroup: (group: DetectionGroup) => boolean;
		canApplyActiveSeasonOverride: () => boolean;
		suggestsTvFromMovie: (group: DetectionGroup) => boolean;
		activeReviewTvSection: DetectionSection | null;
		activeReviewSeasonSection: TvSeasonSection | null;
		getGroupStatus: (group: DetectionGroup) => ReviewStatus;
		getSeriesSectionStatus: (section: DetectionSection) => ReviewStatus;
		getSeasonSectionStatus: (season: TvSeasonSection) => ReviewStatus;
		hasUnknownSeasonItems: (section: DetectionSection) => boolean;
		getSectionSeasonOverride: (section: DetectionSection) => number | null;
		getSkippableSeasonGroups: (season: TvSeasonSection) => DetectionGroup[];
		getSeasonSectionSkippedCount: (season: TvSeasonSection) => number;
		isSeasonSectionFullySkipped: (season: TvSeasonSection) => boolean;
		isSeriesSectionFullySkipped: (section: DetectionSection) => boolean;
		canApplySelectedMatchToSeason: (season: TvSeasonSection) => boolean;
		canApplySelectedMatchToSeries: (section: DetectionSection) => boolean;
		getGroupEpisodeInfo: (group: DetectionGroup) => {
			season: number;
			episode: number;
			title?: string;
		} | null;
		onSwitchMediaType: (type: MediaType) => void;
		onChooseMatch: (match: MatchResult) => void;
		onSearchInput: (event: Event) => void;
		onSearch: () => void;
		onClearSearch: () => void;
		onSeasonNumberChange: () => void;
		onEpisodeNumberChange: () => void;
		onToggleSkip: () => void;
		onSwitchGroup: (id: string) => void;
		onSkipGroup: (id: string) => void;
		onUnskipGroup: (id: string) => void;
		onSelectReviewSeasonSection: (key: string) => void;
		onApplyMatchToSeason: (season: TvSeasonSection) => void;
		onToggleSeasonSkipped: (season: TvSeasonSection) => void;
		onApplyMatchToAllSeasons: (section: DetectionSection) => void;
		onToggleSeriesSkipped: (section: DetectionSection) => void;
		onSeasonOverrideChange: (section: DetectionSection, seasonNumber: number | null) => void;
	} = $props();

	function formatEpisodePill(info: { season: number; episode: number }): string {
		return `S${String(info.season).padStart(2, '0')}E${String(info.episode).padStart(2, '0')}`;
	}

	let episodeStatusFilter = $state<'all' | ReviewStatus>('all');
	$effect(() => {
		// Reset the episode sub-filter whenever the active season changes.
		const _key = activeReviewSeasonSection?.key;
		episodeStatusFilter = 'all';
	});

	const filteredSeasonEpisodes = $derived.by(() => {
		const items = activeReviewSeasonSection?.items ?? activeReviewTvSection?.items ?? [];
		if (episodeStatusFilter === 'all') return items;
		return items.filter((group) => getGroupStatus(group) === episodeStatusFilter);
	});

	// Only show the series/season browser when the currently active group
	// actually belongs to it - otherwise reviewing a movie row would show a
	// stale/unrelated TV series widget underneath.
	const showTvSeriesWidget = $derived(
		Boolean(
			activeGroup && activeReviewTvSection?.items.some((group) => group.id === activeGroup.id)
		)
	);

	// Expand match list only when there's no match and no locked route context
	let showMatchList = $state(untrack(() => !selectedMatch && !routeImportContext));

	$effect(() => {
		showMatchList = !selectedMatch && !routeImportContext;
	});

	let episodeOverrideActive = $state(false);
	$effect(() => {
		// Reset override when switching to a different group (track by id)
		const _id = activeGroup?.id;
		episodeOverrideActive = false;
	});
</script>

{#snippet activeItemHeader()}
	{#if activeGroup}
		<!-- Row 1: file identity + status + skip -->
		<div class="flex flex-wrap items-start justify-between gap-2">
			<div class="min-w-0 flex-1">
				<div class="truncate text-sm font-medium" title={activeGroup.sourcePath}>
					{activeGroup.displayName}
				</div>
				<div
					class="mt-0.5 truncate text-xs text-base-content/50"
					title={activeGroup.selectedFilePath}
				>
					{activeGroup.selectedFilePath}
				</div>
				{#if activeGroup.detectedFileCount > 1 || (activeGroup.detectedSeasons && activeGroup.detectedSeasons.length > 1)}
					<div class="mt-1 text-xs text-base-content/60">
						{m.library_import_filesDetected()}
						<span class="font-medium">{activeGroup.detectedFileCount}</span>
						{#if activeGroup.detectedSeasons && activeGroup.detectedSeasons.length > 1}
							<span class="ml-2"
								>{m.library_import_seasonsDetectedInline({
									seasons: activeGroup.detectedSeasons.join(', ')
								})}</span
							>
						{/if}
					</div>
				{/if}
			</div>
			<div class="flex shrink-0 items-center gap-2">
				{#if isGroupImported}
					<span class="badge badge-sm badge-success">{m.library_import_badgeImported()}</span>
				{:else if isGroupSkipped}
					<span class="badge badge-ghost badge-sm">{m.library_import_badgeSkipped()}</span>
				{:else if canImportGroup(activeGroup)}
					<span class="badge badge-sm badge-success">{m.library_import_badgeReady()}</span>
				{:else}
					<span class="badge badge-sm badge-warning">{m.library_import_badgeNeedsInput()}</span>
				{/if}
				{#if !isGroupImported && skipActionsEnabled}
					<button class="btn btn-ghost btn-xs" onclick={onToggleSkip}>
						{isGroupSkipped ? m.library_import_selectItem() : m.library_import_skipItem()}
					</button>
				{/if}
			</div>
		</div>

		<!-- Row 2: media type + season/episode -->
		<div class="flex flex-wrap items-end gap-3">
			{#if !isMediaTypeLockedByContext}
				<div class="space-y-1">
					<div class="text-xs text-base-content/60">{m.library_import_mediaTypeHeading()}</div>
					<div class="flex gap-1">
						<button
							type="button"
							class="btn btn-xs {selectedMediaType === 'movie' ? 'btn-primary' : 'btn-ghost'}"
							onclick={() => onSwitchMediaType('movie')}
						>
							<Clapperboard class="h-3 w-3" />
							{m.common_movie()}
						</button>
						<button
							type="button"
							class="btn btn-xs {selectedMediaType === 'tv' ? 'btn-primary' : 'btn-ghost'}"
							onclick={() => onSwitchMediaType('tv')}
						>
							<Tv class="h-3 w-3" />
							{m.ui_mediaType_tv()}
						</button>
					</div>
				</div>
			{:else}
				<div
					class="flex items-center gap-1.5 rounded-md bg-base-200/60 px-2.5 py-1.5 text-xs text-base-content/60"
				>
					{#if selectedMediaType === 'tv'}
						<Tv class="h-3.5 w-3.5" />
						{m.ui_mediaType_tv()}
					{:else}
						<Clapperboard class="h-3.5 w-3.5" />
						{m.common_movie()}
					{/if}
					<span class="text-base-content/40">·</span>
					{m.library_import_mediaTypeLocked()}
				</div>
			{/if}

			{#if selectedMediaType === 'tv' && !isBatchTvImport}
				<div class="flex items-end gap-2">
					<label class="form-control">
						<span class="label-text text-xs">{m.library_import_seasonLabel()}</span>
						<input
							type="number"
							min="0"
							class="input-bordered input w-20 input-sm"
							bind:value={seasonNumber}
							onchange={onSeasonNumberChange}
						/>
					</label>
					{#if activeGroup?.parsedEpisodes && activeGroup.parsedEpisodes.length > 1 && !episodeOverrideActive}
						<div class="form-control">
							<span class="label-text text-xs">{m.library_import_episodeLabel()}</span>
							<div class="flex h-8 items-center gap-1.5">
								<div
									class="flex h-full items-center rounded-md border border-base-300 bg-base-200/60 px-2.5 text-xs text-base-content/70"
								>
									E{activeGroup.parsedEpisodes[0]}-E{activeGroup.parsedEpisodes[
										activeGroup.parsedEpisodes.length - 1
									]}
									<span class="ml-1.5 text-base-content/40">(auto)</span>
								</div>
								<button
									type="button"
									class="btn btn-ghost text-base-content/50 btn-xs"
									onclick={() => (episodeOverrideActive = true)}
								>
									Override
								</button>
							</div>
						</div>
					{:else if activeGroup?.parsedEpisodes && activeGroup.parsedEpisodes.length > 1 && episodeOverrideActive}
						<div class="form-control">
							<span class="label-text text-xs">{m.library_import_episodeLabel()}</span>
							<div class="flex h-8 items-center gap-1.5">
								<input
									type="number"
									min="1"
									class="input-bordered input w-20 input-sm"
									bind:value={episodeNumber}
									onchange={onEpisodeNumberChange}
								/>
								<button
									type="button"
									class="btn btn-ghost text-base-content/50 btn-xs"
									onclick={() => {
										episodeOverrideActive = false;
										episodeNumber = activeGroup?.parsedEpisodes?.[0] ?? episodeNumber;
										onEpisodeNumberChange();
									}}
								>
									Auto
								</button>
							</div>
						</div>
					{:else}
						<label class="form-control">
							<span class="label-text text-xs">{m.library_import_episodeLabel()}</span>
							<input
								type="number"
								min="1"
								class="input-bordered input w-20 input-sm"
								bind:value={episodeNumber}
								onchange={onEpisodeNumberChange}
							/>
						</label>
					{/if}
					{#if canApplyActiveSeasonOverride()}
						<button type="button" class="btn btn-ghost btn-sm" onclick={onSeasonNumberChange}>
							{m.action_apply()}
						</button>
					{/if}
				</div>
			{:else if selectedMediaType === 'tv' && isBatchTvImport}
				<div class="flex-1 rounded border border-base-300 bg-base-200/40 p-2">
					<div class="mb-1 text-xs text-base-content/70">
						{m.library_import_episodeMappingAutoDetected()}
					</div>
					<label class="form-control">
						<span class="label-text text-xs">{m.library_import_seasonOverrideLabel()}</span>
						<input
							type="number"
							min="0"
							class="input-bordered input w-24 input-sm"
							placeholder={m.library_import_seasonOverridePlaceholder()}
							bind:value={batchSeasonOverride}
							onchange={onEpisodeNumberChange}
						/>
						<div class="label-text-alt text-xs text-base-content/60">
							{m.library_import_seasonOverrideHint()}
						</div>
					</label>
				</div>
			{/if}

			{#if isGroupImported}
				<div class="self-center text-xs text-success">{m.library_import_alreadyImported()}</div>
			{:else if isGroupSkipped}
				<div class="self-center text-xs text-base-content/70">
					{m.library_import_itemSkipped()}
				</div>
			{/if}
		</div>
	{/if}
{/snippet}

{#if activeGroup}
	<div class="space-y-4 rounded-xl border border-base-300 bg-base-100 p-4 sm:p-5">
		<!-- "Looks like TV" hint: a movie-classified item whose filename still
		     parsed a season/episode is probably a misclassified TV episode. -->
		{#if activeGroup && suggestsTvFromMovie(activeGroup)}
			<div class="alert flex-wrap gap-2 text-sm alert-warning">
				<span class="font font-medium">{m.library_import_looksLikeTvHint()}</span>
				<button
					type="button"
					class="btn btn-sm btn-success"
					onclick={() => onSwitchMediaType('tv')}
				>
					{m.library_import_switchToTv()}
				</button>
			</div>
		{/if}

		<!-- Warnings -->
		{#if parsedSourceContextMismatch && routeImportContext}
			<div class="alert text-sm alert-warning">
				<span>
					{m.library_import_parsedFileSuggests()}
					<strong
						>{activeGroup.parsedTitle}{#if activeGroup.parsedYear}
							({activeGroup.parsedYear}){/if}</strong
					>,
					{m.library_import_butImportOpenedFor()}
					<strong
						>{routeImportContext.title ||
							`TMDB ${routeImportContext.tmdbId}`}{#if routeImportContext.year}
							({routeImportContext.year}){/if}</strong
					>.
				</span>
			</div>
		{/if}
		{#if selectedMatchContextMismatch && routeImportContext && selectedMatch}
			<div class="alert text-sm alert-warning">
				<span>
					{m.library_import_importOpenedFor()}
					<strong
						>{routeImportContext.title ||
							`TMDB ${routeImportContext.tmdbId}`}{#if routeImportContext.year}
							({routeImportContext.year}){/if}</strong
					>,
					{m.library_import_butSelectedMatchIs()}
					<strong
						>{selectedMatch.title}{#if selectedMatch.year}
							({selectedMatch.year}){/if}</strong
					>".
				</span>
			</div>
		{/if}

		<!-- Match section -->
		{#if routeImportContext && !selectedMatchContextMismatch}
			<!-- Direct import context: show selected match as a compact row -->
			<div class="min-w-0">
				<div class="mb-1 text-xs text-base-content/50">{m.library_import_directImportFor()}</div>
				{#if selectedMatch}
					<div class="flex flex-wrap items-center gap-2">
						<span class="truncate font-medium">
							{selectedMatch.title}{#if selectedMatch.year}
								<span class="text-base-content/60">({selectedMatch.year})</span>{/if}
						</span>
						<span class="badge badge-outline badge-xs"
							>{selectedMatch.mediaType === 'movie' ? m.common_movie() : m.ui_mediaType_tv()}</span
						>
						{#if selectedMatch.inLibrary}
							<span class="badge badge-xs badge-success">{m.library_import_inLibrary()}</span>
						{/if}
					</div>
				{/if}
			</div>
		{:else}
			<!-- No context: search bar always visible -->
			<div class="flex flex-wrap items-center gap-2">
				<div class="group relative min-w-0 flex-1">
					<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
						{#if searchingMatches}
							<Loader2
								class="h-4 w-4 animate-spin text-base-content/40 transition-colors group-focus-within:text-primary"
							/>
						{:else}
							<Search
								class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
							/>
						{/if}
					</div>
					<input
						type="text"
						placeholder={m.library_import_searchTmdbPlaceholder()}
						class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
						value={searchQuery}
						oninput={onSearchInput}
						onkeydown={(event) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								onSearch();
							}
							if (event.key === 'Escape') {
								onClearSearch();
							}
						}}
					/>
					{#if searchQuery}
						<button
							class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 transition-colors hover:bg-base-300 hover:text-base-content"
							onclick={onClearSearch}
							aria-label={m.library_import_clearTmdbSearch()}
						>
							<X class="h-3.5 w-3.5" />
						</button>
					{/if}
				</div>
				{#if selectedMatch}
					{#if !showMatchList}
						<span class="min-w-0 flex-1 truncate text-sm font-medium text-base-content/80">
							{selectedMatch.title}{selectedMatch.year ? ` (${selectedMatch.year})` : ''}
						</span>
					{/if}
					<button
						type="button"
						class="btn shrink-0 btn-ghost btn-xs"
						onclick={() => (showMatchList = !showMatchList)}
					>
						{showMatchList ? m.action_collapse() : m.action_change()}
						{#if showMatchList}
							<ChevronUp class="h-3 w-3" />
						{:else}
							<ChevronDown class="h-3 w-3" />
						{/if}
					</button>
				{/if}
			</div>
		{/if}

		{#if canApplyMatchSelectionToActiveSeason && !(routeImportContext && !selectedMatchContextMismatch)}
			<div class="rounded-lg border border-base-300 bg-base-200/40 p-3">
				<label class="flex cursor-pointer items-center justify-between gap-3">
					<span class="text-sm font-medium">{m.library_import_matchEntireSelectedSeason()}</span>
					<input
						type="checkbox"
						class="toggle toggle-sm"
						bind:checked={applyMatchToSeasonOnSelect}
					/>
				</label>
				<p class="mt-1 text-xs text-base-content/70">
					{m.library_import_matchEntireSelectedSeasonHint()}
				</p>
			</div>
		{/if}

		<!-- Match candidates (collapsed when match selected + in context) -->
		{#if showMatchList}
			{#if matchCandidates.length === 0}
				<div
					class="rounded-lg border border-dashed border-base-300 p-4 text-sm text-base-content/60"
				>
					{m.library_import_noMatchesYet()}
				</div>
			{:else}
				<div class="max-h-72 space-y-2 overflow-y-auto pr-1">
					{#each matchCandidates as match (match.mediaType + '-' + match.tmdbId)}
						<button
							type="button"
							class="flex w-full items-center justify-between rounded-lg border p-3 text-left transition-colors hover:border-primary/50 {selectedMatch?.tmdbId ===
								match.tmdbId && selectedMatch?.mediaType === match.mediaType
								? 'border-primary bg-primary/5'
								: 'border-base-300'}"
							onclick={() => onChooseMatch(match)}
						>
							<div class="min-w-0">
								<div class="truncate font-medium">
									{match.title}
									{#if match.year}<span class="text-base-content/60">({match.year})</span>{/if}
								</div>
								<div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
									<span class="badge badge-outline badge-sm"
										>{match.mediaType === 'movie' ? m.common_movie() : m.ui_mediaType_tv()}</span
									>
									{#if match.confidence > 0}
										<span class="badge badge-ghost badge-sm"
											>{m.library_import_confidenceMatch({
												percent: Math.round(match.confidence * 100)
											})}</span
										>
									{/if}
									{#if match.inLibrary}
										<span class="badge badge-sm badge-success">{m.library_import_inLibrary()}</span>
									{/if}
								</div>
							</div>
							{#if selectedMatch?.tmdbId === match.tmdbId && selectedMatch?.mediaType === match.mediaType}
								<Check class="h-4 w-4 text-primary" />
							{/if}
						</button>
					{/each}
				</div>
			{/if}
		{/if}

		<!-- Divider -->
		<div class="border-t border-base-300"></div>

		{#if !showTvSeriesWidget}
			<div class="space-y-4 rounded-lg border border-base-300 bg-base-100 p-3">
				{@render activeItemHeader()}
			</div>
		{/if}

		<!-- Series/season browser - shown whenever the active group belongs to
		     a TV series with grouped season files. -->
		{#if showTvSeriesWidget && activeReviewTvSection}
			{@const seriesStatus = getSeriesSectionStatus(activeReviewTvSection)}
			<div class="space-y-3 rounded-lg border border-base-300 bg-base-200/30 p-3">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<div class="min-w-0">
						<div class="truncate font-medium">{activeReviewTvSection.label}</div>
						<div class="text-xs text-base-content/70">
							{activeReviewTvSection.items.length === 1
								? m.library_import_episodeCountSingular({
										count: activeReviewTvSection.items.length
									})
								: m.library_import_episodeCount({
										count: activeReviewTvSection.items.length
									})}
							{#if activeReviewTvSection.seasonSections}
								• {m.library_import_seasonsLabel({
									seasons: String(activeReviewTvSection.seasonSections.length)
								})}
							{/if}
						</div>
					</div>
					<span
						class="badge badge-sm {seriesStatus === 'ready' ? 'badge-success' : 'badge-warning'}"
					>
						{seriesStatus === 'ready' ? m.library_import_ready() : m.library_import_needsInput()}
					</span>
				</div>

				{#if !isMediaTypeLockedByContext && selectedMediaType === 'tv'}
					<div class="flex flex-wrap items-center gap-2">
						<button
							type="button"
							class="btn btn-primary btn-sm"
							disabled={!canApplySelectedMatchToSeries(activeReviewTvSection)}
							onclick={() => onApplyMatchToAllSeasons(activeReviewTvSection)}
						>
							{m.library_import_applyMatchToAllSeasons()}
						</button>
						<button
							type="button"
							class="btn btn-outline btn-sm"
							onclick={() => onToggleSeriesSkipped(activeReviewTvSection)}
						>
							{isSeriesSectionFullySkipped(activeReviewTvSection)
								? m.library_import_selectSeries()
								: m.library_import_skipSeries()}
						</button>
					</div>
				{/if}

				{#if activeReviewTvSection.seasonSections && activeReviewTvSection.seasonSections.length > 0}
					<div>
						<div class="mb-1 text-[10px] font-bold tracking-widest text-base-content/50 uppercase">
							{m.library_import_seasonsHeading()}
						</div>
						<div class="flex flex-wrap gap-2">
							{#each activeReviewTvSection.seasonSections as seasonSection (seasonSection.key)}
								{@const seasonStatus = getSeasonSectionStatus(seasonSection)}
								<button
									type="button"
									class="rounded-md border px-2 py-1.5 text-center text-xs text-base-content transition-colors {activeReviewSeasonSection?.key ===
									seasonSection.key
										? 'border-primary ring-1 ring-primary'
										: 'border-transparent'} {seasonStatus === 'ready'
										? 'bg-success/15'
										: 'bg-warning/15'}"
									onclick={() => onSelectReviewSeasonSection(seasonSection.key)}
								>
									<div class="font-semibold">{seasonSection.label}</div>
									<div class="text-[10px] opacity-70">
										{m.library_import_episodeCount({ count: seasonSection.items.length })}
									</div>
								</button>
							{/each}
						</div>
						<div class="mt-1.5 flex items-center gap-3 text-[11px] text-base-content/60">
							<span class="flex items-center gap-1">
								<span class="h-2 w-2 rounded-full bg-success"></span>{m.library_import_ready()}
							</span>
							<span class="flex items-center gap-1">
								<span class="h-2 w-2 rounded-full bg-warning"></span>{m.library_import_needsInput()}
							</span>
						</div>
					</div>
				{/if}

				{#if activeReviewSeasonSection}
					<div
						class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-base-300 bg-base-100 p-2"
					>
						<div class="text-xs text-base-content/70">
							{activeReviewSeasonSection.label}: {m.library_import_skippedOfTotal({
								skipped: getSeasonSectionSkippedCount(activeReviewSeasonSection),
								total: getSkippableSeasonGroups(activeReviewSeasonSection).length
							})}
						</div>
						{#if !isMediaTypeLockedByContext}
							<div class="flex flex-wrap items-center gap-2">
								<button
									type="button"
									class="btn btn-ghost btn-xs"
									disabled={!canApplySelectedMatchToSeason(activeReviewSeasonSection)}
									onclick={() => onApplyMatchToSeason(activeReviewSeasonSection)}
								>
									{m.library_import_applyMatchToSeason()}
								</button>
								<button
									type="button"
									class="btn btn-ghost btn-xs"
									onclick={() => onToggleSeasonSkipped(activeReviewSeasonSection)}
								>
									{isSeasonSectionFullySkipped(activeReviewSeasonSection)
										? m.library_import_selectSeason()
										: m.library_import_skipSeason()}
								</button>
							</div>
						{/if}
					</div>

					{#if activeReviewTvSection && hasUnknownSeasonItems(activeReviewTvSection)}
						<div class="alert flex-wrap items-center gap-2 text-sm alert-warning">
							<span>{m.library_import_seasonUnmappedHint()}</span>
							<div class="flex items-center gap-2">
								<span class="text-xs">{m.library_import_overrideSeason()}</span>
								<input
									type="number"
									min="0"
									class="input-bordered input w-20 input-xs"
									value={getSectionSeasonOverride(activeReviewTvSection) ?? ''}
									onchange={(event) => {
										if (!activeReviewTvSection) return;
										const target = event.target as HTMLInputElement;
										const value = target.value.trim();
										if (!value) {
											onSeasonOverrideChange(activeReviewTvSection, null);
											return;
										}
										const parsed = parseInt(value, 10);
										if (isNaN(parsed) || parsed < 0) return;
										onSeasonOverrideChange(activeReviewTvSection, parsed);
									}}
								/>
							</div>
						</div>
					{/if}

					{#if showTvSeriesWidget}
						<div class="space-y-4 rounded-lg border border-base-300 bg-base-100 p-3">
							{@render activeItemHeader()}
						</div>
					{/if}

					<div>
						<div class="max-w-full scrollbar-none overflow-x-auto">
							<div class="join">
								<button
									type="button"
									class="btn join-item whitespace-nowrap btn-xs {episodeStatusFilter === 'all'
										? 'btn-primary'
										: 'btn-ghost'}"
									onclick={() => (episodeStatusFilter = 'all')}
								>
									{m.common_all()}
									{activeReviewSeasonSection.items.length}
								</button>
								<button
									type="button"
									class="btn join-item whitespace-nowrap btn-xs {episodeStatusFilter ===
									'needsInput'
										? 'btn-primary'
										: 'btn-ghost'}"
									onclick={() => (episodeStatusFilter = 'needsInput')}
								>
									{m.library_import_filterNeedsInput()}
									{activeReviewSeasonSection.items.filter(
										(group) => getGroupStatus(group) === 'needsInput'
									).length}
								</button>
								<button
									type="button"
									class="btn join-item whitespace-nowrap btn-xs {episodeStatusFilter === 'skipped'
										? 'btn-primary'
										: 'btn-ghost'}"
									onclick={() => (episodeStatusFilter = 'skipped')}
								>
									{m.library_import_filterSkipped()}
									{activeReviewSeasonSection.items.filter(
										(group) => getGroupStatus(group) === 'skipped'
									).length}
								</button>
							</div>
						</div>

						<div class="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
							{#each filteredSeasonEpisodes as group (group.id)}
								{@const episodeInfo = getGroupEpisodeInfo(group)}
								<div
									class="rounded-lg border p-2 text-sm {activeGroup?.id === group.id
										? 'border-primary bg-primary/5'
										: 'border-base-300'}"
								>
									<div class="flex items-center gap-2">
										<button
											type="button"
											class="min-w-0 flex-1 text-left"
											onclick={() => onSwitchGroup(group.id)}
										>
											<div class="truncate">{group.displayName}</div>
											<div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
												{#if getGroupStatus(group) === 'imported'}
													<span class="badge badge-sm badge-success"
														>{m.library_import_badgeImported()}</span
													>
												{:else if getGroupStatus(group) === 'skipped'}
													<span class="badge badge-ghost badge-sm"
														>{m.library_import_badgeSkipped()}</span
													>
												{:else if getGroupStatus(group) === 'ready'}
													<span class="badge badge-sm badge-success"
														>{m.library_import_badgeReady()}</span
													>
												{:else}
													<span class="badge badge-sm badge-warning"
														>{m.library_import_badgeNeedsInput()}</span
													>
												{/if}
												{#if episodeInfo}
													<span
														class="badge badge-outline border-primary font-mono badge-xs font-bold"
													>
														{formatEpisodePill(episodeInfo)}
													</span>
													{#if episodeInfo.title}
														<span class="truncate text-base-content/70 italic"
															>{episodeInfo.title}</span
														>
													{/if}
												{/if}
											</div>
										</button>
										{#if !isGroupImported && skipActionsEnabled && getGroupStatus(group) !== 'imported'}
											<button
												type="button"
												class="btn btn-ghost btn-xs"
												onclick={() =>
													getGroupStatus(group) === 'skipped'
														? onUnskipGroup(group.id)
														: onSkipGroup(group.id)}
											>
												{getGroupStatus(group) === 'skipped'
													? m.action_select()
													: m.library_import_skipItem()}
											</button>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}
