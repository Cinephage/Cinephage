<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Settings, Zap } from '@lucide/svelte';
	import type { RootFolderBasic as RootFolder } from '#lib/types/downloadClient.js';

	interface ScoringProfile {
		id: string;
		name: string;
	}

	interface Props {
		sortBy: string;
		itemLimit: number;
		excludeInLibrary: boolean;
		refreshIntervalHours: number;
		autoAddBehavior: 'disabled' | 'add_only' | 'add_and_search';
		rootFolderId: string;
		scoringProfileId: string;
		autoAddMonitored: boolean;
		mediaType: 'movie' | 'tv';
		rootFolders: RootFolder[];
		scoringProfiles: ScoringProfile[];
		listSourceType?: 'tmdb-discover' | 'external-json';
		open?: boolean;
		onToggle?: (open: boolean) => void;
	}

	let {
		sortBy = $bindable(),
		itemLimit = $bindable(),
		excludeInLibrary = $bindable(),
		refreshIntervalHours = $bindable(),
		autoAddBehavior = $bindable(),
		rootFolderId = $bindable(),
		scoringProfileId = $bindable(),
		autoAddMonitored = $bindable(),
		mediaType,
		rootFolders,
		scoringProfiles,
		listSourceType = 'tmdb-discover',
		open = $bindable(false),
		onToggle
	}: Props = $props();

	const availableRootFolders = $derived(
		rootFolders.filter((folder) => folder.mediaType === mediaType && !folder.readOnly)
	);

	const sortOptions = [
		{ value: 'popularity.desc', label: m.smartlists_settings_sortMostPopular() },
		{ value: 'popularity.asc', label: m.smartlists_settings_sortLeastPopular() },
		{ value: 'vote_average.desc', label: m.smartlists_settings_sortHighestRated() },
		{ value: 'vote_average.asc', label: m.smartlists_settings_sortLowestRated() },
		{ value: 'primary_release_date.desc', label: m.smartlists_settings_sortNewest() },
		{ value: 'primary_release_date.asc', label: m.smartlists_settings_sortOldest() },
		{ value: 'title.asc', label: m.smartlists_settings_sortTitleAZ() },
		{ value: 'title.desc', label: m.smartlists_settings_sortTitleZA() }
	];

	const intervalOptions = [
		{ value: 1, label: m.smartlists_settings_everyHour() },
		{ value: 6, label: m.smartlists_settings_every6Hours() },
		{ value: 12, label: m.smartlists_settings_every12Hours() },
		{ value: 24, label: m.smartlists_settings_daily() },
		{ value: 48, label: m.smartlists_settings_every2Days() },
		{ value: 168, label: m.smartlists_settings_weekly() }
	];
</script>

<div class="collapse-arrow collapse rounded-lg border border-base-300 bg-base-100">
	<input
		type="checkbox"
		bind:checked={open}
		onchange={(e) => onToggle?.(e.currentTarget.checked)}
	/>
	<div class="collapse-title font-medium">
		<div class="flex items-center gap-2">
			<Settings class="h-4 w-4 text-base-content/70" />
			{m.smartlists_settings_title()}
		</div>
	</div>
	<div class="collapse-content">
		<div class="space-y-4 pt-2">
			<!-- Sort & Limit (only for TMDB Discover) -->
			{#if listSourceType === 'tmdb-discover'}
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<div class="form-control">
						<label class="label py-1" for="sortBy">
							<span
								class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
								>{m.smartlists_settings_sortBy()}</span
							>
						</label>
						<select id="sortBy" bind:value={sortBy} class="select-bordered select w-full select-sm">
							{#each sortOptions as opt (opt.value)}
								<option value={opt.value}>{opt.label}</option>
							{/each}
						</select>
					</div>
					<div class="form-control">
						<label class="label py-1" for="itemLimit">
							<span
								class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
								>{m.smartlists_settings_maxItems()}</span
							>
						</label>
						<input
							type="number"
							id="itemLimit"
							bind:value={itemLimit}
							min="1"
							max="1000"
							class="input-bordered input w-full input-sm"
						/>
					</div>
				</div>
			{/if}

			<!-- Refresh Interval -->
			<div class="form-control">
				<label class="label py-1" for="refreshInterval">
					<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
						>{m.smartlists_settings_refreshInterval()}</span
					>
				</label>
				<select
					id="refreshInterval"
					bind:value={refreshIntervalHours}
					class="select-bordered select w-full select-sm"
				>
					{#each intervalOptions as opt (opt.value)}
						<option value={opt.value}>{opt.label}</option>
					{/each}
				</select>
			</div>

			<!-- Exclude in Library -->
			<label class="flex cursor-pointer items-center gap-3 rounded-lg border border-base-300 p-3">
				<input
					type="checkbox"
					bind:checked={excludeInLibrary}
					class="checkbox checkbox-sm checkbox-primary"
				/>
				<span class="label-text">{m.smartlists_settings_excludeInLibrary()}</span>
			</label>

			<!-- Auto Search Section -->
			<div class="divider my-1 text-xs text-base-content/50">
				<div class="flex items-center gap-1">
					<Zap class="h-3 w-3" />
					{m.smartlists_settings_autoSearch()}
				</div>
			</div>

			<div class="form-control">
				<label class="label py-1" for="autoAdd">
					<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
						>{m.smartlists_settings_autoSearch()}</span
					>
				</label>
				<select
					id="autoAdd"
					bind:value={autoAddBehavior}
					class="select-bordered select w-full select-sm"
				>
					<option value="disabled">{m.smartlists_settings_autoSearchDisabled()}</option>
					<option value="add_only">{m.smartlists_settings_autoSearchAddOnly()}</option>
					<option value="add_and_search">{m.smartlists_settings_autoSearchAddAndSearch()}</option>
				</select>
			</div>

			{#if autoAddBehavior !== 'disabled'}
				<div class="space-y-3 rounded-lg border border-base-300 bg-base-200/30 p-3">
					<div class="form-control">
						<label class="label py-1" for="rootFolder">
							<span
								class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
								>{m.smartlists_settings_rootFolder()}</span
							>
						</label>
						<select
							id="rootFolder"
							bind:value={rootFolderId}
							class="select-bordered select w-full select-sm"
						>
							<option value="">{m.smartlists_settings_selectFolder()}</option>
							{#each availableRootFolders as folder (folder.id)}
								<option value={folder.id}>{folder.path}</option>
							{/each}
						</select>
						{#if availableRootFolders.length === 0}
							<p class="mt-1 text-xs text-warning">
								{m.smartlists_settings_noWritableRootFolders({
									mediaType: mediaType === 'movie' ? 'movie' : 'TV'
								})}
							</p>
						{/if}
					</div>

					<div class="form-control">
						<label class="label py-1" for="scoringProfile">
							<span
								class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
								>{m.smartlists_settings_scoringProfile()}</span
							>
						</label>
						<select
							id="scoringProfile"
							bind:value={scoringProfileId}
							class="select-bordered select w-full select-sm"
						>
							<option value="">{m.smartlists_settings_default()}</option>
							{#each scoringProfiles as profile (profile.id)}
								<option value={profile.id}>{profile.name}</option>
							{/each}
						</select>
					</div>

					<label class="flex cursor-pointer items-center gap-3">
						<input
							type="checkbox"
							bind:checked={autoAddMonitored}
							class="checkbox checkbox-sm checkbox-primary"
						/>
						<span class="label-text">{m.smartlists_settings_monitorAdded()}</span>
					</label>
				</div>
			{/if}
		</div>
	</div>
</div>
