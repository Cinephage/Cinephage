<script lang="ts">
	import { Eye, Tv, Calendar, Film, ChevronDown, ChevronUp } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import * as m from '#lib/paraglide/messages.js';

	export type MonitorType =
		| 'all'
		| 'future'
		| 'missing'
		| 'existing'
		| 'firstSeason'
		| 'lastSeason'
		| 'recent'
		| 'pilot'
		| 'none';

	export type MonitorNewItems = 'all' | 'none';
	export type SeriesType = 'standard' | 'anime' | 'daily';

	interface Season {
		season_number: number;
		name: string;
		episode_count: number;
		air_date?: string;
		poster_path?: string;
	}

	interface Props {
		seasons: Season[];
		monitorType: MonitorType;
		monitorNewItems: MonitorNewItems;
		monitorSpecials: boolean;
		seriesType: SeriesType;
		seasonFolder: boolean;
		monitoredSeasons: SvelteSet<number>;
		showAdvanced: boolean;
		onMonitoredInput?: () => void;
	}

	let {
		seasons,
		monitorType = $bindable(),
		monitorNewItems = $bindable(),
		monitorSpecials = $bindable(),
		seriesType = $bindable(),
		seasonFolder = $bindable(),
		monitoredSeasons,
		showAdvanced = $bindable(),
		onMonitoredInput
	}: Props = $props();

	let showSeasonSelection = $state(false);

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
			value: 'recent',
			label: m.library_monitorType_recentLabel(),
			description: m.library_monitorType_recentDesc()
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

	const monitorNewItemsOptions: { value: MonitorNewItems; label: string; description: string }[] = [
		{
			value: 'all',
			label: m.common_all(),
			description: m.library_monitorNewItems_allDesc()
		},
		{
			value: 'none',
			label: m.common_none(),
			description: m.library_monitorNewItems_noneDesc()
		}
	];

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

	// Check if all seasons are monitored
	const allSeasonsMonitored = $derived(
		seasons.length > 0 && seasons.every((s) => monitoredSeasons.has(s.season_number))
	);

	// Calculate monitoring summary for preview
	const monitoringSummary = $derived.by(() => {
		if (seasons.length === 0) return null;

		const regularSeasons = seasons.filter((s) => s.season_number > 0);
		const specials = seasons.find((s) => s.season_number === 0);
		const totalEpisodes = seasons.reduce((sum, s) => sum + s.episode_count, 0);
		const specialsEpisodes = specials?.episode_count ?? 0;
		const regularEpisodes = totalEpisodes - specialsEpisodes;

		// Calculate monitored seasons count
		const monitoredRegularSeasons = regularSeasons.filter((s) =>
			monitoredSeasons.has(s.season_number)
		).length;
		const monitoredSpecialsFlag = specials && monitoredSeasons.has(0);

		// Estimate monitored episodes based on monitor type
		let estimatedMonitoredEpisodes = 0;
		let monitorDescription = '';

		switch (monitorType) {
			case 'all':
				estimatedMonitoredEpisodes = regularEpisodes + (monitorSpecials ? specialsEpisodes : 0);
				monitorDescription = monitorSpecials
					? m.library_monitorDesc_allWithSpecials()
					: m.library_monitorDesc_allRegular();
				break;
			case 'future':
				monitorDescription = m.library_monitorDesc_future();
				estimatedMonitoredEpisodes = -1; // Unknown without air dates
				break;
			case 'missing':
				monitorDescription = m.library_monitorDesc_missing();
				estimatedMonitoredEpisodes = -1;
				break;
			case 'existing':
				monitorDescription = m.library_monitorDesc_existing();
				estimatedMonitoredEpisodes = -1;
				break;
			case 'firstSeason': {
				const firstSeason = regularSeasons.find((s) => s.season_number === 1);
				estimatedMonitoredEpisodes = firstSeason?.episode_count ?? 0;
				monitorDescription = m.library_monitorDesc_firstSeason();
				break;
			}
			case 'lastSeason': {
				const lastSeason = regularSeasons[regularSeasons.length - 1];
				estimatedMonitoredEpisodes = lastSeason?.episode_count ?? 0;
				monitorDescription = m.library_monitorDesc_lastSeason();
				break;
			}
			case 'recent':
				monitorDescription = m.library_monitorDesc_recent();
				estimatedMonitoredEpisodes = -1;
				break;
			case 'pilot':
				estimatedMonitoredEpisodes = 1;
				monitorDescription = m.library_monitorDesc_pilot();
				break;
			case 'none':
				estimatedMonitoredEpisodes = 0;
				monitorDescription = m.library_monitorDesc_none();
				break;
		}

		return {
			totalSeasons: regularSeasons.length,
			monitoredSeasons: monitoredRegularSeasons,
			hasSpecials: !!specials,
			specialsMonitored: monitoredSpecialsFlag,
			totalEpisodes,
			regularEpisodes,
			specialsEpisodes,
			estimatedMonitoredEpisodes,
			monitorDescription
		};
	});

	function toggleSeason(seasonNumber: number) {
		if (monitoredSeasons.has(seasonNumber)) {
			monitoredSeasons.delete(seasonNumber);
		} else {
			monitoredSeasons.add(seasonNumber);
		}
	}

	function toggleAllSeasons() {
		if (allSeasonsMonitored) {
			monitoredSeasons.clear();
		} else {
			for (const s of seasons) {
				monitoredSeasons.add(s.season_number);
			}
		}
	}
