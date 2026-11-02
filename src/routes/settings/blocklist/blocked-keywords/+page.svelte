<script lang="ts">
	import { Loader2, Plus, X, Sparkles, Search, Trash2 } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { getSmartListHelpers } from '#lib/api/smartlists.js';
	import {
		getBlockedKeywords,
		addBlockedKeyword,
		removeBlockedKeyword,
		seedBlockedKeywords
	} from '#lib/api/settings.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { formatDisplayDate } from '#lib/utils/format.js';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import * as m from '#lib/paraglide/messages.js';

	interface KeywordResult {
		id: number;
		name: string;
	}

	interface BlockedKeyword {
		id: number;
		keywordId: number;
		name: string;
		createdAt: string;
	}

	let blockedKeywords = $state<BlockedKeyword[]>([]);
	let loading = $state(true);

	let query = $state('');
	let searchResults = $state<KeywordResult[]>([]);
	let searching = $state(false);
	let searchTimer: ReturnType<typeof setTimeout>;

	let selectedIds = new SvelteSet<number>();
	let confirmRemoveAllOpen = $state(false);
	let confirmBulkRemoveOpen = $state(false);

	const blockedKeywordIds = $derived(new Set(blockedKeywords.map((k) => k.keywordId)));

	async function loadBlockedKeywords() {
		loading = true;
		try {
			blockedKeywords = await getBlockedKeywords();
		} finally {
			loading = false;
		}
	}

	async function searchKeywords() {
		if (query.length < 2) {
			searchResults = [];
			return;
		}
		searching = true;
		try {
			const res = await getSmartListHelpers({ helper: 'keywords', q: query });
			searchResults = Array.isArray(res) ? res : [];
		} finally {
			searching = false;
		}
	}

	function handleInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(searchKeywords, 300);
	}

	async function addKeyword(keyword: KeywordResult) {
		try {
			await addBlockedKeyword(keyword.id);
			query = '';
			searchResults = [];
			await loadBlockedKeywords();
			toasts.success(`Added "${keyword.name}" to blocked keywords`);
		} catch {
			toasts.error('Failed to add keyword');
		}
	}

	async function removeKeywordByKeywordId(keywordId: number) {
		const kw = blockedKeywords.find((k) => k.keywordId === keywordId);
		if (!kw) return;
		try {
			await removeBlockedKeyword(kw.id);
			query = '';
			searchResults = [];
			await loadBlockedKeywords();
			toasts.success(`Removed "${kw.name}" from blocked keywords`);
		} catch {
			toasts.error('Failed to remove keyword');
		}
	}

	async function removeKeyword(id: number) {
		try {
			await removeBlockedKeyword(id);
			selectedIds.delete(id);
			await loadBlockedKeywords();
			toasts.success('Keyword removed');
		} catch {
			toasts.error('Failed to remove keyword');
		}
	}

	async function confirmBulkRemove() {
		const ids = Array.from(selectedIds);
		try {
			await Promise.all(ids.map((id) => removeBlockedKeyword(id)));
			selectedIds.clear();
			await loadBlockedKeywords();
			toasts.success(`${ids.length} keyword${ids.length !== 1 ? 's' : ''} removed`);
		} catch {
			toasts.error('Failed to remove keywords');
		} finally {
			confirmBulkRemoveOpen = false;
		}
	}

	async function confirmRemoveAll() {
		try {
			await Promise.all(blockedKeywords.map((kw) => removeBlockedKeyword(kw.id)));
			selectedIds.clear();
			await loadBlockedKeywords();
			toasts.success('All blocked keywords removed');
		} catch {
			toasts.error('Failed to remove all keywords');
		} finally {
			confirmRemoveAllOpen = false;
		}
	}

	function handleSelectAll(selected: boolean) {
		selectedIds.clear();
		if (selected) {
			for (const kw of blockedKeywords) selectedIds.add(kw.id);
		}
	}

	let seeding = $state(false);

	async function handleSeedDefaults() {
		seeding = true;
		try {
			const result = await seedBlockedKeywords();
			if (result.added > 0) {
				toasts.success(`Added ${result.added} default NSFW keywords`);
				await loadBlockedKeywords();
			} else {
				toasts.success('All default keywords are already added');
			}
		} catch {
			toasts.error('Failed to seed default keywords');
		} finally {
			seeding = false;
		}
	}

	$effect(() => {
		loadBlockedKeywords();
	});
</script>

<svelte:head>
	<title>{m.nav_blockedKeywords()}</title>
</svelte:head>

<SettingsPage
	title="Blocked Keywords"
	subtitle="Content matching these TMDB keywords will be hidden from discover and smartlist results."
