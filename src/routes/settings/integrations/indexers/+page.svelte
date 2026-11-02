<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { Plus, Download } from '@lucide/svelte';
	import type { PageData } from './$types';
	import type {
		Indexer,
		IndexerWithStatus,
		IndexerFilters as IIndexerFilters,
		IndexerSort,
		IndexerFormData
	} from '#lib/types/indexer.js';

	import IndexerTable from '#lib/components/indexers/IndexerTable.svelte';
	import IndexerFilters from '#lib/components/indexers/IndexerFilters.svelte';
	import IndexerBulkActions from '#lib/components/indexers/IndexerBulkActions.svelte';
	import IndexerModal from '#lib/components/indexers/IndexerModal.svelte';
	import ProwlarrImportModal from '#lib/components/indexers/ProwlarrImportModal.svelte';
	import JackettImportModal from '#lib/components/indexers/JackettImportModal.svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { getResponseErrorMessage } from '#lib/utils/http.js';
	import { SvelteSet } from 'svelte/reactivity';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import {
		createIndexer,
		updateIndexer,
		deleteIndexer,
		testIndexer,
		ApiError
	} from '#lib/api/index.js';

	let { data }: { data: PageData } = $props();

	// Indexer Modal state
	let modalOpen = $state(false);
	let modalMode = $state<'add' | 'edit'>('add');
	let editingIndexer = $state<Indexer | null>(null);
	let saving = $state(false);

	// Selection state
	let selectedIds = new SvelteSet<string>();
	let testingIds = new SvelteSet<string>();
	let togglingIds = new SvelteSet<string>();
	let bulkLoading = $state(false);

	// Filter state
	let filters = $state<IIndexerFilters>({
		protocol: 'all',
		status: 'all',
		search: ''
	});

	// Sort state
	let sort = $state<IndexerSort>({
		column: 'priority',
		direction: 'asc'
	});

	// Prowlarr import modal state
	let prowlarrImportOpen = $state(false);

	// Jackett import modal state
	let jackettImportOpen = $state(false);

	// Confirmation dialog state
	let confirmDeleteOpen = $state(false);
	let deleteTarget = $state<Indexer | null>(null);
	let confirmBulkDeleteOpen = $state(false);

	const isDeleteTargetProwlarr = $derived.by(() => {
		const prowlarrBase = data.prowlarrConnection?.url?.replace(/\/+$/, '');
		if (!prowlarrBase || !deleteTarget) return false;
		if (deleteTarget.definitionId !== 'prowlarr') return false;
		if ((deleteTarget.settings as Record<string, string> | null)?.aggregate === 'true') return true;
		if (!deleteTarget.baseUrl.startsWith(prowlarrBase + '/')) return false;
		const suffix = deleteTarget.baseUrl.slice(prowlarrBase.length + 1).replace(/\/+$/, '');
		return /^\d+$/.test(suffix);
	});

	const isDeleteTargetJackett = $derived.by(() => {
		const jackettBase = data.jackettConnection?.url?.replace(/\/+$/, '');
		if (!jackettBase || !deleteTarget) return false;
		const prefix = `${jackettBase}/api/v2.0/indexers/`;
		return (
			deleteTarget.baseUrl.startsWith(prefix) && deleteTarget.baseUrl.includes('/results/torznab')
		);
	});

	// Derived: filtered and sorted indexers
	const filteredIndexers = $derived(() => {
		let result = [...data.indexers] as IndexerWithStatus[];

		// Add definition names
		result = result.map((indexer) => ({
			...indexer,
			definitionName: data.definitions.find((d) => d.id === indexer.definitionId)?.name
		}));

		// Apply filters
		if (filters.protocol !== 'all') {
			result = result.filter((i) => i.protocol === filters.protocol);
		}
		if (filters.status === 'enabled') {
			result = result.filter((i) => i.enabled);
		} else if (filters.status === 'disabled') {
			result = result.filter((i) => !i.enabled);
		}
		if (filters.search) {
			const search = filters.search.toLowerCase();
			result = result.filter(
				(i) =>
					i.name.toLowerCase().includes(search) || i.definitionId.toLowerCase().includes(search)
			);
		}

		// Apply sort
		result.sort((a, b) => {
			let comparison = 0;
			switch (sort.column) {
				case 'name':
					comparison = a.name.localeCompare(b.name);
					break;
				case 'priority':
					comparison = a.priority - b.priority;
					break;
				case 'protocol':
					comparison = a.protocol.localeCompare(b.protocol);
					break;
				case 'enabled':
					comparison = (a.enabled ? 1 : 0) - (b.enabled ? 1 : 0);
					break;
			}
			return sort.direction === 'asc' ? comparison : -comparison;
		});

		return result;
	});

	const canReorder = $derived(
		filters.protocol === 'all' && filters.status === 'all' && filters.search.trim().length === 0
	);

	// Functions
	function openAddModal() {
		modalMode = 'add';
		editingIndexer = null;
		modalOpen = true;
	}

	function openEditModal(indexer: IndexerWithStatus) {
		modalMode = 'edit';
		editingIndexer = indexer;
		modalOpen = true;
	}

	function closeModal() {
		modalOpen = false;
		editingIndexer = null;
	}

	function handleSelect(id: string, selected: boolean) {
		if (selected) {
			selectedIds.add(id);
		} else {
			selectedIds.delete(id);
		}
	}

	function handleSelectAll(selected: boolean) {
		if (selected) {
			for (const indexer of filteredIndexers()) {
				selectedIds.add(indexer.id);
			}
		} else {
			selectedIds.clear();
		}
	}

	function handleSort(column: IndexerSort['column']) {
		if (sort.column === column) {
			sort = { column, direction: sort.direction === 'asc' ? 'desc' : 'asc' };
		} else {
			sort = { column, direction: 'asc' };
		}
	}

	function handleFilterChange(newFilters: IIndexerFilters) {
		filters = newFilters;
	}

	function handlePrioritySortForReorder() {
		sort = { column: 'priority', direction: 'asc' };
	}

	function confirmDelete(indexer: IndexerWithStatus) {
		deleteTarget = indexer;
		confirmDeleteOpen = true;
	}

	function buildIndexerPayload(formData: IndexerFormData) {
		return {
			name: formData.name,
			definitionId: formData.definitionId,
			baseUrl: formData.baseUrl,
			alternateUrls: formData.alternateUrls,
			enabled: formData.enabled,
			priority: formData.priority,
			protocol: formData.protocol,
			settings: formData.settings,
			enableAutomaticSearch: formData.enableAutomaticSearch,
			enableInteractiveSearch: formData.enableInteractiveSearch,
			minimumSeeders: formData.minimumSeeders,
			seedRatio: formData.seedRatio,
			seedTime: formData.seedTime,
			packSeedTime: formData.packSeedTime,
			rejectDeadTorrents: formData.rejectDeadTorrents,
			rejectPasswordProtected: formData.rejectPasswordProtected,
			minimumCompletionPercentage: formData.minimumCompletionPercentage,
			...(formData.additionalCategories !== undefined && {
				additionalCategories: formData.additionalCategories
			})
		};
	}

	async function updateIndexerById(
		id: string,
		payload: Record<string, unknown>,
		fallback: string
	): Promise<boolean> {
		try {
			await updateIndexer(id, payload);
			return true;
		} catch (e) {
			if (e instanceof ApiError) {
				throw new Error(getResponseErrorMessage(e.response, fallback), { cause: e });
			}
			throw e;
		}
	}

	async function handleTest(
		indexer: IndexerWithStatus,
		refresh: boolean = true,
		notify: boolean = true
	): Promise<boolean> {
		testingIds.add(indexer.id);
		try {
			const result = await testIndexer({
				indexerId: indexer.id,
				name: indexer.name,
				definitionId: indexer.definitionId,
				baseUrl: indexer.baseUrl,
				alternateUrls: indexer.alternateUrls,
				settings: indexer.settings
			});
			if (!result || !result.success) {
				if (notify) {
					toasts.error(getResponseErrorMessage(result, 'Connection test failed'));
				}
				return false;
			} else {
				if (notify) {
					toasts.success(m.settings_integrations_connectionSuccessful());
				}
				return true;
			}
		} catch (e) {
			if (notify) {
				toasts.error(
					e instanceof ApiError
						? getResponseErrorMessage(e.response, 'Connection test failed')
						: e instanceof Error
							? e.message
							: 'Connection test failed'
				);
			}
			return false;
		} finally {
			testingIds.delete(indexer.id);
			if (refresh) {
				await refreshAll();
			}
		}
	}

	async function handleModalTest(
		formData: IndexerFormData
	): Promise<{ success: boolean; error?: string }> {
		try {
			const result = await testIndexer({
				indexerId: modalMode === 'edit' ? editingIndexer?.id : undefined,
				name: formData.name,
				definitionId: formData.definitionId,
				baseUrl: formData.baseUrl,
				alternateUrls: formData.alternateUrls,
				settings: formData.settings
			});
			return { success: Boolean(result.success), error: result.error };
		} catch (e) {
			return {
				success: false,
				error:
					e instanceof ApiError
						? getResponseErrorMessage(e.response, 'Connection test failed')
						: e instanceof Error
							? e.message
							: 'Unknown error'
			};
		}
	}

	async function handleSave(formData: IndexerFormData) {
		saving = true;
		try {
			const payload = buildIndexerPayload(formData);
			if (modalMode === 'edit' && editingIndexer) {
				await updateIndexer(editingIndexer.id, payload);
			} else {
				await createIndexer(payload);
			}

			await refreshAll();
			closeModal();
			toasts.success(
				modalMode === 'edit'
					? m.settings_integrations_indexers_updated()
					: m.settings_integrations_indexers_created()
			);
		} catch (e) {
			toasts.error(
				e instanceof ApiError
					? getResponseErrorMessage(e.response, 'Failed to save indexer')
					: `Failed to save: ${e instanceof Error ? e.message : 'Unknown error'}`
			);
		} finally {
			saving = false;
		}
	}

	async function handleDelete() {
		if (!editingIndexer) return;

		try {
			await deleteIndexer(editingIndexer.id);
			await refreshAll();
			closeModal();
		} catch (e) {
			toasts.error(
				e instanceof ApiError
					? getResponseErrorMessage(e.response, 'Failed to delete indexer')
					: e instanceof Error
						? e.message
						: 'Failed to delete indexer'
			);
		}
	}

	async function handleConfirmDelete() {
		if (!deleteTarget) return;

		try {
			await deleteIndexer(deleteTarget.id);
			await refreshAll();
			confirmDeleteOpen = false;
			deleteTarget = null;
		} catch (e) {
			toasts.error(
				e instanceof ApiError
					? getResponseErrorMessage(e.response, 'Failed to delete indexer')
					: e instanceof Error
						? e.message
						: 'Failed to delete indexer'
			);
		}
	}

	async function handleBulkEnable() {
		bulkLoading = true;
		try {
			for (const id of selectedIds) {
				await updateIndexerById(id, { enabled: true }, 'Failed to enable indexer');
			}
			await refreshAll();
			selectedIds.clear();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to enable selected indexers');
		} finally {
			bulkLoading = false;
		}
	}

	async function handleBulkDisable() {
		bulkLoading = true;
		try {
			for (const id of selectedIds) {
				await updateIndexerById(id, { enabled: false }, 'Failed to disable indexer');
			}
			await refreshAll();
			selectedIds.clear();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to disable selected indexers');
		} finally {
			bulkLoading = false;
		}
	}

	async function handleBulkDelete() {
		if (selectedIds.size === 0) return;
		confirmBulkDeleteOpen = true;
	}

	async function handleConfirmBulkDelete() {
		if (selectedIds.size === 0) {
			confirmBulkDeleteOpen = false;
			return;
		}

		bulkLoading = true;
		try {
			for (const id of selectedIds) {
				await deleteIndexer(id);
			}
			await refreshAll();
			selectedIds.clear();
			confirmBulkDeleteOpen = false;
		} catch (e) {
			toasts.error(
				e instanceof ApiError
					? getResponseErrorMessage(e.response, 'Failed to delete selected indexers')
					: e instanceof Error
						? e.message
						: 'Failed to delete selected indexers'
			);
		} finally {
			bulkLoading = false;
		}
	}

	async function handleBulkTest() {
		if (selectedIds.size === 0) return;
		bulkLoading = true;
		try {
			const ids = [...selectedIds];
			let successCount = 0;
			let failCount = 0;
			for (const id of ids) {
				const indexer = data.indexers.find((i) => i.id === id);
				if (indexer) {
					const passed = await handleTest(indexer as IndexerWithStatus, false, false);
					if (passed) {
						successCount += 1;
					} else {
						failCount += 1;
					}
				}
			}
			await refreshAll();
			toasts.info(
				m.settings_integrations_bulkTestComplete({
					successCount: String(successCount),
					failCount: String(failCount)
				})
			);
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to run bulk test');
		} finally {
			bulkLoading = false;
		}
	}

	async function handleToggle(indexer: IndexerWithStatus) {
		if (togglingIds.has(indexer.id)) return;

		togglingIds.add(indexer.id);
		try {
			// Orphaned indexers: run a silent connection test first.
			// Pass and we clear orphaned + re-enable; fail and we keep it blocked.
			if (indexer.orphaned) {
				toasts.info('Testing connection before restoring...');
				const passed = await handleTest(indexer, false, false);
				if (!passed) {
					toasts.error('Connection test failed - indexer is still unavailable');
					return;
				}
				await updateIndexerById(
					indexer.id,
					{ enabled: true, orphaned: false },
					'Failed to restore indexer'
				);
				toasts.success('Connection restored - indexer re-enabled');
				await refreshAll();
				return;
			}

			await updateIndexerById(
				indexer.id,
				{ enabled: !indexer.enabled },
				'Failed to update indexer state'
			);
			await refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to update indexer state');
		} finally {
			togglingIds.delete(indexer.id);
		}
	}

	async function handleReorder(indexerIds: string[]) {
		try {
			await Promise.all(
				indexerIds.map((id, index) =>
					updateIndexerById(id, { priority: index + 1 }, 'Failed to reorder priorities')
				)
			);
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to reorder priorities');
		} finally {
			await refreshAll();
		}
	}
