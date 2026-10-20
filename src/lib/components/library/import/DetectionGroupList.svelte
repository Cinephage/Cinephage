<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Search, X } from '@lucide/svelte';
	import type { MediaType, DetectionGroup, DetectionSection, TvSeasonSection } from './types.js';

	type QueueMediaFilter = 'all' | MediaType;

	let {
		reviewDetectionSections = [],
		reviewMovieSections = [],
		reviewTvSections = [],
		activeReviewTvSection = null,
		activeReviewSeasonSection = null,
		hasMultipleReviewTvSeries = false,
		detectedGroupQuery = $bindable(''),
		detectedGroupFilter = $bindable('pending' as string),
		detectedMediaFilter = $bindable('all' as QueueMediaFilter),
		lockedMediaType = undefined as MediaType | undefined,
		selectedGroupId = null,
		importedGroupIds = [],
		skippedGroupIds = [],
		pendingGroupCount = 0,
		readyGroupCount = 0,
		remainingGroupCount = 0,
		skippedGroupCount = 0,
		skipActionsEnabled = false,
		getEffectiveMediaType = (_group: DetectionGroup) => 'movie' as MediaType,
		formatMediaTypeLabel = (_mediaType: MediaType) => '',
		canImportGroup = (_group: DetectionGroup) => false,
		getGroupSelectedMatch = (_group: DetectionGroup) =>
			null as import('./types.js').MatchResult | null,
		hasUnknownSeasonItems = (_section: DetectionSection) => false,
		getSectionSeasonOverride = (_section: DetectionSection) => null as number | null,
		getSkippableSeasonGroups = (_season: TvSeasonSection) => [] as DetectionGroup[],
		getSeasonSectionSkippedCount = (_season: TvSeasonSection) => 0,
		isSeasonSectionFullySkipped = (_season: TvSeasonSection) => false,
		getDetectedSeasonsLabel = (_section: DetectionSection) => '',
		canApplySelectedMatchToSeason = (_season: TvSeasonSection) => false,
		getGroupEpisodeInfo = (_group: DetectionGroup) =>
			null as { season: number; episode: number; title?: string } | null,
		getGroupActionLabel = (_group: DetectionGroup) => null as 'link' | 'enroll' | null,
		onSwitchGroup = (_id: string) => {},
		onSkipGroup = (_id: string) => {},
		onUnskipGroup = (_id: string) => {},
		onSelectReviewSeriesSection = (_id: string) => {},
		onSelectReviewSeasonSection = (_key: string) => {},
		onApplyMatchToSeason = (_season: TvSeasonSection) => {},
		onToggleSeasonSkipped = (_season: TvSeasonSection) => {},
		onSeasonOverrideChange = (_section: DetectionSection, _seasonNumber: number | null) => {}
	}: {
		reviewDetectionSections: DetectionSection[];
		reviewMovieSections: DetectionSection[];
		reviewTvSections: DetectionSection[];
		activeReviewTvSection: DetectionSection | null;
		activeReviewSeasonSection: TvSeasonSection | null;
		hasMultipleReviewTvSeries: boolean;
		detectedGroupQuery: string;
		detectedGroupFilter: string;
		detectedMediaFilter: QueueMediaFilter;
		lockedMediaType?: MediaType;
		selectedGroupId: string | null;
		importedGroupIds: string[];
		skippedGroupIds: string[];
		pendingGroupCount: number;
		readyGroupCount: number;
		remainingGroupCount: number;
		skippedGroupCount: number;
		skipActionsEnabled: boolean;
		getEffectiveMediaType: (group: DetectionGroup) => MediaType;
		formatMediaTypeLabel: (mediaType: MediaType) => string;
		canImportGroup: (group: DetectionGroup) => boolean;
		getGroupSelectedMatch: (group: DetectionGroup) => import('./types.js').MatchResult | null;
		hasUnknownSeasonItems: (section: DetectionSection) => boolean;
		getSectionSeasonOverride: (section: DetectionSection) => number | null;
		getSkippableSeasonGroups: (season: TvSeasonSection) => DetectionGroup[];
		getSeasonSectionSkippedCount: (season: TvSeasonSection) => number;
		isSeasonSectionFullySkipped: (season: TvSeasonSection) => boolean;
		getDetectedSeasonsLabel: (section: DetectionSection) => string;
		canApplySelectedMatchToSeason: (season: TvSeasonSection) => boolean;
		getGroupEpisodeInfo: (group: DetectionGroup) => {
			season: number;
			episode: number;
			title?: string;
		} | null;
		getGroupActionLabel: (group: DetectionGroup) => 'link' | 'enroll' | null;
		onSwitchGroup: (id: string) => void;
		onSkipGroup: (id: string) => void;
		onUnskipGroup: (id: string) => void;
		onSelectReviewSeriesSection: (id: string) => void;
		onSelectReviewSeasonSection: (key: string) => void;
		onApplyMatchToSeason: (season: TvSeasonSection) => void;
		onToggleSeasonSkipped: (season: TvSeasonSection) => void;
		onSeasonOverrideChange: (section: DetectionSection, seasonNumber: number | null) => void;
	} = $props();

	function isGroupPending(groupId: string): boolean {
		return !importedGroupIds.includes(groupId) && !skippedGroupIds.includes(groupId);
	}

	function formatEpisodePill(info: { season: number; episode: number }): string {
		return `S${String(info.season).padStart(2, '0')}E${String(info.episode).padStart(2, '0')}`;
	}
