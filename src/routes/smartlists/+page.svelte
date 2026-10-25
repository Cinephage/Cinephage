<script lang="ts">
	import { refreshAll, goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import {
		Plus,
		List,
		RefreshCw,
		Trash2,
		Edit,
		Film,
		Tv,
		CheckCircle,
		AlertCircle,
		Clock,
		ExternalLink
	} from '@lucide/svelte';
	import type { PageData } from './$types';
	import * as m from '#lib/paraglide/messages.js';
	import { refreshSmartList, deleteSmartList, updateSmartList } from '#lib/api/index.js';
	import { formatDisplayDate } from '#lib/utils/format.js';

	let { data }: { data: PageData } = $props();

	let refreshingIds = new SvelteSet<string>();
	let deletingIds = new SvelteSet<string>();
	let actionError = $state<string | null>(null);
	let confirmDeleteOpen = $state(false);
	let deleteLoading = $state(false);
	let deleteTarget = $state<{ id: string; name: string } | null>(null);
	type SmartListRow = (typeof data.lists)[number];

	function navigateToCreate() {
		goto('/smartlists/new');
	}

	async function refreshList(id: string) {
		actionError = null;
		refreshingIds.add(id);
		try {
			const result = (await refreshSmartList(id)) as {
				error?: string;
				errorMessage?: string;
				status?: string;
			};

			if (result?.status === 'failed') {
				throw new Error(result?.errorMessage ?? result?.error ?? 'Smart list refresh failed');
			}

			await refreshAll();
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Smart list refresh failed';
		} finally {
			refreshingIds.delete(id);
		}
	}

	function openDeleteModal(list: (typeof data.lists)[0]) {
		actionError = null;
		deleteTarget = { id: list.id, name: list.name };
		confirmDeleteOpen = true;
	}

	async function handleConfirmDelete() {
		if (!deleteTarget || deleteLoading) return;

		const { id } = deleteTarget;
		deleteLoading = true;
		deletingIds.add(id);
		try {
			await deleteSmartList(id);

			await refreshAll();
			confirmDeleteOpen = false;
			deleteTarget = null;
		} catch (error) {
			actionError = error instanceof Error ? error.message : 'Failed to delete smart list';
		} finally {
			deleteLoading = false;
			deletingIds.delete(id);
		}
	}

	async function toggleEnabled(list: (typeof data.lists)[0]) {
		await updateSmartList(list.id, { enabled: !list.enabled });
		await refreshAll();
	}

	function formatDate(dateString: string | null): string {
		if (!dateString) return m.smartlists_formatDate_never();
		const date = new Date(dateString);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMins / 60);
		const diffDays = Math.floor(diffHours / 24);

		if (diffMins < 1) return m.smartlists_formatDate_justNow();
		if (diffMins < 60) return m.smartlists_formatDate_minutesAgo({ count: diffMins });
		if (diffHours < 24) return m.smartlists_formatDate_hoursAgo({ count: diffHours });
		if (diffDays < 7) return m.smartlists_formatDate_daysAgo({ count: diffDays });
		return formatDisplayDate(dateString);
	}

	function getSortLabel(sortBy: string | null | undefined): string {
		switch (sortBy) {
			case 'popularity.desc':
				return m.smartlists_sort_mostPopularFirst();
			case 'popularity.asc':
				return m.smartlists_sort_leastPopularFirst();
			case 'vote_average.desc':
				return m.smartlists_sort_highestRatedFirst();
			case 'vote_average.asc':
				return m.smartlists_sort_lowestRatedFirst();
			case 'primary_release_date.desc':
			case 'first_air_date.desc':
				return m.smartlists_sort_newestFirst();
			case 'primary_release_date.asc':
			case 'first_air_date.asc':
				return m.smartlists_sort_oldestFirst();
			case 'title.asc':
				return m.smartlists_sort_titleAZ();
			case 'title.desc':
				return m.smartlists_sort_titleZA();
			default:
				return m.smartlists_sort_customOrder();
		}
	}

	function getSourceLabel(list: SmartListRow): string {
		if (list.listSourceType === 'external-json') {
			if (list.presetProvider === 'imdb-list') return m.smartlists_source_imdb();
			if (list.presetProvider === 'tmdb-list') return m.smartlists_source_tmdbList();
			if (list.presetProvider === 'stevenlu') return m.smartlists_source_stevenLu();
			return m.smartlists_source_external();
		}
		if (list.listSourceType === 'trakt-list') return m.smartlists_source_trakt();
		if (list.listSourceType === 'custom-manual') return m.smartlists_source_manualCuration();
		return m.smartlists_source_tmdbDiscover();
	}

	function getDisplayDescription(list: SmartListRow): string {
		const explicit = list.description?.trim();
		if (explicit) return explicit;

		const mediaLabel = list.mediaType === 'movie' ? m.common_movies() : m.common_tvShows();
		const autoAddSuffix =
			list.autoAddBehavior !== 'disabled' ? ` ${m.smartlists_desc_autoAddEnabled()}` : '';

		if (list.listSourceType === 'tmdb-discover') {
			const filters = (list.filters ?? {}) as Record<string, unknown>;
			const hints: string[] = [];
			const withGenres = Array.isArray(filters.withGenres) ? filters.withGenres.length : 0;
			const withKeywords = Array.isArray(filters.withKeywords) ? filters.withKeywords.length : 0;
			const yearMin = typeof filters.yearMin === 'number' ? filters.yearMin : undefined;
			const yearMax = typeof filters.yearMax === 'number' ? filters.yearMax : undefined;
			const voteAverageMin =
				typeof filters.voteAverageMin === 'number' ? filters.voteAverageMin : undefined;

			if (withGenres > 0) hints.push(m.smartlists_desc_genreFilters({ count: withGenres }));
			if (withKeywords > 0) hints.push(m.smartlists_desc_keywordFilters({ count: withKeywords }));
			if (yearMin || yearMax) {
				const min = String(yearMin ?? m.smartlists_desc_yearAny());
				const max = String(yearMax ?? m.smartlists_desc_yearAny());
				hints.push(m.smartlists_desc_years({ min, max }));
			}
			if (voteAverageMin !== undefined)
				hints.push(m.smartlists_desc_rated({ rating: String(voteAverageMin) }));
			if (list.excludeInLibrary) hints.push(m.smartlists_desc_excludingInLibrary());

			const hintText = hints.length > 0 ? ` ${hints.slice(0, 2).join(', ')}.` : '.';
			return `${m.smartlists_desc_tmdbDiscover({ media: mediaLabel, sort: getSortLabel(list.sortBy) })}.${hintText}${autoAddSuffix}`;
		}

		if (list.listSourceType === 'external-json') {
			return `${m.smartlists_desc_syncedFrom({ source: getSourceLabel(list), media: mediaLabel })}.${autoAddSuffix}`;
		}

		if (list.listSourceType === 'trakt-list') {
			return `${m.smartlists_desc_syncedFrom({ source: m.smartlists_source_trakt(), media: mediaLabel })}.${autoAddSuffix}`;
		}

		if (list.listSourceType === 'custom-manual') {
			return `${m.smartlists_desc_manuallyCurated({ media: mediaLabel })}.${autoAddSuffix}`;
		}

		return `${m.smartlists_desc_dynamicList({ media: mediaLabel })}.${autoAddSuffix}`;
	}