</script>

<svelte:head>
	<title>{m.nav_indexers()}</title>
</svelte:head>

<SettingsPage title={m.nav_indexers()} subtitle={m.settings_integrations_indexers_subtitle()}>
	{#snippet actions()}
		<button class="btn gap-2 btn-outline btn-sm" onclick={() => (jackettImportOpen = true)}>
			<Download class="h-4 w-4" />
			{data.jackettConnection ? 'Jackett' : 'Connect Jackett'}
		</button>
		<button class="btn gap-2 btn-outline btn-sm" onclick={() => (prowlarrImportOpen = true)}>
			<Download class="h-4 w-4" />
			{data.prowlarrConnection ? 'Prowlarr' : 'Connect Prowlarr'}
		</button>
		<button class="btn gap-2 btn-primary btn-sm" onclick={openAddModal}>
			<Plus class="h-4 w-4" />
			{m.settings_integrations_indexers_addButton()}
		</button>
	{/snippet}

	{#if data.definitionErrors && data.definitionErrors.length > 0}
		<div class="mb-4 alert alert-warning">
			<div>
				<span class="font-semibold"
					>{m.settings_integrations_indexers_definitionErrors({
						count: data.definitionErrors.length
					})}</span
				>
				<ul class="mt-1 list-inside list-disc text-sm">
					{#each data.definitionErrors.slice(0, 3) as error (error.filePath)}
						<li class="truncate">{error.filePath}: {error.error}</li>
					{/each}
					{#if data.definitionErrors.length > 3}
						<li>... and {data.definitionErrors.length - 3} more</li>
					{/if}
				</ul>
			</div>
		</div>
	{/if}

	<IndexerFilters {filters} onFilterChange={handleFilterChange} />

	{#if selectedIds.size > 0}
		<IndexerBulkActions
			selectedCount={selectedIds.size}
			loading={bulkLoading}
			onEnable={handleBulkEnable}
			onDisable={handleBulkDisable}
			onDelete={handleBulkDelete}
			onTestAll={handleBulkTest}
		/>
	{/if}

	<div class="card bg-base-200/40 shadow-none sm:bg-base-100 sm:shadow-xl">
		<div class="card-body p-2 sm:p-0">
			<IndexerTable
				indexers={filteredIndexers()}
				{selectedIds}
				{sort}
				{canReorder}
				{testingIds}
				{togglingIds}
				prowlarrBaseUrl={data.prowlarrConnection?.url ?? null}
				jackettBaseUrl={data.jackettConnection?.url ?? null}
				onSelect={handleSelect}
				onSelectAll={handleSelectAll}
				onSort={handleSort}
				onPrioritySortForReorder={handlePrioritySortForReorder}
				onEdit={openEditModal}
				onDelete={confirmDelete}
				onTest={handleTest}
				onToggle={handleToggle}
				onReorder={handleReorder}
			/>
		</div>
	</div>
</SettingsPage>

<!-- Add/Edit Modal -->
<IndexerModal
	open={modalOpen}
	mode={modalMode}
	indexer={editingIndexer}
	definitions={data.definitions}
	{saving}
	prowlarrBaseUrl={data.prowlarrConnection?.url ?? null}
	jackettBaseUrl={data.jackettConnection?.url ?? null}
	onClose={closeModal}
	onSave={handleSave}
	onDelete={handleDelete}
	onTest={handleModalTest}
/>

<!-- Delete Confirmation Modal -->
<ConfirmationModal
	open={confirmDeleteOpen}
	title={isDeleteTargetProwlarr || isDeleteTargetJackett
		? 'Remove from Cinephage'
		: m.ui_modal_deleteTitle()}
	messagePrefix={isDeleteTargetProwlarr || isDeleteTargetJackett
		? 'Remove '
		: m.settings_integrations_deleteConfirmPrefix()}
	messageEmphasis={deleteTarget?.name ?? ''}
	messageSuffix={isDeleteTargetProwlarr
		? ' from Cinephage? It will still exist in Prowlarr and can be re-imported.'
		: isDeleteTargetJackett
			? ' from Cinephage? It will still exist in Jackett and can be re-imported.'
			: m.settings_integrations_deleteConfirmSuffix()}
	confirmLabel={isDeleteTargetProwlarr || isDeleteTargetJackett ? 'Remove' : m.action_delete()}
	confirmVariant="error"
	onConfirm={handleConfirmDelete}
	onCancel={() => (confirmDeleteOpen = false)}
/>

<ConfirmationModal
	open={confirmBulkDeleteOpen}
	title={m.ui_modal_deleteTitle()}
	messagePrefix={m.settings_integrations_deleteConfirmPrefix()}
	messageEmphasis={m.settings_integrations_indexers_bulkDeleteCount({ count: selectedIds.size })}
	messageSuffix={m.settings_integrations_deleteConfirmSuffix()}
	confirmLabel={m.action_delete()}
	confirmVariant="error"
	onConfirm={handleConfirmBulkDelete}
	onCancel={() => (confirmBulkDeleteOpen = false)}
/>

<!-- Prowlarr Import Modal -->
<ProwlarrImportModal
	open={prowlarrImportOpen}
	storedConnection={data.prowlarrConnection}
	onClose={() => (prowlarrImportOpen = false)}
/>

<!-- Jackett Import Modal -->
<JackettImportModal
	open={jackettImportOpen}
	storedConnection={data.jackettConnection}
	onClose={() => (jackettImportOpen = false)}
/>
