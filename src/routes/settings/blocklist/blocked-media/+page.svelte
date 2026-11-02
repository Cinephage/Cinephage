<script lang="ts">
	import { Search, EyeOff, Film as FilmIcon, Trash2 } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { getBlockedMedia, unblockMedia } from '#lib/api/settings.js';
	import { formatDisplayDateShort } from '#lib/utils/format.js';

	interface BlockedEntry {
		id: string;
		tmdbId: number;
		mediaType: string;
		title: string;
		posterPath: string | null;
		year: number | null;
		reason: string | null;
		createdAt: string | null;
	}

	let entries = $state<BlockedEntry[]>([]);
	let total = $state(0);

	let selectedIds = new SvelteSet<string>();
	let confirmUnblockOpen = $state(false);
	let unblockTarget = $state<BlockedEntry | null>(null);
	let confirmBulkUnblockOpen = $state(false);
	let confirmUnblockAllOpen = $state(false);

	interface BlockedMediaFilters {
		mediaType: string;
		search: string;
	}

	let filters = $state<BlockedMediaFilters>({
		mediaType: '',
		search: ''
	});

	async function fetchEntries() {
		try {
			const result = await getBlockedMedia({
				search: filters.search || undefined,
				mediaType: filters.mediaType || undefined
			});
			entries = result.entries;
			total = result.total;
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : 'Failed to load blocked media');
		}
	}

	$effect(() => {
		fetchEntries();
	});

	function handleUnblock(entry: BlockedEntry) {
		unblockTarget = entry;
		confirmUnblockOpen = true;
	}

	async function confirmUnblock() {
		if (!unblockTarget) return;
		try {
			await unblockMedia([unblockTarget.id]);
			toasts.success(m.blockedMedia_unblocked({ title: unblockTarget.title }));
			await fetchEntries();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : 'Failed to unblock');
		} finally {
			confirmUnblockOpen = false;
			unblockTarget = null;
			selectedIds.clear();
		}
	}

	async function confirmBulkUnblock() {
		try {
			const ids = Array.from(selectedIds);
			await unblockMedia(ids);
			toasts.success(`${ids.length} items unblocked`);
			selectedIds.clear();
			await fetchEntries();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : 'Failed to unblock');
		} finally {
			confirmBulkUnblockOpen = false;
		}
	}

	function handleSelect(id: string, selected: boolean) {
		if (selected) selectedIds.add(id);
		else selectedIds.delete(id);
	}

	function handleSelectAll(selected: boolean) {
		selectedIds.clear();
		if (selected) {
			for (const e of entries) selectedIds.add(e.id);
		}
	}

	async function confirmUnblockAll() {
		try {
			const ids = entries.map((e) => e.id);
			await unblockMedia(ids);
			toasts.success(`${ids.length} items unblocked`);
			selectedIds.clear();
			await fetchEntries();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : 'Failed to unblock all');
		} finally {
			confirmUnblockAllOpen = false;
		}
	}

	const bulkUnblockMessage = $derived(
		`Unblock ${selectedIds.size} items? They will appear in discover and search again.`
	);
</script>

<svelte:head>
	<title>{m.nav_blockedMedia()}</title>
</svelte:head>

