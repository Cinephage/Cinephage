<script lang="ts">
	import { FolderOpen, BarChart3, Search, Captions, Eye, Calendar, Tv } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { getWritableRootFoldersForMediaType } from '#lib/utils/root-folders.js';
	import * as m from '#lib/paraglide/messages.js';
	import { formatBytes } from '#lib/utils/format.js';
	import type { RootFolderWithSpaceAndDefault as RootFolder } from '#lib/types/downloadClient.js';

	interface ScoringProfile {
		id: string;
		name: string;
		description?: string;
		isBuiltIn: boolean;
		isDefault?: boolean;
	}

	type MinimumAvailability = 'announced' | 'inCinemas' | 'released';
	type MonitorType =
		| 'all'
		| 'future'
		| 'missing'
		| 'existing'
		| 'firstSeason'
		| 'lastSeason'
		| 'recent'
		| 'pilot'
		| 'none';
	type MonitorNewItems = 'all' | 'none';
	type SeriesType = 'standard' | 'anime' | 'daily';

	interface Props {
		movieCount: number;
		tvCount: number;
		rootFolders: RootFolder[];
		scoringProfiles: ScoringProfile[];
		movieRootFolder: string;
		tvRootFolder: string;
		selectedScoringProfile: string;
		searchOnAdd: boolean;
		wantsSubtitles: boolean;
		movieMonitored: boolean;
		minimumAvailability: MinimumAvailability;
		availabilityDelay: number;
		tvMonitored: boolean;
		monitorType: MonitorType;
		monitorNewItems: MonitorNewItems;
		monitorSpecials: boolean;
		seriesType: SeriesType;
		seasonFolder: boolean;
	}

	let {
		movieCount,
		tvCount,
		rootFolders,
		scoringProfiles,
		movieRootFolder = $bindable(),
		tvRootFolder = $bindable(),
		selectedScoringProfile = $bindable(),
		searchOnAdd = $bindable(),
		wantsSubtitles = $bindable(),
		movieMonitored = $bindable(),
		minimumAvailability = $bindable(),
		availabilityDelay = $bindable(),
		tvMonitored = $bindable(),
		monitorType = $bindable(),
		monitorNewItems = $bindable(),
		monitorSpecials = $bindable(),
		seriesType = $bindable(),
		seasonFolder = $bindable()
	}: Props = $props();

	const movieRootFolders = $derived(getWritableRootFoldersForMediaType(rootFolders, 'movie'));
	const tvRootFolders = $derived(getWritableRootFoldersForMediaType(rootFolders, 'tv'));
	const selectedProfileObj = $derived(scoringProfiles.find((p) => p.id === selectedScoringProfile));

	const availabilityOptions: { value: MinimumAvailability; label: string; description: string }[] =
		[
			{
				value: 'announced',
				label: m.library_availability_announcedLabel(),
				description: m.library_availability_announcedDesc()
			},
			{
				value: 'inCinemas',
				label: m.library_availability_inCinemasLabel(),
				description: m.library_availability_inCinemasDesc()
			},
			{
				value: 'released',
				label: m.library_availability_releasedLabel(),
				description: m.library_availability_releasedDesc()
			}
		];

	const monitorTypeOptions: { value: MonitorType; label: string; description: string }[] = [
		{
			value: 'all',
			label: m.library_monitorType_allLabel(),
			description: m.library_monitorType_allDesc()
		},
		{
			value: 'future',
			label: m.library_monitorType_futureLabel(),
			description: m.library_monitorType_futureDesc()
		},
		{
			value: 'missing',
			label: m.library_monitorType_missingLabel(),
			description: m.library_monitorType_missingDesc()
		},
		{
			value: 'existing',
			label: m.library_monitorType_existingLabel(),
			description: m.library_monitorType_existingDesc()
		},
		{
			value: 'recent',
			label: m.library_monitorType_recentLabel(),
			description: m.library_monitorType_recentDesc()
		},
		{
			value: 'firstSeason',
			label: m.library_monitorType_firstSeasonLabel(),
			description: m.library_monitorType_firstSeasonDesc()
		},
		{
			value: 'lastSeason',
			label: m.library_monitorType_lastSeasonLabel(),
			description: m.library_monitorType_lastSeasonDesc()
		},
		{
			value: 'pilot',
			label: m.library_monitorType_pilotLabel(),
			description: m.library_monitorType_pilotDesc()
		},
		{
			value: 'none',
			label: m.library_monitorType_noneLabel(),
			description: m.library_monitorType_noneDesc()
		}
	];
	const selectedMonitorTypeObj = $derived(monitorTypeOptions.find((o) => o.value === monitorType));

	const monitorNewItemsOptions: { value: MonitorNewItems; label: string; description: string }[] = [
		{ value: 'all', label: m.common_all(), description: m.library_monitorNewItems_allDesc() },
		{ value: 'none', label: m.common_none(), description: m.library_monitorNewItems_noneDesc() }
	];
	const selectedMonitorNewItemsObj = $derived(
		monitorNewItemsOptions.find((o) => o.value === monitorNewItems)
	);

	const seriesTypeOptions: { value: SeriesType; label: string; description: string }[] = [
		{
			value: 'standard',
			label: m.library_seriesType_standardLabel(),
			description: m.library_seriesType_standardDesc()
		},
		{
			value: 'anime',
			label: m.library_seriesType_animeLabel(),
			description: m.library_seriesType_animeDesc()
		},
		{
			value: 'daily',
			label: m.library_seriesType_dailyLabel(),
			description: m.library_seriesType_dailyDesc()
		}
	];
	const selectedSeriesTypeObj = $derived(seriesTypeOptions.find((o) => o.value === seriesType));