</script>

<!-- Monitored Toggle -->
<label class="flex cursor-pointer items-start gap-4 py-2">
	<input
		type="checkbox"
		class="toggle mt-0.5 shrink-0 toggle-primary"
		checked={monitorType !== 'none'}
		onchange={(e) => {
			onMonitoredInput?.();
			if (!e.currentTarget.checked) {
				monitorType = 'none';
			} else {
				monitorType = 'all';
			}
		}}
	/>
	<div class="min-w-0">
		<span class="flex items-center gap-2 text-sm font-medium">
			<Eye class="h-4 w-4 shrink-0" />
			{m.common_monitored()}
		</span>
		<p class="text-xs text-base-content/60">
			{monitorType !== 'none' ? m.library_add_monitoredDescYes() : m.library_add_monitoredDescNo()}
		</p>
	</div>
</label>

<!-- Monitor Type -->
<div class="form-control">
	<label class="label" for="monitor-type">
		<span class="label-text flex items-center gap-2 font-medium">
			<Tv class="h-4 w-4 shrink-0" />
			{m.library_add_monitor()}
		</span>
	</label>
	<select id="monitor-type" class="select-bordered select w-full" bind:value={monitorType}>
		{#each monitorTypeOptions as option (option.value)}
			<option value={option.value}>{option.label}</option>
		{/each}
	</select>
	<p class="mt-1 text-xs text-base-content/60">
		{monitorTypeOptions.find((o) => o.value === monitorType)?.description}
	</p>
</div>

<!-- Monitor New Items dropdown -->
<div class="form-control">
	<label class="label" for="monitor-new-items">
		<span class="label-text flex items-center gap-2 font-medium">
			<Calendar class="h-4 w-4 shrink-0" />
			{m.library_add_monitorNewItems()}
		</span>
	</label>
	<select id="monitor-new-items" class="select-bordered select w-full" bind:value={monitorNewItems}>
		{#each monitorNewItemsOptions as option (option.value)}
			<option value={option.value}>{option.label}</option>
		{/each}
	</select>
	<p class="mt-1 text-xs text-base-content/60">
		{monitorNewItemsOptions.find((o) => o.value === monitorNewItems)?.description}
	</p>
</div>

<!-- Monitor Specials Toggle -->
<label class="flex cursor-pointer items-start gap-4 py-2">
	<input
		type="checkbox"
		class="toggle mt-0.5 shrink-0 toggle-primary toggle-sm"
		bind:checked={monitorSpecials}
	/>
	<div class="min-w-0">
		<span class="flex items-center gap-2 text-sm font-medium"
			>{m.library_add_monitorSpecials()}</span
		>
		<p class="text-xs text-base-content/60">
			{monitorSpecials ? m.library_add_monitorSpecialsYes() : m.library_add_monitorSpecialsNo()}
		</p>
	</div>
</label>

<!-- Season Selection (Expandable) -->
{#if seasons.length > 0}
	<div class="form-control">
		<button
			type="button"
			class="btn w-full justify-between btn-ghost btn-sm"
			onclick={() => (showSeasonSelection = !showSeasonSelection)}
		>
			<span class="flex items-center gap-2">
				<Film class="h-4 w-4" />
				{m.library_add_seasonSelection()}
				<span class="badge badge-sm badge-primary">{monitoredSeasons.size}/{seasons.length}</span>
			</span>
			{#if showSeasonSelection}
				<ChevronUp class="h-4 w-4" />
			{:else}
				<ChevronDown class="h-4 w-4" />
			{/if}
		</button>

		{#if showSeasonSelection}
			<div class="mt-2 space-y-2 rounded-lg bg-base-300/50 p-3">
				<!-- Toggle All -->
				<label class="flex cursor-pointer items-center gap-3 rounded p-2 hover:bg-base-300">
					<input
						type="checkbox"
						class="checkbox checkbox-sm checkbox-primary"
						checked={allSeasonsMonitored}
						onchange={toggleAllSeasons}
					/>
					<span class="text-sm font-medium">{m.action_selectAll()}</span>
				</label>

				<div class="divider my-1"></div>

				<!-- Individual Seasons -->
				<div class="max-h-48 space-y-1 overflow-y-auto">
					{#each seasons as season (season.season_number)}
						<label class="flex cursor-pointer items-center gap-3 rounded p-2 hover:bg-base-300">
							<input
								type="checkbox"
								class="checkbox checkbox-sm checkbox-primary"
								checked={monitoredSeasons.has(season.season_number)}
								onchange={() => toggleSeason(season.season_number)}
							/>
							<div class="min-w-0 flex-1">
								<span class="text-sm font-medium">
									{season.season_number === 0
										? m.library_add_specials()
										: m.library_tvDetail_seasonFallback({ number: season.season_number })}
								</span>
								<span class="ml-2 text-xs text-base-content/60">
									{m.library_add_episodeCount({ count: season.episode_count })}
								</span>
							</div>
							{#if season.air_date}
								<span class="text-xs text-base-content/50">
									{new Date(season.air_date).getFullYear()}
								</span>
							{/if}
						</label>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}

<!-- Monitoring Preview -->
{#if monitoringSummary}
	{@const summary = monitoringSummary}
	<div class="rounded-lg border border-primary/20 bg-primary/5 p-4">
		<h4 class="mb-2 flex items-center gap-2 text-sm font-semibold text-primary">
			<Eye class="h-4 w-4" />
			{m.library_add_monitoringPreview()}
		</h4>
		<p class="mb-3 text-sm text-base-content/70">{summary.monitorDescription}</p>
		<div class="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
			<div class="rounded bg-base-200 px-2 py-1">
				<span class="text-base-content/50">{m.common_seasons()}:</span>
				<span class="ml-1 font-medium">{summary.monitoredSeasons}/{summary.totalSeasons}</span>
			</div>
			{#if summary.estimatedMonitoredEpisodes >= 0}
				<div class="rounded bg-base-200 px-2 py-1">
					<span class="text-base-content/50">{m.common_episodes()}:</span>
					<span class="ml-1 font-medium">~{summary.estimatedMonitoredEpisodes}</span>
				</div>
			{:else}
				<div class="rounded bg-base-200 px-2 py-1">
					<span class="text-base-content/50">{m.common_episodes()}:</span>
					<span class="ml-1 font-medium italic">{m.common_dynamic()}</span>
				</div>
			{/if}
			{#if summary.hasSpecials}
				<div class="rounded bg-base-200 px-2 py-1 sm:col-span-2">
					<span class="text-base-content/50">{m.library_add_specials()}:</span>
					<span class="ml-1 font-medium">
						{summary.specialsMonitored
							? m.library_add_monitoredEps({ count: summary.specialsEpisodes })
							: m.library_add_notMonitored()}
					</span>
				</div>
			{/if}
		</div>
	</div>
{/if}

<!-- Advanced Options -->
<button
	type="button"
	class="divider cursor-pointer text-xs text-base-content/50"
	onclick={() => (showAdvanced = !showAdvanced)}
>
	{showAdvanced ? m.common_hide() : m.common_show()}
	{m.common_advancedOptions()}
	{#if showAdvanced}
		<ChevronUp class="ml-1 inline h-3 w-3" />
	{:else}
		<ChevronDown class="ml-1 inline h-3 w-3" />
	{/if}
</button>

{#if showAdvanced}
	<!-- Series Type -->
	<div class="form-control">
		<label class="label" for="series-type">
			<span class="label-text font-medium">{m.library_add_seriesType()}</span>
		</label>
		<select
			id="series-type"
			class="select-bordered select w-full select-sm"
			bind:value={seriesType}
		>
			{#each seriesTypeOptions as option (option.value)}
				<option value={option.value}>{option.label}</option>
			{/each}
		</select>
		<p class="mt-1 text-xs text-base-content/60">
			{seriesTypeOptions.find((o) => o.value === seriesType)?.description}
		</p>
	</div>

	<!-- Season Folder Toggle -->
	<label class="flex cursor-pointer items-start gap-4 py-2">
		<input
			type="checkbox"
			class="toggle mt-0.5 shrink-0 toggle-primary toggle-sm"
			bind:checked={seasonFolder}
		/>
		<div class="min-w-0">
			<span class="text-sm font-medium">{m.library_add_useSeasonFolders()}</span>
			<p class="text-xs text-base-content/60">
				{seasonFolder ? m.library_add_seasonFoldersYes() : m.library_add_seasonFoldersNo()}
			</p>
		</div>
	</label>
{/if}
