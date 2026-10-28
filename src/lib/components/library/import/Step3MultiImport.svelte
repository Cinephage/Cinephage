<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Check, ChevronDown, Clock, Loader2 } from '@lucide/svelte';
	import ReviewItemList from './ReviewItemList.svelte';
	import type { MediaType, DetectionGroup, DetectionSection } from './types.js';

	type ReviewStatus = 'needsInput' | 'ready' | 'skipped' | 'imported';

	interface DestinationLibrary {
		id: string;
		name: string;
		slug: string;
		mediaType: MediaType;
		mediaSubType?: string | null;
		isDefault?: boolean;
		isDefaultFolder?: boolean;
		defaultRootFolderId?: string | null;
		defaultRootFolderPath?: string | null;
	}

	type QueueMediaFilter = 'all' | MediaType;

	let {
		importMovieSections = [],
		importTvSections = [],
		hasSelectedImportMovies = false,
		hasSelectedImportTv = false,
		importMediaFilter = $bindable('all' as QueueMediaFilter),
		importMode = $bindable('move' as 'move' | 'copy' | 'symlink'),
		preferHardlink = $bindable(true),
		backgroundImport = $bindable(false),
		bulkDestinationBySectionId = {},
		selectedImportGroupCount = 0,
		selectedNeedsInputCount = 0,
		readyGroupCount = 0,
		skippedGroupCount = 0,
		executingImport = false,
		canImport = (_group: DetectionGroup) => false,
		getGroupActionLabel = (_group: DetectionGroup) => null as 'link' | 'enroll' | null,
		suggestsTvFromMovie = (_group: DetectionGroup) => false,
		getSeriesSectionStatus = (_section: DetectionSection) => 'needsInput' as ReviewStatus,
		getGroupSelectedMatch = (_group: DetectionGroup) =>
			null as import('./types.js').MatchResult | null,
		lockedMediaType = undefined as MediaType | undefined,
		getSectionDestinations = (_section: DetectionSection): DestinationLibrary[] => [],
		getSectionEligibleCount = (_section: DetectionSection) => 0,
		canApplyDestination = (_section: DetectionSection) => false,
		getMediaTypeDestinationOptions = (_mediaType: MediaType): DestinationLibrary[] => [],
		onBulkImport = () => {},
		onUpdateSectionDestination = (_sectionId: string, _value: string) => {},
		onApplyDestination = (_section: DetectionSection) => {},
		onBulkAssignMediaDestination = (_mediaType: MediaType, _libraryId: string) => {},
		onReviewGroup = (_groupId: string) => {},
		onReviewSeries = (_sectionId: string) => {},
		onGoToStep = (_step: number) => {}
	}: {
		importMovieSections: DetectionSection[];
		importTvSections: DetectionSection[];
		hasSelectedImportMovies?: boolean;
		hasSelectedImportTv?: boolean;
		importMediaFilter: QueueMediaFilter;
		importMode: 'move' | 'copy' | 'symlink';
		preferHardlink: boolean;
		backgroundImport: boolean;
		bulkDestinationBySectionId: Record<string, string>;
		selectedImportGroupCount: number;
		selectedNeedsInputCount: number;
		readyGroupCount: number;
		skippedGroupCount: number;
		executingImport: boolean;
		canImport: (group: DetectionGroup) => boolean;
		getGroupActionLabel: (group: DetectionGroup) => 'link' | 'enroll' | null;
		suggestsTvFromMovie: (group: DetectionGroup) => boolean;
		getSeriesSectionStatus: (section: DetectionSection) => ReviewStatus;
		getGroupSelectedMatch: (group: DetectionGroup) => import('./types.js').MatchResult | null;
		lockedMediaType?: MediaType;
		getSectionDestinations: (section: DetectionSection) => DestinationLibrary[];
		getSectionEligibleCount: (section: DetectionSection) => number;
		canApplyDestination: (section: DetectionSection) => boolean;
		getMediaTypeDestinationOptions?: (mediaType: MediaType) => DestinationLibrary[];
		onBulkImport: () => void;
		onUpdateSectionDestination: (sectionId: string, value: string) => void;
		onApplyDestination: (section: DetectionSection) => void;
		onBulkAssignMediaDestination?: (mediaType: MediaType, libraryId: string) => void;
		onReviewGroup: (groupId: string) => void;
		onReviewSeries: (sectionId: string) => void;
		onGoToStep: (step: number) => void;
	} = $props();

	const destinationSections = $derived([...importMovieSections, ...importTvSections]);
	const movieDestinationSections = $derived(
		importMovieSections.filter((section) => getSectionDestinations(section).length > 0)
	);
	const tvDestinationSections = $derived(
		importTvSections.filter((section) => getSectionDestinations(section).length > 0)
	);
	const alreadyMatchedCount = $derived(
		destinationSections.filter((section) => getSectionEligibleCount(section) === 0).length
	);
	const movieBulkOptions = $derived(getMediaTypeDestinationOptions('movie'));
	const tvBulkOptions = $derived(getMediaTypeDestinationOptions('tv'));

	let movieBulkDestination = $state('');
	let tvBulkDestination = $state('');
	let moviePerItemExpanded = $state(false);
	let tvPerItemExpanded = $state(false);

	function getSectionDisplayLabel(section: DetectionSection): string {
		if (section.mediaType === 'movie' && section.items.length === 1) {
			const match = getGroupSelectedMatch(section.items[0]);
			if (match) {
				return match.year ? `${match.title} (${match.year})` : match.title;
			}
		}
		return section.label;
	}