<SettingsPage title={m.blockedMedia_pageTitle()} subtitle={m.blockedMedia_pageSubtitle()}>
	<div class="mb-4 flex flex-wrap items-center gap-2">
		<div class="form-control relative w-full sm:w-56">
			<Search
				class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/40"
			/>
			<input
				type="text"
				placeholder={m.blockedMedia_searchPlaceholder()}
				class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-4 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
				bind:value={filters.search}
			/>
		</div>
		<div class="w-full sm:w-48">
			<select class="select-bordered select w-full select-sm" bind:value={filters.mediaType}>
				<option value="">{m.blockedMedia_filterAll()}</option>
				<option value="movie">{m.blockedMedia_filterMovies()}</option>
				<option value="tv">{m.blockedMedia_filterTV()}</option>
			</select>
		</div>
		<span class="text-sm text-base-content/60">
			{m.blockedMedia_entryCount({ total })}
		</span>
		{#if selectedIds.size > 0}
			<span class="text-sm text-base-content/60">{selectedIds.size} selected</span>
			<button class="btn gap-1.5 btn-error btn-sm" onclick={() => (confirmBulkUnblockOpen = true)}>
				<Trash2 class="h-3.5 w-3.5" />
				{m.blockedMedia_unblock()}
			</button>
		{/if}
		{#if entries.length > 0}
			<button
				class="btn gap-1.5 btn-ghost btn-error btn-sm sm:ml-auto"
				onclick={() => (confirmUnblockAllOpen = true)}
			>
				<Trash2 class="h-3.5 w-3.5" /> Remove all
			</button>
		{/if}
	</div>

	<div class="card border border-base-300 bg-base-200">
		<div class="card-body p-2 sm:p-4">
			{#if entries.length > 0}
				<div class="overflow-x-auto">
					<table class="table table-sm">
						<thead>
							<tr>
								<th class="w-10">
									<input
										type="checkbox"
										class="checkbox checkbox-xs checkbox-primary"
										checked={entries.length > 0 && entries.every((e) => selectedIds.has(e.id))}
										onchange={(e) => handleSelectAll((e.target as HTMLInputElement).checked)}
									/>
								</th>
								<th>Title</th>
								<th>Type</th>
								<th>Year</th>
								<th>Date Blocked</th>
								<th class="text-right">Actions</th>
							</tr>
						</thead>
						<tbody>
							{#each entries as entry (entry.id)}
								<tr class={selectedIds.has(entry.id) ? 'bg-primary/10' : ''}>
									<td>
										<input
											type="checkbox"
											class="checkbox checkbox-xs checkbox-primary"
											checked={selectedIds.has(entry.id)}
											onchange={(e) =>
												handleSelect(entry.id, (e.target as HTMLInputElement).checked)}
										/>
									</td>
									<td>
										<div class="flex items-center gap-3">
											{#if entry.posterPath}
												<TmdbImage
													path={entry.posterPath}
													alt={entry.title}
													size="w92"
													class="h-12 w-8 rounded object-cover"
												/>
											{:else}
												<div class="flex h-12 w-8 items-center justify-center rounded bg-base-200">
													<FilmIcon class="h-4 w-4 text-base-content/30" />
												</div>
											{/if}
											<div>
												<div class="font-medium">{entry.title}</div>
												{#if entry.reason}
													<div class="text-xs text-base-content/50">{entry.reason}</div>
												{/if}
											</div>
										</div>
									</td>
									<td>
										<span
											class="badge badge-sm {entry.mediaType === 'movie'
												? 'badge-primary'
												: 'badge-secondary'}"
										>
											{entry.mediaType === 'movie'
												? m.blockedMedia_mediaTypeMovie()
												: m.blockedMedia_mediaTypeTV()}
										</span>
									</td>
									<td>{entry.year ?? ''}</td>
									<td class="text-sm text-base-content/60"
										>{formatDisplayDateShort(entry.createdAt)}</td
									>
									<td class="text-right">
										<button class="btn btn-ghost btn-xs" onclick={() => handleUnblock(entry)}>
											{m.blockedMedia_unblock()}
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<div class="py-12 text-center text-base-content/50">
					<EyeOff class="mx-auto mb-4 h-12 w-12 opacity-40" />
					<p class="text-lg font-medium">{m.blockedMedia_emptyTitle()}</p>
					<p class="mt-1 text-sm">{m.blockedMedia_emptyDescription()}</p>
				</div>
			{/if}
		</div>
	</div>
</SettingsPage>

<ConfirmationModal
	open={confirmUnblockOpen}
	onCancel={() => (confirmUnblockOpen = false)}
	onConfirm={confirmUnblock}
	title={m.blockedMedia_confirmUnblockTitle()}
	message={unblockTarget
		? m.blockedMedia_confirmUnblockMessage({ title: unblockTarget.title })
		: ''}
	confirmLabel={m.blockedMedia_confirmUnblockLabel()}
	confirmVariant="warning"
/>

<ConfirmationModal
	open={confirmBulkUnblockOpen}
	onCancel={() => (confirmBulkUnblockOpen = false)}
	onConfirm={confirmBulkUnblock}
	title={m.blockedMedia_confirmUnblockTitle()}
	message={bulkUnblockMessage}
	confirmLabel={`${m.blockedMedia_confirmUnblockLabel()} ${selectedIds.size}`}
	confirmVariant="warning"
/>

<ConfirmationModal
	open={confirmUnblockAllOpen}
	onCancel={() => (confirmUnblockAllOpen = false)}
	onConfirm={confirmUnblockAll}
	title="Remove all blocked media"
	message="Unblock all {entries.length} items? They will appear in discover and search again."
	confirmLabel="Remove all"
	confirmVariant="error"
/>
