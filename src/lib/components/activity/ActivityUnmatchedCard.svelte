<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import { Loader2, RefreshCw, Search, Download, Link2, Unlink } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { getUnmatched, trackUnmatched, type UnmatchedDownloadItem } from '#lib/api/downloads.js';
	import { ApiError } from '#lib/api/client.js';
	import { formatBytes } from '#lib/utils/format.js';

	interface Props {
		downloadClients?: { id: string; name: string }[];
	}

	let { downloadClients = [] }: Props = $props();

	const PAGE_LIMIT = 25;

	let items = $state<UnmatchedDownloadItem[]>([]);
	let total = $state(0);
	let page = $state(1);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let clientId = $state('');
	let search = $state('');
	let selected = new SvelteSet<string>();

	const filtered = $derived(
		search.trim()
			? items.filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase()))
			: items
	);

	const selectableHashes = $derived(filtered.map((item) => item.hash));
	const allSelected = $derived(
		selectableHashes.length > 0 && selectableHashes.every((h) => selected.has(h))
	);
	const totalPages = $derived(Math.max(1, Math.ceil(total / PAGE_LIMIT)));

	function statusBadge(status: string): string {
		switch (status) {
			case 'downloading':
				return 'badge-info';
			case 'seeding':
			case 'completed':
				return 'badge-success';
			case 'paused':
			case 'stalled':
				return 'badge-warning';
			case 'error':
				return 'badge-error';
			default:
				return 'badge-ghost';
		}
	}

	function statusProgress(status: string): string {
		switch (status) {
			case 'downloading':
				return 'progress-info';
			case 'seeding':
			case 'completed':
				return 'progress-success';
			case 'paused':
			case 'stalled':
				return 'progress-warning';
			case 'error':
				return 'progress-error';
			default:
				return '';
		}
	}

	function statusLabel(status: string): string {
		switch (status) {
			case 'downloading':
				return m.status_downloading();
			case 'seeding':
				return m.status_seeding();
			case 'paused':
				return m.status_paused();
			case 'completed':
				return m.status_completed();
			case 'stalled':
				return m.status_stalled();
			case 'queued':
				return m.status_queued();
			case 'error':
				return m.status_failed();
			default:
				return status;
		}
	}

	async function load(resetPage = false) {
		if (resetPage) page = 1;
		loading = true;
		loadError = null;
		try {
			const res = await getUnmatched({
				clientId: clientId || undefined,
				page,
				limit: PAGE_LIMIT
			});
			items = res.items;
			total = res.total;
			page = res.page;
			// Drop selections for rows that are gone — imported rows leave
			// the pane by definition (they become tracked queue rows).
			const live = new Set(items.map((item) => item.hash));
			for (const hash of [...selected]) {
				if (!live.has(hash)) selected.delete(hash);
			}
		} catch (error) {
			loadError =
				error instanceof ApiError
					? error.message
					: error instanceof Error
						? error.message
						: m.activity_unmatched_loadFailed();
		} finally {
			loading = false;
		}
	}

	function toggleSelect(hash: string) {
		if (selected.has(hash)) selected.delete(hash);
		else selected.add(hash);
	}

	function toggleSelectAll() {
		if (allSelected) {
			for (const hash of selectableHashes) selected.delete(hash);
		} else {
			for (const hash of selectableHashes) selected.add(hash);
		}
	}

	function openWizardFor(item: UnmatchedDownloadItem) {
		openWizardEntries([{ clientId: item.clientId, hash: item.hash }]);
	}

	function openWizardSelected() {
		openWizardEntries(
			filtered
				.filter((item) => selected.has(item.hash))
				.map((item) => ({ clientId: item.clientId, hash: item.hash }))
		);
	}

	function openWizardEntries(entries: { clientId: string; hash: string }[]) {
		if (entries.length === 0) return;
		const value = encodeURIComponent(entries.map((e) => `${e.clientId}:${e.hash}`).join(','));
		void goto(`/library/import?unmatched=${value}`);
	}

	const selectedAttachable = $derived(
		filtered.filter((item) => selected.has(item.hash) && item.attachable && item.progress >= 1)
	);

	let attaching = $state(false);

	async function attachItems(itemsToAttach: UnmatchedDownloadItem[]) {
		const pairs = itemsToAttach
			.filter((item) => item.attachable)
			.map((item) => ({
				hash: item.hash,
				mediaType: (item.attachable as NonNullable<UnmatchedDownloadItem['attachable']>).mediaType,
				tmdbId: (item.attachable as NonNullable<UnmatchedDownloadItem['attachable']>).tmdbId
			}));
		if (pairs.length === 0 || attaching) return;
		attaching = true;
		try {
			const result = await trackUnmatched(pairs);
			toasts.success(m.activity_unmatched_attachedToast({ count: result.tracked }));
			for (const item of itemsToAttach) selected.delete(item.hash);
			await load(true);
		} catch (error) {
			toasts.error(
				error instanceof ApiError
					? error.message
					: error instanceof Error
						? error.message
						: m.activity_unmatched_attachFailed()
			);
		} finally {
			attaching = false;
		}
	}

	onMount(() => {
		void load(true);
	});