>
	{#snippet actions()}
		<button class="btn gap-2 btn-outline btn-sm" onclick={handleSeedDefaults} disabled={seeding}>
			{#if seeding}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<Sparkles class="h-4 w-4" />
			{/if}
			Add default NSFW keywords
		</button>
	{/snippet}

	<!-- Search / Add -->
	<div class="card border border-base-300 bg-base-200">
		<div class="card-body">
			<h2 class="card-title text-base">Add Keyword</h2>
			<div class="relative">
				<Search
					class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/40"
				/>
				{#if searching}
					<Loader2
						class="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin text-base-content/40"
					/>
				{/if}
				<input
					type="text"
					bind:value={query}
					oninput={handleInput}
					placeholder="Search TMDB keywords..."
					class="input w-full rounded-full border-base-content/20 bg-base-100 pr-9 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200/60 focus:border-primary/50 focus:bg-base-200/60 focus:ring-1 focus:ring-primary/20 focus:outline-none"
				/>
			</div>
			{#if searchResults.length > 0}
				<div class="mt-1 max-h-48 overflow-y-auto rounded-lg border border-base-300 bg-base-100">
					{#each searchResults as keyword (keyword.id)}
						{@const alreadyBlocked = blockedKeywordIds.has(keyword.id)}
						<div
							class="flex items-center justify-between border-b border-base-200 p-2 last:border-0"
						>
							<span class="text-sm">{keyword.name}</span>
							{#if alreadyBlocked}
								<button
									type="button"
									class="btn gap-1 btn-outline btn-error btn-xs"
									onclick={() => removeKeywordByKeywordId(keyword.id)}
								>
									<X class="h-3 w-3" /> Remove
								</button>
							{:else}
								<button
									type="button"
									class="btn gap-1 btn-primary btn-xs"
									onclick={() => addKeyword(keyword)}
								>
									<Plus class="h-3 w-3" /> Add
								</button>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<!-- Blocked list -->
	<div class="card border border-base-300 bg-base-200">
		<div class="card-body">
			<div class="flex items-center justify-between gap-2">
				<h2 class="card-title text-base">
					Blocked Keywords ({blockedKeywords.length})
				</h2>
				{#if blockedKeywords.length > 0}
					<div class="flex items-center gap-2">
						{#if selectedIds.size > 0}
							<span class="text-sm text-base-content/60">{selectedIds.size} selected</span>
							<button
								class="btn gap-1.5 btn-error btn-sm"
								onclick={() => (confirmBulkRemoveOpen = true)}
							>
								<Trash2 class="h-3.5 w-3.5" /> Remove selected
							</button>
						{/if}
						<button
							class="btn gap-1.5 btn-ghost btn-error btn-sm"
							onclick={() => (confirmRemoveAllOpen = true)}
						>
							<Trash2 class="h-3.5 w-3.5" /> Remove all
						</button>
					</div>
				{/if}
			</div>

			{#if loading}
				<div class="flex justify-center py-8">
					<Loader2 class="h-6 w-6 animate-spin" />
				</div>
			{:else if blockedKeywords.length === 0}
				<div class="py-8 text-center text-base-content/50">
					No blocked keywords yet. Search above to add one.
				</div>
			{:else}
				<div class="overflow-x-auto">
					<table class="table table-sm">
						<thead>
							<tr>
								<th class="w-10">
									<input
										type="checkbox"
										class="checkbox checkbox-xs checkbox-primary"
										checked={blockedKeywords.length > 0 &&
											blockedKeywords.every((k) => selectedIds.has(k.id))}
										onchange={(e) => handleSelectAll((e.target as HTMLInputElement).checked)}
									/>
								</th>
								<th>Keyword</th>
								<th>TMDB ID</th>
								<th>Added</th>
								<th></th>
							</tr>
						</thead>
						<tbody>
							{#each blockedKeywords as kw (kw.id)}
								<tr class={selectedIds.has(kw.id) ? 'bg-primary/10' : ''}>
									<td>
										<input
											type="checkbox"
											class="checkbox checkbox-xs checkbox-primary"
											checked={selectedIds.has(kw.id)}
											onchange={(e) => {
												if ((e.target as HTMLInputElement).checked) selectedIds.add(kw.id);
												else selectedIds.delete(kw.id);
											}}
										/>
									</td>
									<td class="font-medium">{kw.name}</td>
									<td class="text-base-content/50">{kw.keywordId}</td>
									<td class="text-base-content/50">{formatDisplayDate(kw.createdAt)}</td>
									<td>
										<button
											class="btn btn-ghost text-error btn-xs"
											onclick={() => removeKeyword(kw.id)}
										>
											<X class="h-3 w-3" /> Remove
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	</div>
</SettingsPage>

<ConfirmationModal
	open={confirmBulkRemoveOpen}
	title="Remove selected keywords"
	message="Remove {selectedIds.size} keyword{selectedIds.size !== 1
		? 's'
		: ''} from the blocklist? Content matching only these keywords will become visible again."
	confirmLabel="Remove"
	confirmVariant="error"
	onConfirm={confirmBulkRemove}
	onCancel={() => (confirmBulkRemoveOpen = false)}
/>

<ConfirmationModal
	open={confirmRemoveAllOpen}
	title="Remove all blocked keywords"
	message="Remove all {blockedKeywords.length} blocked keywords? All previously hidden content will become visible again."
	confirmLabel="Remove all"
	confirmVariant="error"
	onConfirm={confirmRemoveAll}
	onCancel={() => (confirmRemoveAllOpen = false)}
/>