</script>

<div class="rounded-xl border border-base-300 bg-base-100 p-4 sm:p-5">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div>
			<h2 class="text-lg font-semibold">{m.library_import_detectedItems()}</h2>
			<p class="mt-1 text-sm text-base-content/70">
				{m.library_import_detectedItemsHint()}
			</p>
		</div>
		<div class="flex flex-wrap items-center gap-2 text-xs">
			<span class="badge badge-outline"
				>{m.library_import_needsInputCount({ count: pendingGroupCount })}</span
			>
			<span class="badge badge-primary"
				>{m.library_import_selectedCount({ count: remainingGroupCount })}</span
			>
			<span class="badge badge-success"
				>{m.library_import_importedCount({ count: importedGroupIds.length })}</span
			>
			{#if skippedGroupCount > 0}
				<span class="badge badge-ghost"
					>{m.library_import_skippedCount({ count: skippedGroupCount })}</span
				>
			{/if}
		</div>
	</div>

	<div class="mt-3 flex flex-col gap-2 lg:flex-row">
		<div class="group relative flex-1">
			<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
				<Search
					class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
				/>
			</div>
			<input
				type="text"
				placeholder={m.library_import_searchDetectedItems()}
				class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-md placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
				bind:value={detectedGroupQuery}
			/>
			{#if detectedGroupQuery}
				<button
					class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 transition-colors hover:bg-base-300 hover:text-base-content"
					onclick={() => (detectedGroupQuery = '')}
					aria-label={m.library_import_clearDetectedSearch()}
				>
					<X class="h-3.5 w-3.5" />
				</button>
			{/if}
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<div class="join">
				<button
					type="button"
					class="btn join-item btn-sm {detectedGroupFilter === 'pending'
						? 'btn-primary'
						: 'btn-ghost'}"
					disabled={pendingGroupCount === 0}
					onclick={() => (detectedGroupFilter = 'pending')}
				>
					{m.library_import_filterNeedsInput()}
				</button>
				<button
					type="button"
					class="btn join-item btn-sm {detectedGroupFilter === 'ready'
						? 'btn-primary'
						: 'btn-ghost'}"
					disabled={readyGroupCount === 0}
					onclick={() => (detectedGroupFilter = 'ready')}
				>
					{m.library_import_filterReady()}
				</button>
				<button
					type="button"
					class="btn join-item btn-sm {detectedGroupFilter === 'skipped'
						? 'btn-primary'
						: 'btn-ghost'}"
					disabled={skippedGroupCount === 0}
					onclick={() => (detectedGroupFilter = 'skipped')}
				>
					{m.library_import_filterSkipped()}
				</button>
				<button
					type="button"
					class="btn join-item btn-sm {detectedGroupFilter === 'imported'
						? 'btn-primary'
						: 'btn-ghost'}"
					disabled={importedGroupIds.length === 0}
					onclick={() => (detectedGroupFilter = 'imported')}
				>
					{m.library_import_filterImported()}
				</button>
				<button
					type="button"
					class="btn join-item btn-sm {detectedGroupFilter === 'all' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => (detectedGroupFilter = 'all')}
				>
					{m.common_all()}
				</button>
			</div>
			{#if !lockedMediaType}
				<div class="join">
					<button
						type="button"
						class="btn join-item btn-sm {detectedMediaFilter === 'all'
							? 'btn-primary'
							: 'btn-ghost'}"
						onclick={() => (detectedMediaFilter = 'all')}
					>
						{m.library_import_filterAllMedia()}
					</button>
					<button
						type="button"
						class="btn join-item btn-sm {detectedMediaFilter === 'movie'
							? 'btn-primary'
							: 'btn-ghost'}"
						onclick={() => (detectedMediaFilter = 'movie')}
					>
						{m.common_movies()}
					</button>
					<button
						type="button"
						class="btn join-item btn-sm {detectedMediaFilter === 'tv'
							? 'btn-primary'
							: 'btn-ghost'}"
						onclick={() => (detectedMediaFilter = 'tv')}
					>
						{m.common_tvShows()}
					</button>
				</div>
			{/if}
		</div>
	</div>

	<div class="mt-3 space-y-3">
		{#if reviewDetectionSections.length === 0}
			<div
				class="rounded-lg border border-dashed border-base-300 p-4 text-center text-sm text-base-content/60"
			>
				{m.library_import_noDetectedItemsMatch()}
			</div>
		{:else}
			{#if reviewMovieSections.length > 0}
				<div class="max-h-72 space-y-2 overflow-y-auto pr-1">
					{#each reviewMovieSections as section (section.id)}
						{#each section.items as group (group.id)}
							{@const groupMatch = getGroupSelectedMatch(group)}
							<div class="rounded-lg border border-base-300 p-2">
								<div
									class="flex items-center gap-2 rounded-lg border p-2 sm:p-3 {selectedGroupId ===
									group.id
										? 'border-primary bg-primary/5'
										: 'border-base-300'}"
								>
									<button
										type="button"
										class="min-w-0 flex-1 text-left"
										onclick={() => onSwitchGroup(group.id)}
									>
										<div class="truncate text-sm font-medium sm:text-base">
											{group.displayName}
										</div>
										<div
											class="mt-1 flex flex-wrap items-center gap-2 text-xs text-base-content/70"
										>
											<span>{formatMediaTypeLabel(getEffectiveMediaType(group))}</span>
											<span>•</span>
											<span
												>{group.detectedFileCount === 1
													? m.library_import_fileCountSingular({
															count: group.detectedFileCount
														})
													: m.library_import_fileCount({
															count: group.detectedFileCount
														})}</span
											>
											{#if canImportGroup(group)}
												<span class="text-success">{m.library_import_ready()}</span>
											{:else if isGroupPending(group.id)}
												<span class="text-warning">{m.library_import_needsInput()}</span>
											{/if}
											{#if groupMatch}
												<span>•</span>
												<span class="max-w-48 truncate font-medium text-base-content/80"
													>{groupMatch.title}{groupMatch.year ? ` (${groupMatch.year})` : ''}</span
												>
											{/if}
										</div>
									</button>
									<div class="flex shrink-0 items-center gap-2">
										{#if importedGroupIds.includes(group.id)}
											<span class="badge badge-sm badge-success"
												>{m.library_import_badgeImported()}</span
											>
										{:else if skippedGroupIds.includes(group.id)}
											<span class="badge badge-ghost badge-sm"
												>{m.library_import_badgeSkipped()}</span
											>
										{:else if getGroupActionLabel(group) === 'link'}
											<span class="badge badge-sm badge-info">{m.activity_unmatched_linkNow()}</span
											>
										{:else if getGroupActionLabel(group) === 'enroll'}
											<span class="badge badge-outline badge-sm"
												>{m.activity_unmatched_enrollAction()}</span
											>
										{/if}
										{#if !importedGroupIds.includes(group.id) && skipActionsEnabled}
											<button
												type="button"
												class="btn btn-ghost btn-xs"
												onclick={() =>
													skippedGroupIds.includes(group.id)
														? onUnskipGroup(group.id)
														: onSkipGroup(group.id)}
											>
												{skippedGroupIds.includes(group.id)
													? m.action_select()
													: m.library_import_skipItem()}
											</button>
										{/if}
									</div>
								</div>
							</div>
						{/each}
					{/each}
				</div>
			{/if}

			{#if reviewTvSections.length > 0}
				<div class="overflow-hidden rounded-lg border border-base-300 p-2">
					<div
						class="grid gap-3 {hasMultipleReviewTvSeries
							? 'xl:grid-cols-[280px_minmax(0,1fr)]'
							: ''}"
					>
						{#if hasMultipleReviewTvSeries}
							<div class="max-h-80 space-y-1 overflow-y-auto pr-1">
								{#each reviewTvSections as section (section.id)}
									<button
										type="button"
										class="w-full rounded-md border px-3 py-2 text-left transition-colors {activeReviewTvSection?.id ===
										section.id
											? 'border-primary bg-primary/5'
											: 'border-base-300 hover:bg-base-200/50'}"
										onclick={() => onSelectReviewSeriesSection(section.id)}
									>
										<div class="truncate text-sm font-medium">{section.label}</div>
										<div class="mt-1 text-xs text-base-content/70">
											{section.items.length === 1
												? m.library_import_episodeCountSingular({
														count: section.items.length
													})
												: m.library_import_episodeCount({ count: section.items.length })} •
											{m.library_import_seasonsLabel({
												seasons: getDetectedSeasonsLabel(section)
											})}
										</div>
									</button>
								{/each}
							</div>
						{/if}

						<div class="min-w-0 overflow-hidden rounded-md border border-base-300 p-2">
							{#if activeReviewTvSection}
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
										</div>
									</div>
									{#if hasUnknownSeasonItems(activeReviewTvSection)}
										<div class="flex items-center gap-2">
											<span class="text-xs text-base-content/70"
												>{m.library_import_overrideSeason()}</span
											>
											<input
												type="number"
												min="0"
												class="input-bordered input w-20 input-xs"
												value={getSectionSeasonOverride(activeReviewTvSection) ?? ''}
												onchange={(event) => {
													const target = event.target as HTMLInputElement;
													const value = target.value.trim();
													if (!value) {
														onSeasonOverrideChange(activeReviewTvSection, null);
														return;
													}
													const parsed = parseInt(value, 10);
													if (isNaN(parsed) || parsed < 0) {
														return;
													}
													onSeasonOverrideChange(activeReviewTvSection, parsed);
												}}
											/>
										</div>
									{/if}
								</div>

								{#if activeReviewTvSection.seasonSections}
									<div class="mt-2 flex flex-wrap gap-2">
										{#each activeReviewTvSection.seasonSections as seasonSection (seasonSection.key)}
											<button
												type="button"
												class="btn btn-xs {activeReviewSeasonSection?.key === seasonSection.key
													? 'btn-primary'
													: 'btn-ghost'}"
												onclick={() => onSelectReviewSeasonSection(seasonSection.key)}
											>
												{seasonSection.label} ({seasonSection.items.length})
											</button>
										{/each}
									</div>
								{/if}
								{#if activeReviewSeasonSection && getSkippableSeasonGroups(activeReviewSeasonSection).length > 0}
									<div
										class="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-base-300 bg-base-200/40 p-2"
									>
										<div class="text-xs text-base-content/70">
											{activeReviewSeasonSection.label}: {m.library_import_skippedOfTotal({
												skipped: getSeasonSectionSkippedCount(activeReviewSeasonSection),
												total: getSkippableSeasonGroups(activeReviewSeasonSection).length
											})}
										</div>
										<div class="flex flex-wrap items-center gap-2">
											{#if !lockedMediaType}
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
											{/if}
										</div>
									</div>
								{/if}

								<div class="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
									{#each activeReviewSeasonSection?.items ?? activeReviewTvSection.items as group (group.id)}
										{@const episodeInfo = getGroupEpisodeInfo(group)}
										{@const groupMatch = getGroupSelectedMatch(group)}
										<div
											class="flex items-center gap-2 rounded-lg border p-2 sm:p-3 {selectedGroupId ===
											group.id
												? 'border-primary bg-primary/5'
												: 'border-base-300'}"
										>
											<button
												type="button"
												class="min-w-0 flex-1 text-left"
												onclick={() => onSwitchGroup(group.id)}
											>
												<div class="truncate text-sm font-medium sm:text-base">
													{group.displayName}
												</div>
												<div
													class="mt-1 flex flex-wrap items-center gap-2 text-xs text-base-content/70"
												>
													<span>{formatMediaTypeLabel(getEffectiveMediaType(group))}</span>
													<span>•</span>
													<span
														>{group.detectedFileCount === 1
															? m.library_import_fileCountSingular({
																	count: group.detectedFileCount
																})
															: m.library_import_fileCount({
																	count: group.detectedFileCount
																})}</span
													>
													{#if canImportGroup(group)}
														<span class="text-success">{m.library_import_ready()}</span>
													{:else if isGroupPending(group.id)}
														<span class="text-warning">{m.library_import_needsInput()}</span>
													{/if}
													{#if groupMatch && !episodeInfo}
														<span>•</span>
														<span class="max-w-48 truncate font-medium text-base-content/80"
															>{groupMatch.title}{groupMatch.year
																? ` (${groupMatch.year})`
																: ''}</span
														>
													{/if}
													{#if episodeInfo}
														<span
															class="badge badge-outline border-primary font-mono badge-xs font-bold text-base-content badge-primary"
														>
															{formatEpisodePill(episodeInfo)}
														</span>
														{#if episodeInfo.title}
															<span class="max-w-48 truncate italic">
																{episodeInfo.title}
															</span>
														{/if}
													{/if}
												</div>
											</button>
											<div class="flex shrink-0 items-center gap-2">
												{#if importedGroupIds.includes(group.id)}
													<span class="badge badge-sm badge-success"
														>{m.library_import_badgeImported()}</span
													>
												{:else if skippedGroupIds.includes(group.id)}
													<span class="badge badge-ghost badge-sm"
														>{m.library_import_badgeSkipped()}</span
													>
												{:else if getGroupActionLabel(group) === 'link'}
													<span class="badge badge-sm badge-info"
														>{m.activity_unmatched_linkNow()}</span
													>
												{:else if getGroupActionLabel(group) === 'enroll'}
													<span class="badge badge-outline badge-sm"
														>{m.activity_unmatched_enrollAction()}</span
													>
												{/if}
												{#if !importedGroupIds.includes(group.id) && skipActionsEnabled}
													<button
														type="button"
														class="btn btn-ghost btn-xs"
														onclick={() =>
															skippedGroupIds.includes(group.id)
																? onUnskipGroup(group.id)
																: onSkipGroup(group.id)}
													>
														{skippedGroupIds.includes(group.id)
															? m.action_select()
															: m.library_import_skipItem()}
													</button>
												{/if}
											</div>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				</div>
			{/if}
		{/if}
	</div>
</div>
