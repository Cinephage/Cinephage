<script lang="ts">
	import { Search, Ban, Clock, Trash2 } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import { BlocklistTable, BlocklistBulkActions } from '#lib/components/blocklist/index.js';
	import type { BlocklistEntry } from '#lib/components/blocklist/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import {
		getBlocklist,
		deleteBlocklistEntries,
		purgeBlocklistExpired,
		updateBlocklistExpiry
	} from '#lib/api/settings.js';

	let { data }: { data: { entries: BlocklistEntry[]; total: number } } = $props();

	let entries = $state<BlocklistEntry[]>([]);
	let total = $state(0);

	$effect(() => {
		const snap = $state.snapshot(data);
		entries = snap.entries;
		total = snap.total;
	});
	let selectedIds = new SvelteSet<string>();
	let bulkLoading = $state(false);

	let confirmDeleteOpen = $state(false);
	let deleteTarget = $state<BlocklistEntry | null>(null);
	let confirmBulkDeleteOpen = $state(false);
	let confirmPurgeExpiredOpen = $state(false);
	let confirmRemoveAllOpen = $state(false);

	interface BlocklistFilters {
		reason: string;
		protocol: string;
		activeOnly: boolean;
		search: string;
	}

	interface BlocklistSortState {
		column: 'title' | 'reason' | 'createdAt' | 'expiresAt';
		direction: 'asc' | 'desc';
	}

	let filters = $state<BlocklistFilters>({
		reason: '',
		protocol: '',
		activeOnly: false,
		search: ''
	});

	let sort = $state<BlocklistSortState>({
		column: 'createdAt',
		direction: 'desc'
	});

	async function fetchEntries() {
		try {
			const result = await getBlocklist({
				reason: filters.reason || undefined,
				protocol: filters.protocol || undefined,
				activeOnly: filters.activeOnly || undefined
			});
			entries = result.entries;
			total = result.total;
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		}
	}

	const filteredEntries = $derived.by(() => {
		let result = [...entries];
		const query = filters.search.trim().toLowerCase();
		if (query) {
			result = result.filter(
				(e) =>
					e.title.toLowerCase().includes(query) || (e.message ?? '').toLowerCase().includes(query)
			);
		}
		const direction = sort.direction === 'asc' ? 1 : -1;
		result.sort((a, b) => {
			switch (sort.column) {
				case 'title':
					return direction * a.title.localeCompare(b.title);
				case 'reason':
					return direction * a.reason.localeCompare(b.reason);
				case 'createdAt':
					return direction * (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
				case 'expiresAt':
					return direction * (a.expiresAt ?? '').localeCompare(b.expiresAt ?? '');
				default:
					return 0;
			}
		});
		return result;
	});

	function handleSort(column: typeof sort.column) {
		if (sort.column === column) {
			sort.direction = sort.direction === 'asc' ? 'desc' : 'asc';
		} else {
			sort.column = column;
			sort.direction = 'asc';
		}
	}

	function handleSelect(id: string, selected: boolean) {
		if (selected) selectedIds.add(id);
		else selectedIds.delete(id);
	}

	function handleSelectAll(selected: boolean) {
		selectedIds.clear();
		if (selected) {
			for (const e of filteredEntries) selectedIds.add(e.id);
		}
	}

	function handleDelete(entry: BlocklistEntry) {
		deleteTarget = entry;
		confirmDeleteOpen = true;
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		try {
			await deleteBlocklistEntries([deleteTarget.id]);
			toasts.success(m.blocklist_entryRemoved());
			await fetchEntries();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			confirmDeleteOpen = false;
			deleteTarget = null;
			selectedIds.clear();
		}
	}

	async function confirmBulkDelete() {
		try {
			bulkLoading = true;
			const ids = Array.from(selectedIds);
			await deleteBlocklistEntries(ids);
			toasts.success(m.blocklist_entriesRemoved({ count: ids.length }));
			selectedIds.clear();
			await fetchEntries();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			confirmBulkDeleteOpen = false;
			bulkLoading = false;
		}
	}

	async function confirmPurgeExpired() {
		try {
			bulkLoading = true;
			await purgeBlocklistExpired();
			toasts.success(m.blocklist_expiredPurged());
			await fetchEntries();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			confirmPurgeExpiredOpen = false;
			bulkLoading = false;
		}
	}

	async function handleUpdateExpiry(id: string, expiresInHours: number | null) {
		try {
			await updateBlocklistExpiry({ id, expiresInHours });
			toasts.success(m.blocklist_expiryUpdated());
			await fetchEntries();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		}
	}

	async function confirmRemoveAll() {
		try {
			bulkLoading = true;
			await deleteBlocklistEntries(entries.map((e) => e.id));
			toasts.success(m.blocklist_entriesRemoved({ count: entries.length }));
			selectedIds.clear();
			await fetchEntries();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			confirmRemoveAllOpen = false;
			bulkLoading = false;
		}
	}

	const bulkDeleteMessage = $derived(m.blocklist_bulkDeleteMessage({ count: selectedIds.size }));
</script>

<svelte:head>
	<title>{m.nav_blockedReleases()}</title>
</svelte:head>

<SettingsPage title={m.blocklist_pageTitle()} subtitle={m.blocklist_pageSubtitle()}>
	{#snippet actions()}
		<button class="btn gap-1 btn-ghost btn-sm" onclick={() => (confirmPurgeExpiredOpen = true)}>
			<Clock class="h-4 w-4" />
			{m.blocklist_purgeExpired()}
		</button>
		{#if entries.length > 0}
			<button
				class="btn gap-1 btn-ghost btn-error btn-sm"
				onclick={() => (confirmRemoveAllOpen = true)}
			>
				<Trash2 class="h-4 w-4" />
				Remove all
			</button>
		{/if}
	{/snippet}

	<div class="mb-4 flex flex-wrap items-center gap-2">
		<div class="form-control relative w-full sm:w-56">
			<Search
				class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/40"
			/>
			<input
				type="text"
				placeholder={m.blocklist_searchPlaceholder()}
				class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-4 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
				bind:value={filters.search}
			/>
		</div>

		<div class="w-full sm:w-48">
			<select class="select-bordered select w-full select-sm" bind:value={filters.reason}>
				<option value="">{m.blocklist_filterAllReasons()}</option>
				<option value="download_failed">{m.blocklist_reason_downloadFailed()}</option>
				<option value="import_failed">{m.blocklist_reason_importFailed()}</option>
				<option value="quality_mismatch">{m.blocklist_reason_qualityMismatch()}</option>
				<option value="manual">{m.blocklist_reason_manual()}</option>
				<option value="duplicate">{m.blocklist_reason_duplicate()}</option>
				<option value="bad_release">{m.blocklist_reason_badRelease()}</option>
			</select>
		</div>

		<div class="w-full sm:w-48">
			<select class="select-bordered select w-full select-sm" bind:value={filters.protocol}>
				<option value="">{m.blocklist_filterAllProtocols()}</option>
				<option value="torrent">{m.common_torrent()}</option>
				<option value="usenet">{m.common_usenet()}</option>
				<option value="streaming">{m.common_live()}</option>
			</select>
		</div>

		<label class="label cursor-pointer gap-2">
			<input
				type="checkbox"
				class="checkbox checkbox-xs checkbox-primary"
				bind:checked={filters.activeOnly}
			/>
			<span class="label-text text-sm">{m.blocklist_filterActiveOnly()}</span>
		</label>

		<span class="text-sm text-base-content/60">
			{m.blocklist_entryCount({ total })}
		</span>
	</div>

	{#if selectedIds.size > 0}
		<BlocklistBulkActions
			selectedCount={selectedIds.size}
			loading={bulkLoading}
			onDelete={() => (confirmBulkDeleteOpen = true)}
			onPurgeExpired={() => (confirmPurgeExpiredOpen = true)}
		/>
	{/if}

	<div class="card border border-base-300 bg-base-200">
		<div class="card-body p-2 sm:p-4">
			{#if filteredEntries.length > 0}
				<BlocklistTable
					entries={filteredEntries}
					{selectedIds}
					onSelect={handleSelect}
					onSelectAll={handleSelectAll}
					{sort}
					onSort={handleSort}
					onDelete={handleDelete}
					onUpdateExpiry={handleUpdateExpiry}
				/>
			{:else}
				<div class="py-12 text-center text-base-content/50">
					<Ban class="mx-auto mb-4 h-12 w-12 opacity-40" />
					<p class="text-lg font-medium">{m.blocklist_emptyTitle()}</p>
					<p class="mt-1 text-sm">
						{m.blocklist_emptyDescription()}
					</p>
				</div>
			{/if}
		</div>
	</div>
</SettingsPage>

<ConfirmationModal
	open={confirmDeleteOpen}
	onCancel={() => (confirmDeleteOpen = false)}
	onConfirm={confirmDelete}
	title={m.blocklist_confirmRemoveTitle()}
	message={m.blocklist_confirmRemoveMessage()}
	confirmLabel={m.blocklist_confirmRemoveLabel()}
	confirmVariant="error"
/>

<ConfirmationModal
	open={confirmBulkDeleteOpen}
	onCancel={() => (confirmBulkDeleteOpen = false)}
	onConfirm={confirmBulkDelete}
	title={m.blocklist_confirmBulkDeleteTitle()}
	message={bulkDeleteMessage}
	confirmLabel={`${m.blocklist_confirmRemoveLabel()} ${selectedIds.size}`}
	confirmVariant="error"
/>

<ConfirmationModal
	open={confirmPurgeExpiredOpen}
	onCancel={() => (confirmPurgeExpiredOpen = false)}
	onConfirm={confirmPurgeExpired}
	title={m.blocklist_confirmPurgeTitle()}
	message={m.blocklist_confirmPurgeMessage()}
	confirmLabel={m.blocklist_confirmPurgeLabel()}
	confirmVariant="warning"
/>

<ConfirmationModal
	open={confirmRemoveAllOpen}
	onCancel={() => (confirmRemoveAllOpen = false)}
	onConfirm={confirmRemoveAll}
	title="Remove all blocked releases"
	message="Remove all {entries.length} blocked release{entries.length !== 1
		? 's'
		: ''}? They will be retried on the next search."
	confirmLabel="Remove all"
	confirmVariant="error"
/>