</script>

<div class="space-y-5">
	{#if movieCount > 0}
		<section class="space-y-4">
			<h4
				class="flex items-center gap-2 text-sm font-bold tracking-wide text-base-content/70 uppercase"
			>
				{m.discover_bulkAdd_moviesHeading({ count: movieCount })}
			</h4>

			<!-- Root Folder -->
			<div class="form-control min-w-0">
				<label class="label" for="bulk-movie-root-folder">
					<span class="label-text flex items-center gap-2 font-medium">
						<FolderOpen class="h-4 w-4 shrink-0" />
						{m.common_rootFolder()}
					</span>
				</label>
				{#if movieRootFolders.length === 0}
					<div class="alert text-sm alert-warning">
						<span>
							{m.library_add_noRootFoldersConfigured({
								mediaType: m.common_movies().toLowerCase()
							})}
							<a href={resolve('settings/library/libraries')} class="link"
								>{m.library_add_addOneInSettings()}</a
							>
						</span>
					</div>
				{:else}
					<select
						id="bulk-movie-root-folder"
						class="select-bordered select w-full max-w-full"
						bind:value={movieRootFolder}
					>
						{#each movieRootFolders as folder (folder.id)}
							<option value={folder.id}>
								{folder.name}
								{#if folder.freeSpaceBytes}
									({m.library_add_rootFolderFree({ free: formatBytes(folder.freeSpaceBytes) })})
								{/if}
							</option>
						{/each}
					</select>
				{/if}
			</div>

			<!-- Monitored -->
			<label class="flex cursor-pointer items-start gap-4 py-1">
				<input
					type="checkbox"
					class="toggle mt-0.5 shrink-0 toggle-primary"
					bind:checked={movieMonitored}
				/>
				<div class="min-w-0">
					<span class="flex items-center gap-2 text-sm font-medium">
						<Eye class="h-4 w-4 shrink-0" />
						{m.common_monitored()}
					</span>
					<p class="text-xs text-base-content/60">
						{movieMonitored
							? m.library_add_movie_monitoredDescYes()
							: m.library_add_movie_monitoredDescNo()}
					</p>
				</div>
			</label>

			<!-- Minimum Availability -->
			<div class="form-control min-w-0">
				<label class="label" for="bulk-minimum-availability">
					<span class="label-text flex items-center gap-2 font-medium">
						<Calendar class="h-4 w-4 shrink-0" />
						{m.library_minimumAvailability()}
					</span>
				</label>
				<select
					id="bulk-minimum-availability"
					class="select-bordered select w-full max-w-full"
					bind:value={minimumAvailability}
				>
					{#each availabilityOptions as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
				<p class="mt-1 text-xs text-base-content/60">
					{availabilityOptions.find((o) => o.value === minimumAvailability)?.description}
				</p>
			</div>

			<!-- Availability Delay -->
			<div class="form-control min-w-0">
				<label class="label" for="bulk-availability-delay">
					<span class="label-text flex items-center gap-2 font-medium">
						<Calendar class="h-4 w-4 shrink-0" />
						{m.library_availabilityDelay_label()}
					</span>
				</label>
				<div class="flex items-center gap-2">
					<input
						id="bulk-availability-delay"
						type="number"
						class="input-bordered input w-24"
						min="0"
						max="365"
						bind:value={availabilityDelay}
					/>
					<span class="text-sm text-base-content/60">{m.library_availabilityDelay_unit()}</span>
				</div>
			</div>
		</section>
	{/if}

	{#if tvCount > 0}
		<section class="space-y-4">
			<h4
				class="flex items-center gap-2 text-sm font-bold tracking-wide text-base-content/70 uppercase"
			>
				<Tv class="h-4 w-4" />
				{m.discover_bulkAdd_tvHeading({ count: tvCount })}
			</h4>

			<!-- Root Folder -->
			<div class="form-control min-w-0">
				<label class="label" for="bulk-tv-root-folder">
					<span class="label-text flex items-center gap-2 font-medium">
						<FolderOpen class="h-4 w-4 shrink-0" />
						{m.common_rootFolder()}
					</span>
				</label>
				{#if tvRootFolders.length === 0}
					<div class="alert text-sm alert-warning">
						<span>
							{m.library_add_noRootFoldersConfigured({
								mediaType: m.common_tvShows().toLowerCase()
							})}
							<a href={resolve('settings/library/libraries')} class="link"
								>{m.library_add_addOneInSettings()}</a
							>
						</span>
					</div>
				{:else}
					<select
						id="bulk-tv-root-folder"
						class="select-bordered select w-full max-w-full"
						bind:value={tvRootFolder}
					>
						{#each tvRootFolders as folder (folder.id)}
							<option value={folder.id}>
								{folder.name}
								{#if folder.freeSpaceBytes}
									({m.library_add_rootFolderFree({ free: formatBytes(folder.freeSpaceBytes) })})
								{/if}
							</option>
						{/each}
					</select>
				{/if}
			</div>

			<!-- Monitored -->
			<label class="flex cursor-pointer items-start gap-4 py-1">
				<input
					type="checkbox"
					class="toggle mt-0.5 shrink-0 toggle-primary"
					bind:checked={tvMonitored}
				/>
				<div class="min-w-0">
					<span class="flex items-center gap-2 text-sm font-medium">
						<Eye class="h-4 w-4 shrink-0" />
						{m.common_monitored()}
					</span>
					<p class="text-xs text-base-content/60">
						{tvMonitored ? m.library_add_monitoredDescYes() : m.library_add_monitoredDescNo()}
					</p>
				</div>
			</label>

			<!-- Monitor New Items -->
			<div class="form-control min-w-0">
				<label class="label" for="bulk-monitor-new-items">
					<span class="label-text text-sm font-medium">{m.library_add_monitorNewItems()}</span>
				</label>
				<select
					id="bulk-monitor-new-items"
					class="select-bordered select w-full max-w-full select-sm"
					bind:value={monitorNewItems}
					disabled={!tvMonitored}
				>
					{#each monitorNewItemsOptions as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
				{#if tvMonitored}
					<p class="mt-1 text-xs text-base-content/60">{selectedMonitorNewItemsObj?.description}</p>
				{/if}
			</div>

			<!-- Monitor Scope -->
			<div class="form-control min-w-0">
				<label class="label" for="bulk-monitor-type">
					<span class="label-text flex items-center gap-2 font-medium">
						<Tv class="h-4 w-4 shrink-0" />
						{m.discover_bulkAdd_monitorScope()}
					</span>
				</label>
				<select
					id="bulk-monitor-type"
					class="select-bordered select w-full max-w-full select-sm"
					bind:value={monitorType}
					disabled={!tvMonitored}
				>
					{#each monitorTypeOptions as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
				{#if tvMonitored}
					<p class="mt-1 text-xs text-base-content/60">{selectedMonitorTypeObj?.description}</p>
				{/if}
			</div>

			<!-- Monitor Specials -->
			<label
				class="flex cursor-pointer items-center gap-3 text-sm {tvMonitored
					? ''
					: 'pointer-events-none opacity-50'}"
			>
				<input
					type="checkbox"
					class="toggle shrink-0 toggle-primary toggle-sm"
					bind:checked={monitorSpecials}
					disabled={!tvMonitored}
				/>
				<span
					>{monitorSpecials
						? m.library_add_monitorSpecialsYes()
						: m.library_add_monitorSpecialsNo()}</span
				>
			</label>

			<!-- Series Type -->
			<div class="form-control min-w-0">
				<label class="label" for="bulk-series-type">
					<span class="label-text text-sm font-medium">{m.library_add_seriesType()}</span>
				</label>
				<select
					id="bulk-series-type"
					class="select-bordered select w-full max-w-full select-sm"
					bind:value={seriesType}
				>
					{#each seriesTypeOptions as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
				<p class="mt-1 text-xs text-base-content/60">{selectedSeriesTypeObj?.description}</p>
			</div>

			<!-- Season Folders -->
			<label class="flex cursor-pointer items-center gap-3 text-sm">
				<input
					type="checkbox"
					class="toggle shrink-0 toggle-primary toggle-sm"
					bind:checked={seasonFolder}
				/>
				<span
					>{seasonFolder ? m.library_add_seasonFoldersYes() : m.library_add_seasonFoldersNo()}</span
				>
			</label>
		</section>
	{/if}

	<!-- Shared settings -->
	<section class="space-y-4 border-t border-base-300 pt-4">
		<h4 class="text-sm font-bold tracking-wide text-base-content/70 uppercase">
			{m.discover_bulkAdd_allItemsHeading()}
		</h4>

		<!-- Quality Profile -->
		<div class="form-control min-w-0">
			<label class="label" for="bulk-scoring-profile">
				<span class="label-text flex items-center gap-2 font-medium">
					<BarChart3 class="h-4 w-4 shrink-0" />
					{m.common_qualityProfile()}
				</span>
			</label>
			<select
				id="bulk-scoring-profile"
				class="select-bordered select w-full max-w-full"
				bind:value={selectedScoringProfile}
			>
				{#each scoringProfiles as profile (profile.id)}
					<option value={profile.id}>{profile.name}</option>
				{/each}
			</select>
			{#if selectedProfileObj?.description}
				<p class="mt-1 text-xs text-base-content/60">{selectedProfileObj.description}</p>
			{/if}
		</div>

		<!-- Search on Add -->
		<label class="flex cursor-pointer items-start gap-4 py-1">
			<input
				type="checkbox"
				class="toggle mt-0.5 shrink-0 toggle-success"
				bind:checked={searchOnAdd}
			/>
			<div class="min-w-0">
				<span class="flex items-center gap-2 text-sm font-medium">
					<Search class="h-4 w-4 shrink-0" />
					{m.library_add_searchImmediately()}
				</span>
				<p class="text-xs text-base-content/60">
					{searchOnAdd
						? m.discover_bulkAdd_searchImmediatelyDescYes()
						: m.discover_bulkAdd_searchImmediatelyDescNo()}
				</p>
			</div>
		</label>

		<!-- Auto-Download Subtitles -->
		<label class="flex cursor-pointer items-start gap-4 py-1">
			<input
				type="checkbox"
				class="toggle mt-0.5 shrink-0 toggle-primary"
				bind:checked={wantsSubtitles}
			/>
			<div class="min-w-0">
				<span class="flex items-center gap-2 text-sm font-medium">
					<Captions class="h-4 w-4 shrink-0" />
					{m.library_add_autoDownloadSubtitles()}
				</span>
				<p class="text-xs text-base-content/60">
					{wantsSubtitles
						? m.library_editMovie_autoDownloadSubtitlesDesc()
						: m.discover_bulkAdd_subtitlesDescNo()}
				</p>
			</div>
		</label>
	</section>
</div>