</script>

<div class="space-y-4">
	<div class="rounded-xl border border-base-300 bg-base-100 p-4 sm:p-5">
		<h2 class="text-lg font-semibold">{m.library_import_importSelectionHeading()}</h2>
		<p class="mt-1 text-sm text-base-content/70">
			{m.library_import_importSelectionHint()}
		</p>

		<div class="mt-3 flex flex-wrap items-center gap-2 text-sm">
			<span class="badge badge-primary"
				>{m.library_import_selectedCount({ count: selectedImportGroupCount })}</span
			>
			<span class="badge badge-success"
				>{m.library_import_readyCount({ count: readyGroupCount })}</span
			>
			{#if selectedNeedsInputCount > 0}
				<span class="badge badge-warning"
					>{m.library_import_needInputCount({ count: selectedNeedsInputCount })}</span
				>
			{/if}
			{#if skippedGroupCount > 0}
				<span class="badge badge-ghost"
					>{m.library_import_skippedCount({ count: skippedGroupCount })}</span
				>
			{/if}
		</div>
	</div>

	<div class="rounded-xl border border-base-300 bg-base-100 p-4 sm:p-5">
		<h3 class="font-semibold">{m.library_import_selectedItemsHeading()}</h3>
		{#if !lockedMediaType}
			<div class="mt-3 flex flex-wrap items-center justify-between gap-2">
				<p class="text-xs text-base-content/70">{m.library_import_filterByMediaType()}</p>
				<div class="max-w-full scrollbar-none overflow-x-auto">
					<div class="join">
						<button
							type="button"
							class="btn join-item whitespace-nowrap btn-sm {importMediaFilter === 'all'
								? 'btn-primary'
								: 'btn-ghost'}"
							onclick={() => (importMediaFilter = 'all')}
						>
							{m.library_import_filterAllMedia()}
						</button>
						<button
							type="button"
							class="btn join-item whitespace-nowrap btn-sm {importMediaFilter === 'movie'
								? 'btn-primary'
								: 'btn-ghost'}"
							disabled={!hasSelectedImportMovies}
							onclick={() => (importMediaFilter = 'movie')}
						>
							{m.common_movies()}
						</button>
						<button
							type="button"
							class="btn join-item whitespace-nowrap btn-sm {importMediaFilter === 'tv'
								? 'btn-primary'
								: 'btn-ghost'}"
							disabled={!hasSelectedImportTv}
							onclick={() => (importMediaFilter = 'tv')}
						>
							{m.common_tvShows()}
						</button>
					</div>
				</div>
			</div>
		{/if}
		{#if selectedImportGroupCount === 0}
			<div
				class="mt-3 rounded-lg border border-dashed border-base-300 p-4 text-sm text-base-content/90"
			>
				{m.library_import_noItemsSelected()}
			</div>
		{:else if importMovieSections.length === 0 && importTvSections.length === 0}
			<div
				class="mt-3 rounded-lg border border-dashed border-base-300 p-4 text-sm text-base-content/90"
			>
				{m.library_import_noItemsMatchFilter()}
			</div>
		{:else}
			<div class="mt-3">
				<ReviewItemList
					movieSections={importMovieSections}
					tvSections={importTvSections}
					canImportGroup={canImport}
					{suggestsTvFromMovie}
					{getSeriesSectionStatus}
					{getGroupSelectedMatch}
					{getGroupActionLabel}
					onSelectGroup={onReviewGroup}
					onSelectSeries={onReviewSeries}
				/>
			</div>

			{#snippet destinationRow(section: DetectionSection)}
				{@const destinationOptions = getSectionDestinations(section)}
				<div
					class="flex flex-wrap items-end gap-2 rounded-md border border-base-300 bg-base-200/40 p-2"
				>
					<div class="min-w-0 flex-1 text-xs font-medium text-base-content/80">
						{getSectionDisplayLabel(section)}
					</div>
					<div class="min-w-64 flex-1">
						<select
							class="select-bordered select w-full select-xs"
							value={bulkDestinationBySectionId[section.id] ?? ''}
							onchange={(event) =>
								onUpdateSectionDestination(section.id, (event.target as HTMLSelectElement).value)}
						>
							<option disabled value="">{m.library_import_selectRootFolder()}</option>
							{#each destinationOptions as folder (folder.id)}
								<option value={folder.id}
									>{folder.name}
									{#if folder.defaultRootFolderPath}
										- {folder.defaultRootFolderPath}
									{/if}</option
								>
							{/each}
						</select>
					</div>
					<button
						type="button"
						class="btn btn-ghost btn-xs"
						disabled={!canApplyDestination(section)}
						onclick={() => onApplyDestination(section)}
					>
						{m.library_import_applyDestinationToMedia()}
					</button>
				</div>
			{/snippet}

			{#if movieDestinationSections.length > 0 || tvDestinationSections.length > 0 || alreadyMatchedCount > 0}
				<div class="mt-3 space-y-3">
					<h4 class="text-xs font-medium text-base-content/90 uppercase">
						{m.library_import_destinationRootFolder()}
					</h4>

					{#if movieBulkOptions.length > 0 && movieDestinationSections.length > 0}
						<div
							class="flex flex-wrap items-end gap-2 rounded-md border border-primary/30 bg-primary/5 p-2"
						>
							<div class="min-w-0 flex-1 text-xs font-medium text-base-content/90">
								{m.library_import_bulkAssignMovieDestination()}
							</div>
							<div class="min-w-64 flex-1">
								<select
									class="select-bordered select w-full select-xs"
									bind:value={movieBulkDestination}
								>
									<option disabled value="">{m.library_import_selectRootFolder()}</option>
									{#each movieBulkOptions as folder (folder.id)}
										<option value={folder.id}
											>{folder.name}
											{#if folder.defaultRootFolderPath}
												- {folder.defaultRootFolderPath}
											{/if}</option
										>
									{/each}
								</select>
							</div>
							<button
								type="button"
								class="btn btn-primary btn-xs"
								disabled={!movieBulkDestination}
								onclick={() => onBulkAssignMediaDestination('movie', movieBulkDestination)}
							>
								{m.library_import_applyToAllMovies()}
							</button>
						</div>
					{/if}

					{#if tvBulkOptions.length > 0 && tvDestinationSections.length > 0}
						<div
							class="flex flex-wrap items-end gap-2 rounded-md border border-primary/30 bg-primary/5 p-2"
						>
							<div class="min-w-0 flex-1 text-xs font-medium text-base-content/90">
								{m.library_import_bulkAssignTvDestination()}
							</div>
							<div class="min-w-64 flex-1">
								<select
									class="select-bordered select w-full select-xs"
									bind:value={tvBulkDestination}
								>
									<option disabled value="">{m.library_import_selectRootFolder()}</option>
									{#each tvBulkOptions as folder (folder.id)}
										<option value={folder.id}
											>{folder.name}
											{#if folder.defaultRootFolderPath}
												- {folder.defaultRootFolderPath}
											{/if}</option
										>
									{/each}
								</select>
							</div>
							<button
								type="button"
								class="btn btn-primary btn-xs"
								disabled={!tvBulkDestination}
								onclick={() => onBulkAssignMediaDestination('tv', tvBulkDestination)}
							>
								{m.library_import_applyToAllTv()}
							</button>
						</div>
					{/if}

					{#if movieDestinationSections.length > 0}
						<button
							type="button"
							class="flex w-full items-center justify-between rounded-md bg-base-200/60 px-2 py-1"
							onclick={() => (moviePerItemExpanded = !moviePerItemExpanded)}
						>
							<span class="flex items-center gap-1.5">
								<ChevronDown
									class="h-3.5 w-3.5 text-base-content/60 transition-transform {moviePerItemExpanded
										? ''
										: '-rotate-90'}"
								/>
								<span class="text-[11px] font-bold tracking-widest text-base-content/90 uppercase"
									>{m.common_movies()}</span
								>
								<span class="text-[11px] font-normal text-base-content/60 normal-case"
									>({m.library_import_perItemOverrideHint()})</span
								>
							</span>
							<span class="text-xs text-base-content/80">{movieDestinationSections.length}</span>
						</button>
						{#if moviePerItemExpanded}
							<div class="space-y-2">
								{#each movieDestinationSections as section (section.id)}
									{@render destinationRow(section)}
								{/each}
							</div>
						{/if}
					{/if}

					{#if tvDestinationSections.length > 0}
						<button
							type="button"
							class="flex w-full items-center justify-between rounded-md bg-base-200/60 px-2 py-1"
							onclick={() => (tvPerItemExpanded = !tvPerItemExpanded)}
						>
							<span class="flex items-center gap-1.5">
								<ChevronDown
									class="h-3.5 w-3.5 text-base-content/60 transition-transform {tvPerItemExpanded
										? ''
										: '-rotate-90'}"
								/>
								<span class="text-[11px] font-bold tracking-widest text-base-content/90 uppercase"
									>{m.common_tvShows()}</span
								>
								<span class="text-[11px] font-normal text-base-content/60 normal-case"
									>({m.library_import_perItemOverrideHint()})</span
								>
							</span>
							<span class="text-xs text-base-content/80">{tvDestinationSections.length}</span>
						</button>
						{#if tvPerItemExpanded}
							<div class="space-y-2">
								{#each tvDestinationSections as section (section.id)}
									{@render destinationRow(section)}
								{/each}
							</div>
						{/if}
					{/if}

					{#if alreadyMatchedCount > 0}
						<div
							class="rounded-md border border-base-300 bg-base-200/40 p-2 text-xs text-base-content/80"
						>
							{m.library_import_destinationAlreadyMatchedSummary({ count: alreadyMatchedCount })}
						</div>
					{/if}
				</div>
			{/if}
		{/if}
	</div>

	<!-- Import Method -->
	<div class="rounded-xl border border-base-300 bg-base-100 p-4 sm:p-5">
		<h3 class="font-semibold">{m.library_import_importMethodHeading()}</h3>
		<div class="mt-3 grid gap-2 sm:grid-cols-3">
			<label
				class="flex items-start gap-3 rounded-lg border p-3 transition-colors
					{importMode === 'move' ? 'border-primary bg-primary/5' : 'border-base-300'}
					{executingImport ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}"
			>
				<input
					type="radio"
					name="bulk-import-method"
					class="radio mt-0.5 radio-primary"
					value="move"
					bind:group={importMode}
					disabled={executingImport}
				/>
				<div>
					<div class="font-medium">{m.library_import_importMethodMove()}</div>
					<div class="text-sm text-base-content/70">{m.library_import_importMethodMoveDesc()}</div>
				</div>
			</label>
			<label
				class="flex items-start gap-3 rounded-lg border p-3 transition-colors
					{importMode === 'copy' ? 'border-primary bg-primary/5' : 'border-base-300'}
					{executingImport ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}"
			>
				<input
					type="radio"
					name="bulk-import-method"
					class="radio mt-0.5 radio-primary"
					value="copy"
					bind:group={importMode}
					disabled={executingImport}
				/>
				<div>
					<div class="font-medium">{m.library_import_importMethodCopy()}</div>
					<div class="text-sm text-base-content/70">{m.library_import_importMethodCopyDesc()}</div>
				</div>
			</label>
			<label
				class="flex items-start gap-3 rounded-lg border p-3 transition-colors
					{importMode === 'symlink' ? 'border-primary bg-primary/5' : 'border-base-300'}
					{executingImport ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}"
			>
				<input
					type="radio"
					name="bulk-import-method"
					class="radio mt-0.5 radio-primary"
					value="symlink"
					bind:group={importMode}
					disabled={executingImport}
				/>
				<div>
					<div class="font-medium">{m.library_import_importMethodSymlink()}</div>
					<div class="text-sm text-base-content/70">
						{m.library_import_importMethodSymlinkDesc()}
					</div>
				</div>
			</label>
		</div>
		<label
			class="mt-3 flex items-start gap-3 rounded-lg border p-3 transition-colors
				{importMode === 'copy' ? 'border-primary/40 bg-base-200/50' : 'border-base-300 opacity-50'}
				{executingImport || importMode !== 'copy' ? 'cursor-not-allowed' : 'cursor-pointer'}"
		>
			<input
				type="checkbox"
				class="checkbox mt-0.5 checkbox-primary"
				bind:checked={preferHardlink}
				disabled={executingImport || importMode !== 'copy'}
			/>
			<div>
				<div class="font-medium">{m.library_import_preferHardlinkLabel()}</div>
				<div class="text-sm text-base-content/70">{m.library_import_preferHardlinkDesc()}</div>
			</div>
		</label>
	</div>

	{#if selectedNeedsInputCount > 0}
		<div class="alert text-sm alert-warning">
			<span>
				{m.library_import_needsInputWarning({ count: selectedNeedsInputCount })}
			</span>
		</div>
	{/if}

	<label
		class="flex cursor-pointer items-center justify-between gap-4 rounded-xl border p-4 transition-colors sm:p-5
			{backgroundImport ? 'border-primary bg-primary/5' : 'border-base-300 bg-base-100'}
			{executingImport ? 'cursor-not-allowed opacity-50' : ''}"
	>
		<span class="flex items-start gap-3">
			<span
				class="mt-0.5 rounded-lg p-2 {backgroundImport
					? 'bg-primary/10 text-primary'
					: 'bg-base-200 text-base-content/60'}"
			>
				<Clock class="h-4 w-4" />
			</span>
			<span>
				<span class="block font-medium">{m.library_import_runInBackground()}</span>
				<span class="block text-sm text-base-content/70"
					>{m.library_import_runInBackgroundHint()}</span
				>
			</span>
		</span>
		<input
			type="checkbox"
			class="toggle toggle-primary"
			bind:checked={backgroundImport}
			disabled={executingImport}
		/>
	</label>

	<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
		<button class="btn btn-ghost" onclick={() => onGoToStep(2)}
			>{m.library_import_backToReview()}</button
		>
		<button
			class="btn btn-primary"
			onclick={onBulkImport}
			disabled={executingImport || selectedImportGroupCount === 0 || selectedNeedsInputCount > 0}
		>
			{#if executingImport}
				<Loader2 class="h-4 w-4 animate-spin" />
				{m.library_import_importing()}
			{:else}
				<Check class="h-4 w-4" />
				{m.library_import_startImportCount({ count: selectedImportGroupCount })}
			{/if}
		</button>
	</div>
</div>
