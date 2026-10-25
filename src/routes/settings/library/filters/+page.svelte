<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { updateTmdbFilters } from '#lib/api/settings.js';
	import TmdbConfigRequired from '#lib/components/ui/TmdbConfigRequired.svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { SettingsPage, SettingsSection } from '#lib/components/ui/settings/index.js';
	import type { GlobalTmdbFilters } from '#lib/types/tmdb.js';
	import type { PageData } from './$types';
	import { page } from '$app/state';
	import { TMDB } from '#lib/config/constants.js';

	let { data }: { data: PageData } = $props();
	let filtersState = $state<GlobalTmdbFilters>({
		include_adult: false,
		min_vote_average: 0,
		min_vote_count: 0,
		language: `en-${page.data.defaultRegion || TMDB.DEFAULT_REGION}`,
		region: page.data.defaultRegion || TMDB.DEFAULT_REGION,
		excluded_genre_ids: []
	});
	let saving = $state(false);

	function toggleExcludedGenre(genreId: number, checked: boolean) {
		if (checked) {
			if (!filtersState.excluded_genre_ids.includes(genreId)) {
				filtersState.excluded_genre_ids = [...filtersState.excluded_genre_ids, genreId];
			}
		} else {
			filtersState.excluded_genre_ids = filtersState.excluded_genre_ids.filter(
				(currentGenreId) => currentGenreId !== genreId
			);
		}
	}

	async function handleSave() {
		saving = true;

		try {
			await updateTmdbFilters(filtersState);
			toasts.success(m.settings_filters_updated());
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : m.settings_filters_failedToSave());
		} finally {
			saving = false;
		}
	}

	$effect(() => {
		filtersState = { ...data.filters };
	});
</script>

<svelte:head>
	<title>{m.settings_filters_pageTitle()}</title>
</svelte:head>

<SettingsPage title={m.settings_filters_heading()} subtitle={m.settings_filters_subtitle()}>
	{#if !data.tmdbConfigured}
		<div class="-mt-2">
			<TmdbConfigRequired message={m.settings_filters_tmdbRequired()} />
		</div>
	{/if}

	<!-- Content Settings -->
	<SettingsSection title={m.settings_filters_contentPreferences()}>
		<div class="form-control">
			<label class="label cursor-pointer justify-start gap-4">
				<input
					type="checkbox"
					class="checkbox checkbox-primary"
					bind:checked={filtersState.include_adult}
				/>
				<span class="label-text">{m.settings_filters_includeAdult()}</span>
			</label>
			<p class="pl-10 text-xs text-base-content/60">
				{m.settings_filters_includeAdultHint()}
			</p>
		</div>
	</SettingsSection>

	<!-- Quality Settings -->
	<SettingsSection title={m.settings_filters_qualityStandards()}>
		<div class="grid gap-6 md:grid-cols-2">
			<div class="form-control">
				<label class="label" for="min_vote_average">
					<span class="label-text">{m.settings_filters_minScore()}</span>
				</label>
				<input
					type="number"
					id="min_vote_average"
					min="0"
					max="10"
					step="0.1"
					bind:value={filtersState.min_vote_average}
					class="input-bordered input w-full"
				/>
			</div>
			<div class="form-control">
				<label class="label" for="min_vote_count">
					<span class="label-text">{m.settings_filters_minVoteCount()}</span>
				</label>
				<input
					type="number"
					id="min_vote_count"
					min="0"
					bind:value={filtersState.min_vote_count}
					class="input-bordered input w-full"
				/>
			</div>
		</div>
	</SettingsSection>

	<!-- Genre Exclusion -->
	<SettingsSection
		title={m.settings_filters_excludedGenres()}
		description={m.settings_filters_excludedGenresHint()}
	>
		{#if data.genres.length === 0}
			<p class="text-sm text-base-content/50 italic">
				{#if !data.tmdbConfigured}
					{m.settings_filters_configureTmdbForGenres()}
				{:else}
					{m.settings_filters_noGenresAvailable()}
				{/if}
			</p>
		{:else}
			<div class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
				{#each data.genres as genre (genre.id)}
					<label class="label cursor-pointer justify-start gap-2">
						<input
							type="checkbox"
							class="checkbox checkbox-sm checkbox-primary"
							checked={filtersState.excluded_genre_ids.includes(genre.id)}
							onchange={(event) => toggleExcludedGenre(genre.id, event.currentTarget.checked)}
						/>
						<span class="label-text">{genre.name}</span>
					</label>
				{/each}
			</div>
		{/if}
	</SettingsSection>

	<div class="flex justify-end">
		<button class="btn btn-primary" onclick={handleSave} disabled={saving}>
			{saving ? m.common_saving() : m.settings_filters_saveButton()}
		</button>
	</div>
</SettingsPage>