</script>

<div class="space-y-4">
	<div class="rounded-lg border border-base-content/12 bg-base-100 p-4 shadow-sm">
		<div class="flex flex-wrap items-center gap-2">
			<div class="form-control min-w-50 flex-1 sm:max-w-64">
				<div class="group relative">
					<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
						<Search
							class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
						/>
					</div>
					<input
						type="text"
						placeholder={m.activity_unmatched_searchPlaceholder()}
						class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
						bind:value={search}
					/>
				</div>
			</div>
			{#if downloadClients.length > 0}
				<select
					class="select w-38 border-base-content/20 bg-base-200 select-sm sm:w-auto"
					bind:value={clientId}
					onchange={() => load(true)}
					aria-label={m.activity_unmatched_clientFilter()}
				>
					<option value="">{m.activity_unmatched_allClients()}</option>
					{#each downloadClients as client (client.id)}
						<option value={client.id}>{client.name}</option>
					{/each}
				</select>
			{/if}
			<button
				class="btn ml-auto gap-1.5 btn-outline btn-sm"
				onclick={() => load()}
				disabled={loading}
			>
				{#if loading}
					<Loader2 class="h-3.5 w-3.5 animate-spin" />
				{:else}
					<RefreshCw class="h-3.5 w-3.5" />
				{/if}
				{m.activity_unmatched_refresh()}
			</button>
		</div>
	</div>

	{#if loadError}
		<div class="alert alert-error">
			<span>{loadError}</span>
		</div>
	{:else if loading && items.length === 0}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="h-8 w-8 animate-spin" />
		</div>
	{:else if filtered.length === 0}
		<div class="py-12 text-center text-base-content/60">
			<Unlink class="mx-auto mb-4 h-12 w-12 opacity-40" />
			<p class="text-lg font-medium">
				{items.length === 0 ? m.activity_unmatched_empty() : m.activity_unmatched_noFilterResults()}
			</p>
		</div>
	{:else}
		<div class="flex items-center gap-4 text-sm text-base-content/70">
			<span>{m.activity_unmatched_count({ count: total })}</span>
			{#if selected.size > 0}
				<div class="ml-auto flex flex-wrap items-center gap-2">
					<span class="text-xs text-base-content/60">
						{m.common_selected({ count: selected.size })}
					</span>
					{#if selectedAttachable.length > 0}
						<button
							class="btn gap-1.5 btn-outline btn-sm"
							disabled={attaching}
							onclick={() => attachItems(selectedAttachable)}
						>
							<Link2 class="h-3.5 w-3.5" />
							{m.activity_unmatched_attachSelected({ count: selectedAttachable.length })}
						</button>
					{/if}
					<button
						class="btn gap-1.5 btn-primary btn-sm"
						disabled={selected.size === 0}
						onclick={openWizardSelected}
					>
						<Download class="h-3.5 w-3.5" />
						{m.activity_unmatched_importSelected({ count: selected.size })}
					</button>
				</div>
			{/if}
		</div>

		<div class="overflow-x-auto rounded-lg border border-base-content/12 bg-base-100 shadow-sm">
			<table class="table w-full table-sm">
				<thead>
					<tr
						class="border-b border-base-content/10 bg-base-200 text-[11px] font-semibold tracking-widest text-base-content/50 uppercase"
					>
						<th class="w-10 px-2">
							<input
								type="checkbox"
								class="checkbox checkbox-xs checkbox-primary"
								checked={allSelected}
								onchange={toggleSelectAll}
								aria-label={m.activity_unmatched_selectAll()}
							/>
						</th>
						<th>{m.activity_unmatched_colName()}</th>
						<th class="hidden sm:table-cell">{m.activity_unmatched_colSize()}</th>
						<th class="hidden sm:table-cell">{m.activity_unmatched_colClient()}</th>
						<th><span class="sr-only">{m.activity_unmatched_openImport()}</span></th>
					</tr>
				</thead>
				<tbody class="divide-y divide-base-content/8">
					{#each filtered as item (item.hash)}
						<tr
							class="transition-colors {selected.has(item.hash)
								? 'bg-primary/5'
								: 'hover:bg-base-200/50'}"
						>
							<td class="w-10 px-2">
								<input
									type="checkbox"
									class="checkbox checkbox-xs checkbox-primary"
									checked={selected.has(item.hash)}
									onchange={() => toggleSelect(item.hash)}
									aria-label={item.name}
								/>
							</td>
							<td>
								<div class="max-w-xs truncate font-medium" title={item.name}>{item.name}</div>
								<div class="mt-1 flex flex-wrap items-center gap-2">
									<span
										class="font-mono text-xs text-base-content/50"
										title={m.activity_unmatched_hashTitle()}>{item.hash.slice(0, 12)}…</span
									>
									<span class="badge badge-sm {statusBadge(item.status)}"
										>{statusLabel(item.status)}</span
									>
									<progress
										class="progress w-16 {statusProgress(item.status)}"
										value={item.progress * 100}
										max="100"
									></progress>
									<span class="text-xs text-base-content/60"
										>{Math.round(item.progress * 100)}%</span
									>
								</div>
							</td>
							<td class="hidden text-sm whitespace-nowrap sm:table-cell">
								{formatBytes(item.size)}
							</td>
							<td class="hidden text-sm whitespace-nowrap sm:table-cell">{item.clientName}</td>
							<td>
								<div class="flex items-center gap-1">
									{#if item.attachable && item.progress >= 1}
										<button
											class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
											onclick={() => attachItems([item])}
											disabled={attaching}
											aria-label={m.activity_unmatched_attach()}
											title={m.activity_unmatched_attachTitle({
												title: item.attachable.title
											})}
										>
											<Link2 class="h-3 w-3" />
											{m.activity_unmatched_attach()}
										</button>
									{/if}
									<button
										class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
										onclick={() => openWizardFor(item)}
										aria-label={m.activity_unmatched_openImport()}
										title={m.activity_unmatched_openImport()}
									>
										<Download class="h-3 w-3" />
										{m.activity_unmatched_openImport()}
									</button>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
				{#if totalPages > 1}
					<tfoot>
						<tr>
							<td colspan={5} class="border-t border-base-content/8 py-2">
								<div class="flex items-center justify-center gap-2">
									<button
										class="btn btn-ghost btn-xs"
										disabled={page <= 1 || loading}
										onclick={() => {
											page -= 1;
											void load();
										}}
									>
										{m.reports_pagination_prev()}
									</button>
									<span class="text-xs text-base-content/60">{page} / {totalPages}</span>
									<button
										class="btn btn-ghost btn-xs"
										disabled={page >= totalPages || loading}
										onclick={() => {
											page += 1;
											void load();
										}}
									>
										{m.reports_pagination_next()}
									</button>
								</div>
							</td>
						</tr>
					</tfoot>
				{/if}
			</table>
		</div>
	{/if}
</div>
