<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { Plus, Search } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { getResponseErrorMessage } from '#lib/utils/http.js';
	import type { PageData } from './$types';
	import type { SubtitleProviderConfig } from '#lib/server/subtitles/types.js';
	import type { ProviderDefinition } from '#lib/server/subtitles/providers/interfaces.js';

	import {
		SubtitleProviderTable,
		SubtitleProviderModal,
		SubtitleProviderBulkActions
	} from '#lib/components/subtitleProviders/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { isBlankOrRedacted } from '#lib/shared/sensitiveSettings.js';
	import {
		createSubtitleProvider,
		updateSubtitleProvider,
		deleteSubtitleProvider,
		testSubtitleProvider,
		reorderSubtitleProviders,
		ApiError
	} from '#lib/api/index.js';
	import type { SubtitleProviderImplementation } from '#lib/validation/schemas.js';

	interface SubtitleProviderFormData {
		name: string;
		implementation: string;
		enabled: boolean;
		priority: number;
		apiKey?: string;
		username?: string;
		password?: string;
		requestsPerMinute: number;
		settings?: Record<string, unknown>;
	}

	interface SubtitleProviderWithDefinition extends SubtitleProviderConfig {
		definitionName?: string;
		definition?: ProviderDefinition;
	}

	let { data }: { data: PageData } = $props();

	// Modal state
	let modalOpen = $state(false);
	let modalMode = $state<'add' | 'edit'>('add');
	let editingProvider = $state<SubtitleProviderWithDefinition | null>(null);
	let saving = $state(false);

	// Test state
	let testingIds = new SvelteSet<string>();
	let bulkLoading = $state(false);
	let selectedIds = new SvelteSet<string>();

	// Confirmation dialog state
	let confirmDeleteOpen = $state(false);
	let deleteTarget = $state<SubtitleProviderWithDefinition | null>(null);
	let confirmBulkDeleteOpen = $state(false);

	// Sort state
	type SortColumn = 'name' | 'priority' | 'enabled';
	let sort = $state<{ column: SortColumn; direction: 'asc' | 'desc' }>({
		column: 'priority',
		direction: 'asc'
	});

	interface SubtitleProviderPageFilters {
		status: 'all' | 'enabled' | 'disabled';
		search: string;
	}

	let filters = $state<SubtitleProviderPageFilters>({
		status: 'all',
		search: ''
	});

	function updateFilter<K extends keyof SubtitleProviderPageFilters>(
		key: K,
		value: SubtitleProviderPageFilters[K]
	) {
		filters = { ...filters, [key]: value };
	}

	const filteredProviders = $derived(() => {
		let result = [...data.providers] as SubtitleProviderWithDefinition[];

		if (filters.status === 'enabled') {
			result = result.filter((provider) => !!provider.enabled);
		} else if (filters.status === 'disabled') {
			result = result.filter((provider) => !provider.enabled);
		}

		const query = filters.search.trim().toLowerCase();
		if (query) {
			result = result.filter((provider) => {
				const definitionName =
					provider.definitionName ?? provider.definition?.name ?? provider.implementation;
				return (
					provider.name.toLowerCase().includes(query) ||
					provider.implementation.toLowerCase().includes(query) ||
					definitionName.toLowerCase().includes(query)
				);
			});
		}

		return result;
	});

	// Derived: filtered + sorted providers
	const sortedProviders = $derived(() => {
		let result = [...filteredProviders()] as SubtitleProviderWithDefinition[];

		result.sort((a, b) => {
			let comparison = 0;
			switch (sort.column) {
				case 'name':
					comparison = a.name.localeCompare(b.name);
					break;
				case 'priority':
					comparison = a.priority - b.priority;
					break;
				case 'enabled':
					comparison = (a.enabled ? 1 : 0) - (b.enabled ? 1 : 0);
					break;
			}
			return sort.direction === 'asc' ? comparison : -comparison;
		});

		return result;
	});

	const canReorder = $derived(() => filters.status === 'all' && filters.search.trim().length === 0);

	// Functions
	function openAddModal() {
		modalMode = 'add';
		editingProvider = null;
		modalOpen = true;
	}

	function openEditModal(provider: SubtitleProviderWithDefinition) {
		modalMode = 'edit';
		editingProvider = provider;
		modalOpen = true;
	}

	function closeModal() {
		modalOpen = false;
		editingProvider = null;
	}

	function getProviderErrorMessage(payload: unknown, fallback: string): string {
		return getResponseErrorMessage(payload, fallback);
	}

	function handleSort(column: SortColumn) {
		if (sort.column === column) {
			sort = { column, direction: sort.direction === 'asc' ? 'desc' : 'asc' };
		} else {
			sort = { column, direction: 'asc' };
		}
	}

	function confirmDelete(provider: SubtitleProviderWithDefinition) {
		deleteTarget = provider;
		confirmDeleteOpen = true;
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
			for (const provider of sortedProviders()) {
				selectedIds.add(provider.id);
			}
		} else {
			selectedIds.clear();
		}
	}

	async function testProviderConnection(provider: SubtitleProviderWithDefinition) {
		try {
			const payload = await testSubtitleProvider({
				implementation: provider.implementation,
				apiKey: provider.apiKey,
				username: provider.username,
				password: provider.password,
				settings: provider.settings
			});
			return payload;
		} catch (e) {
			return {
				success: false,
				error:
					e instanceof ApiError
						? getProviderErrorMessage(e.response, 'Connection test failed')
						: e instanceof Error
							? e.message
							: 'Connection test failed'
			};
		}
	}

	async function handleTest(provider: SubtitleProviderWithDefinition) {
		testingIds.add(provider.id);
		try {
			const result = await testProviderConnection(provider);
			const data = result as {
				success: boolean;
				error?: string;
				message?: string;
				responseTime?: number;
			};
			if (!data.success) {
				toasts.error(
					`Test failed: ${data.message || data.error || m.settings_integrations_subtitleProviders_connectionTestFailed()}`
				);
			} else {
				toasts.success(
					m.settings_integrations_subtitleProviders_connectionSuccessful({
						name: provider.name,
						responseTime: String(data.responseTime)
					})
				);
			}
		} catch (e) {
			toasts.error(`Test failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
		} finally {
			testingIds.delete(provider.id);
		}
	}

	async function handleToggle(provider: SubtitleProviderWithDefinition) {
		try {
			await updateSubtitleProvider(provider.id, { enabled: !provider.enabled });
			await refreshAll();
		} catch (e) {
			toasts.error(
				e instanceof ApiError
					? getProviderErrorMessage(e.response, 'Failed to update provider state')
					: e instanceof Error
						? e.message
						: 'Failed to update provider state'
			);
		}
	}

	async function handleBulkEnable() {
		if (selectedIds.size === 0) return;
		bulkLoading = true;
		try {
			for (const id of selectedIds) {
				await updateSubtitleProvider(id, { enabled: true });
			}

			await refreshAll();
			selectedIds.clear();
		} catch (e) {
			toasts.error(
				e instanceof ApiError
					? getProviderErrorMessage(e.response, 'Failed to enable selected providers')
					: e instanceof Error
						? e.message
						: 'Failed to enable selected providers'
			);
		} finally {
			bulkLoading = false;
		}
	}

	async function handleBulkDisable() {
		if (selectedIds.size === 0) return;
		bulkLoading = true;
		try {
			for (const id of selectedIds) {
				await updateSubtitleProvider(id, { enabled: false });
			}

			await refreshAll();
			selectedIds.clear();
		} catch (e) {
			toasts.error(
				e instanceof ApiError
					? getProviderErrorMessage(e.response, 'Failed to disable selected providers')
					: e instanceof Error
						? e.message
						: 'Failed to disable selected providers'
			);
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
				await deleteSubtitleProvider(id);
			}

			await refreshAll();
			selectedIds.clear();
			confirmBulkDeleteOpen = false;
		} catch (e) {
			toasts.error(
				e instanceof ApiError
					? getProviderErrorMessage(e.response, 'Failed to delete selected providers')
					: e instanceof Error
						? e.message
						: 'Failed to delete selected providers'
			);
		} finally {
			bulkLoading = false;
		}
	}

	async function handleBulkTest() {
		if (selectedIds.size === 0) return;
		bulkLoading = true;

		let successCount = 0;
		let failCount = 0;
		try {
			for (const id of selectedIds) {
				const provider = data.providers.find((p) => p.id === id) as
					SubtitleProviderWithDefinition | undefined;
				if (!provider) continue;

				const result = await testProviderConnection(provider);
				if (result.success) {
					successCount += 1;
				} else {
					failCount += 1;
				}
			}

			toasts.info(
				m.settings_integrations_bulkTestComplete({
					successCount: String(successCount),
					failCount: String(failCount)
				})
			);
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to test selected providers');
		} finally {
			bulkLoading = false;
		}
	}

	async function handleModalTest(
		formData: SubtitleProviderFormData
	): Promise<{ success: boolean; error?: string }> {
		try {
			const isEdit = modalMode === 'edit' && !!editingProvider;
			const existingProvider = isEdit ? editingProvider : null;
			const resolvedApiKey =
				existingProvider && isBlankOrRedacted(formData.apiKey?.trim())
					? existingProvider.apiKey
					: formData.apiKey;
			const resolvedPassword =
				existingProvider && isBlankOrRedacted(formData.password?.trim())
					? existingProvider.password
					: formData.password;
			const result = await testSubtitleProvider({
				implementation: formData.implementation as SubtitleProviderImplementation,
				apiKey: resolvedApiKey,
				username: formData.username,
				password: resolvedPassword,
				settings: formData.settings
			});
			return { success: Boolean(result.success), error: result.error };
		} catch (e) {
			return {
				success: false,
				error:
					e instanceof ApiError
						? getProviderErrorMessage(e.response, 'Connection test failed')
						: e instanceof Error
							? e.message
							: 'Unknown error'
			};
		}
	}

	async function handleSave(formData: SubtitleProviderFormData) {
		saving = true;
		try {
			const typedFormData = {
				...formData,
				implementation: formData.implementation as SubtitleProviderImplementation
			};
			if (modalMode === 'edit' && editingProvider) {
				if (isBlankOrRedacted(typedFormData.apiKey?.trim())) {
					delete typedFormData.apiKey;
				}
				if (isBlankOrRedacted(typedFormData.password?.trim())) {
					delete typedFormData.password;
				}
				await updateSubtitleProvider(editingProvider.id, typedFormData);
			} else {
				await createSubtitleProvider(typedFormData);
			}

			await refreshAll();
			closeModal();
		} catch (e) {
			if (e instanceof ApiError) {
				toasts.error(getProviderErrorMessage(e.response, 'Failed to save provider'));
			} else {
				toasts.error(e instanceof Error ? e.message : 'Failed to save provider');
			}
		} finally {
			saving = false;
		}
	}

	async function handleDelete() {
		if (!editingProvider) return;
		try {
			await deleteSubtitleProvider(editingProvider.id);
			await refreshAll();
			closeModal();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to delete provider');
		}
	}

	async function handleConfirmDelete() {
		if (!deleteTarget) return;
		try {
			await deleteSubtitleProvider(deleteTarget.id);
			await refreshAll();
			confirmDeleteOpen = false;
			deleteTarget = null;
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to delete provider');
		}
	}

	async function handleReorder(providerIds: string[]) {
		try {
			await reorderSubtitleProviders(providerIds);
			await refreshAll();
		} catch (e) {
			toasts.error(
				e instanceof ApiError
					? String((e.response as Record<string, unknown>)?.error || 'Failed to reorder providers')
					: e instanceof Error
						? e.message
						: 'Failed to reorder providers'
			);
		}
	}
</script>

<svelte:head>
	<title>{m.nav_subtitleProviders()}</title>
</svelte:head>

<SettingsPage
	title={m.nav_subtitleProviders()}
	subtitle={m.settings_integrations_subtitleProviders_subtitle()}
>
	{#snippet actions()}
		<button class="btn w-full gap-2 btn-primary btn-sm sm:w-auto" onclick={openAddModal}>
			<Plus class="h-4 w-4" />
			{m.settings_integrations_subtitleProviders_addProvider()}
		</button>
	{/snippet}

	<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
		<div class="form-control relative w-full sm:w-56">
			<Search
				class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/40"
			/>
			<input
				type="text"
				placeholder={m.settings_integrations_subtitleProviders_searchPlaceholder()}
				class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-4 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
				value={filters.search}
				oninput={(e) => updateFilter('search', e.currentTarget.value)}
			/>
		</div>

		<div class="join w-full sm:w-auto">
			<button
				class="btn join-item flex-1 btn-sm sm:flex-none"
				class:btn-active={filters.status === 'all'}
				onclick={() => updateFilter('status', 'all')}
			>
				{m.common_all()}
			</button>
			<button
				class="btn join-item flex-1 btn-sm sm:flex-none"
				class:btn-active={filters.status === 'enabled'}
				onclick={() => updateFilter('status', 'enabled')}
			>
				{m.common_enabled()}
			</button>
			<button
				class="btn join-item flex-1 btn-sm sm:flex-none"
				class:btn-active={filters.status === 'disabled'}
				onclick={() => updateFilter('status', 'disabled')}
			>
				{m.common_disabled()}
			</button>
		</div>
	</div>

	{#if selectedIds.size > 0}
		<SubtitleProviderBulkActions
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
			<SubtitleProviderTable
				providers={sortedProviders()}
				{selectedIds}
				{sort}
				{testingIds}
				onSelect={handleSelect}
				onSelectAll={handleSelectAll}
				onSort={handleSort}
				onEdit={openEditModal}
				onDelete={confirmDelete}
				onTest={handleTest}
				onToggle={handleToggle}
				onReorder={canReorder() ? handleReorder : undefined}
			/>
		</div>
	</div>
</SettingsPage>

<!-- Add/Edit Modal -->
<SubtitleProviderModal
	open={modalOpen}
	mode={modalMode}
	provider={editingProvider}
	definitions={data.definitions}
	{saving}
	onClose={closeModal}
	onSave={handleSave}
	onDelete={handleDelete}
	onTest={handleModalTest}
/>

<!-- Delete Confirmation Modal -->
<ConfirmationModal
	open={confirmDeleteOpen}
	title={m.ui_modal_confirmTitle()}
	messagePrefix={m.settings_integrations_deleteConfirmPrefix()}
	messageEmphasis={deleteTarget?.name ?? ''}
	messageSuffix={m.settings_integrations_deleteConfirmSuffix()}
	confirmLabel={m.action_delete()}
	confirmVariant="error"
	onConfirm={handleConfirmDelete}
	onCancel={() => (confirmDeleteOpen = false)}
/>

<ConfirmationModal
	open={confirmBulkDeleteOpen}
	title={m.ui_modal_confirmTitle()}
	messagePrefix={m.settings_integrations_deleteConfirmPrefix()}
	messageEmphasis={m.settings_integrations_subtitleProviders_bulkDeleteCount({
		count: selectedIds.size
	})}
	messageSuffix={m.settings_integrations_deleteConfirmSuffix()}
	confirmLabel={m.action_delete()}
	confirmVariant="error"
	loading={bulkLoading}
	onConfirm={handleConfirmBulkDelete}
	onCancel={() => (confirmBulkDeleteOpen = false)}
/>