</script>

<svelte:head>
	<title>{m.smartlists_pageTitle()}</title>
</svelte:head>

<div class="w-full p-3 sm:p-4">
	{#if actionError}
		<div class="mb-4 alert py-2 alert-error">
			<AlertCircle class="h-4 w-4" />
			<span>{actionError}</span>
		</div>
	{/if}

	<div class="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
		<div class="min-w-0">
			<h1 class="text-2xl font-bold">{m.smartlists_heading()}</h1>
			<p class="text-base-content/70">
				{m.smartlists_subtitle()}
			</p>
		</div>
		<button class="btn gap-2 btn-primary btn-sm sm:w-auto" onclick={navigateToCreate}>
			<Plus class="h-4 w-4" />
			{m.smartlists_createButton()}
		</button>
	</div>

	{#if data.lists.length === 0}
		<div class="card bg-base-100 shadow-xl">
			<div class="card-body items-center text-center">
				<List class="h-16 w-16 text-base-content/30" />
				<h2 class="card-title">{m.smartlists_emptyTitle()}</h2>
				<p class="text-base-content/70">
					{m.smartlists_emptyDescription()}
				</p>
				<button class="btn mt-4 btn-primary" onclick={navigateToCreate}>
					<Plus class="h-4 w-4" />
					{m.smartlists_createButton()}
				</button>
			</div>
		</div>
	{:else}
		<div class="grid gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-3">
			{#each data.lists as list (list.id)}
				<div class="card bg-base-100 shadow-xl">
					<div class="card-body p-4 sm:p-6">
						<div class="flex items-start justify-between gap-3">
							<a
								class="flex min-w-0 items-center gap-2 text-left hover:opacity-80"
								href={`/smartlists/${list.id}`}
								data-sveltekit-preload-data="hover"
							>
								{#if list.mediaType === 'movie'}
									<Film class="h-5 w-5 shrink-0 text-primary" />
								{:else}
									<Tv class="h-5 w-5 shrink-0 text-secondary" />
								{/if}
								<h2 class="card-title min-w-0 truncate text-lg">{list.name}</h2>
							</a>
							<input
								type="checkbox"
								class="toggle shrink-0 toggle-sm toggle-success"
								checked={list.enabled}
								onchange={() => toggleEnabled(list)}
							/>
						</div>

						<div class="h-10">
							<p class="line-clamp-2 text-sm leading-5 text-base-content/70">
								{getDisplayDescription(list)}
							</p>
						</div>

						<div class="mt-2 flex flex-wrap gap-1.5 sm:gap-2">
							<div class="badge badge-ghost badge-sm">
								{m.smartlists_itemsBadge({ count: list.cachedItemCount ?? 0 })}
							</div>
							<div class="badge badge-ghost badge-sm">
								{m.smartlists_inLibraryBadge({ count: list.itemsInLibrary ?? 0 })}
							</div>
							{#if list.autoAddBehavior !== 'disabled'}
								<div class="badge badge-outline badge-sm badge-info">
									{m.smartlists_autoAddBadge()}
								</div>
							{/if}
							{#if list.listSourceType === 'external-json'}
								{#if list.presetProvider === 'imdb-list'}
									<div class="badge badge-outline badge-sm badge-secondary">
										{m.smartlists_source_imdb()}
									</div>
								{:else if list.presetProvider === 'tmdb-list'}
									<div class="badge badge-outline badge-sm badge-primary">
										{m.smartlists_source_tmdbList()}
									</div>
								{:else if list.presetProvider === 'stevenlu'}
									<div class="badge badge-outline badge-sm badge-success">
										{m.smartlists_source_stevenLu()}
									</div>
								{:else}
									<div class="badge badge-outline badge-sm badge-secondary">
										{m.smartlists_source_externalBadge()}
									</div>
								{/if}
							{:else if list.listSourceType === 'trakt-list'}
								<div class="badge badge-outline badge-sm badge-accent">
									{m.smartlists_source_trakt()}
								</div>
							{:else if list.listSourceType === 'custom-manual'}
								<div class="badge badge-outline badge-sm badge-warning">{m.common_custom()}</div>
							{:else if list.listSourceType === 'tmdb-discover'}
								<div class="badge badge-outline badge-sm badge-primary">
									{m.smartlists_source_tmdbDiscover()}
								</div>
							{/if}
						</div>

						<div class="divider my-2"></div>

						<div class="flex items-center justify-between text-sm text-base-content/60">
							<div class="flex items-center gap-1">
								{#if list.lastRefreshStatus === 'success'}
									<CheckCircle class="h-4 w-4 text-success" />
								{:else if list.lastRefreshStatus === 'failed'}
									<AlertCircle class="h-4 w-4 text-error" />
								{:else}
									<Clock class="h-4 w-4" />
								{/if}
								<span class="truncate"
									>{m.smartlists_lastRefresh({ time: formatDate(list.lastRefreshTime) })}</span
								>
							</div>
						</div>

						<div class="mt-3 grid grid-cols-4 gap-2 sm:hidden">
							<a
								class="btn gap-1 btn-outline btn-sm"
								href={`/smartlists/${list.id}`}
								data-sveltekit-preload-data="hover"
								title={m.action_view()}
							>
								<ExternalLink class="h-4 w-4" />
								{m.action_view()}
							</a>
							<button
								class="btn gap-1 btn-outline btn-sm"
								onclick={() => refreshList(list.id)}
								disabled={refreshingIds.has(list.id)}
								title={m.action_refresh()}
							>
								<RefreshCw class="h-4 w-4 {refreshingIds.has(list.id) ? 'animate-spin' : ''}" />
							</button>
							<a
								class="btn gap-1 btn-outline btn-sm"
								href={`/smartlists/${list.id}/edit`}
								data-sveltekit-preload-data="hover"
								title={m.action_edit()}
							>
								<Edit class="h-4 w-4" />
								{m.action_edit()}
							</a>
							<button
								class="btn gap-1 btn-outline btn-error btn-sm"
								onclick={() => openDeleteModal(list)}
								disabled={deletingIds.has(list.id)}
								title={m.action_delete()}
							>
								<Trash2 class="h-4 w-4" />
							</button>
						</div>

						<div class="mt-2 card-actions hidden justify-end sm:flex">
							<a
								class="btn btn-ghost btn-sm"
								href={`/smartlists/${list.id}`}
								data-sveltekit-preload-data="hover"
								title={m.action_view()}
							>
								<ExternalLink class="h-4 w-4" />
							</a>
							<button
								class="btn btn-ghost btn-sm"
								onclick={() => refreshList(list.id)}
								disabled={refreshingIds.has(list.id)}
								title={m.action_refresh()}
							>
								<RefreshCw class="h-4 w-4 {refreshingIds.has(list.id) ? 'animate-spin' : ''}" />
							</button>
							<a
								class="btn btn-ghost btn-sm"
								href={`/smartlists/${list.id}/edit`}
								data-sveltekit-preload-data="hover"
								title={m.action_edit()}
							>
								<Edit class="h-4 w-4" />
							</a>
							<button
								class="btn btn-ghost btn-error btn-sm"
								onclick={() => openDeleteModal(list)}
								disabled={deletingIds.has(list.id)}
								title={m.action_delete()}
							>
								<Trash2 class="h-4 w-4" />
							</button>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<ConfirmationModal
	open={confirmDeleteOpen}
	title={m.smartlists_deleteTitle()}
	messagePrefix={m.smartlists_deleteMessagePrefix()}
	messageEmphasis={deleteTarget?.name ?? m.smartlists_deleteMessageFallback()}
	messageSuffix={m.smartlists_deleteMessageSuffix()}
	confirmLabel={m.action_delete()}
	confirmVariant="error"
	loading={deleteLoading}
	onConfirm={handleConfirmDelete}
	onCancel={() => {
		confirmDeleteOpen = false;
		deleteTarget = null;
	}}
/>
