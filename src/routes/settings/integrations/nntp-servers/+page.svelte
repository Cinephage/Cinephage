<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { Plus, Search } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import type { PageData } from './$types';
	import {
		NntpServerBulkActions,
		NntpServerModal,
		NntpServerTable
	} from '#lib/components/nntpServers/index.js';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import {
		createUsenetServer,
		updateUsenetServer,
		deleteUsenetServer,
		testUsenetServer,
		ApiError
	} from '#lib/api/index.js';

	interface NntpServer {
		id: string;
		name: string;
		host: string;
		port: number;
		useSsl: boolean | null;
		username: string | null;
		hasPassword?: boolean;
		maxConnections: number | null;
		priority: number | null;
		enabled: boolean | null;
		testResult: string | null;
		testError?: string | null;
		lastTestedAt: string | null;
	}

	interface NntpServerFormData {
		name: string;
		host: string;
		port: number;
		useSsl: boolean;
		username: string | null;
		password?: string | null;
		maxConnections: number;
		priority: number;
		enabled: boolean;
	}

	interface ConnectionTestResult {
		success: boolean;
		error?: string;
		greeting?: string;
	}

	let { data }: { data: PageData } = $props();

	let modalOpen = $state(false);
	let modalMode = $state<'add' | 'edit'>('add');
	let editingServer = $state<NntpServer | null>(null);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let confirmDeleteOpen = $state(false);
	let deleteTarget = $state<NntpServer | null>(null);
	let confirmBulkDeleteOpen = $state(false);
	let testingId = $state<string | null>(null);
	let bulkLoading = $state(false);
	let selectedIds = new SvelteSet<string>();

	interface NntpServerFilters {
		status: 'all' | 'enabled' | 'disabled';
		search: string;
	}

	interface NntpServerSortState {
		column: 'status' | 'name' | 'priority';
		direction: 'asc' | 'desc';
	}

	let filters = $state<NntpServerFilters>({
		status: 'all',
		search: ''
	});

	let sort = $state<NntpServerSortState>({
		column: 'name',
		direction: 'asc'
	});

	const canReorder = $derived(filters.status === 'all' && filters.search.trim().length === 0);

	function getStatusSortRank(server: NntpServer): number {
		if (!server.enabled) return 2;
		if (server.testResult === 'failed') return 1;
		return 0;
	}

	const filteredServers = $derived.by(() => {
		let result = [...data.nntpServers];

		if (filters.status === 'enabled') {
			result = result.filter((server) => !!server.enabled);
		} else if (filters.status === 'disabled') {
			result = result.filter((server) => !server.enabled);
		}

		const query = filters.search.trim().toLowerCase();
		if (query) {
			result = result.filter((server) => {
				const hostAndPort = `${server.host}:${server.port}`;
				return (
					server.name.toLowerCase().includes(query) ||
					server.host.toLowerCase().includes(query) ||
					hostAndPort.toLowerCase().includes(query) ||
					(server.username ?? '').toLowerCase().includes(query)
				);
			});
		}

		return result;
	});

	const sortedServers = $derived.by(() => {
		const result = [...filteredServers];
		const direction = sort.direction === 'asc' ? 1 : -1;

		result.sort((a, b) => {
			if (sort.column === 'status') {
				return (getStatusSortRank(a) - getStatusSortRank(b)) * direction;
			}
			if (sort.column === 'priority') {
				const aPriority = a.priority ?? Number.MAX_SAFE_INTEGER;
				const bPriority = b.priority ?? Number.MAX_SAFE_INTEGER;
				const byPriority = (aPriority - bPriority) * direction;
				if (byPriority !== 0) return byPriority;
				return a.name.localeCompare(b.name) * direction;
			}
			return a.name.localeCompare(b.name) * direction;
		});

		return result;
	});

	function updateSort(column: NntpServerSortState['column']) {
		if (sort.column === column) {
			sort = {
				...sort,
				direction: sort.direction === 'asc' ? 'desc' : 'asc'
			};
			return;
		}

		sort = {
			column,
			direction: 'asc'
		};
	}

	function handlePrioritySortForReorder() {
		sort = { column: 'priority', direction: 'asc' };
	}

	function updateFilter<K extends keyof NntpServerFilters>(key: K, value: NntpServerFilters[K]) {
		filters = { ...filters, [key]: value };
	}

	function openAddModal() {
		modalMode = 'add';
		editingServer = null;
		saveError = null;
		modalOpen = true;
	}

	function openEditModal(server: NntpServer) {
		modalMode = 'edit';
		editingServer = server;
		saveError = null;
		modalOpen = true;
	}

	function closeModal() {
		modalOpen = false;
		editingServer = null;
		saveError = null;
	}

	async function handleTest(data: NntpServerFormData): Promise<ConnectionTestResult> {
		try {
			const result = await testUsenetServer(data);
			return {
				success: !!result.success,
				error: result.error as string | undefined,
				greeting: result.greeting as string | undefined
			};
		} catch (error) {
			return {
				success: false,
				error:
					error instanceof ApiError
						? ((error.response as Record<string, unknown>).error as string) ||
							'Connection test failed'
						: error instanceof Error
							? error.message
							: 'Unknown error'
			};
		}
	}

	async function handleSave(formData: NntpServerFormData) {
		saving = true;
		saveError = null;

		try {
			if (modalMode === 'edit' && editingServer) {
				await updateUsenetServer(editingServer.id, formData);
			} else {
				await createUsenetServer(formData);
			}

			await refreshAll();
			closeModal();
		} catch (error) {
			if (error instanceof ApiError) {
				const err = (error.response as Record<string, unknown>).error;
				saveError = (typeof err === 'string' ? err : null) || 'Failed to save NNTP server';
			} else {
				saveError = error instanceof Error ? error.message : 'An unexpected error occurred';
			}
		} finally {
			saving = false;
		}
	}

	async function handleDelete() {
		if (!editingServer) return;

		try {
			await deleteUsenetServer(editingServer.id);
		} catch {
			// silently fail for modal delete
		}
		await refreshAll();
		closeModal();
	}

	function confirmDelete(server: NntpServer) {
		deleteTarget = server;
		confirmDeleteOpen = true;
	}

	async function handleConfirmDelete() {
		if (!deleteTarget) return;

		try {
			await deleteUsenetServer(deleteTarget.id);
		} catch {
			// silently fail
		}
		await refreshAll();
		confirmDeleteOpen = false;
		deleteTarget = null;
	}

	async function handleToggle(server: NntpServer) {
		try {
			await updateUsenetServer(server.id, { enabled: !server.enabled });
		} catch {
			// silently fail
		}
		await refreshAll();
	}

	async function handleNntpTest(server: NntpServer) {
		testingId = server.id;
		try {
			await testUsenetServer(server.id);
			await refreshAll();
		} finally {
			testingId = null;
		}
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
			for (const server of sortedServers) {
				selectedIds.add(server.id);
			}
		} else {
			selectedIds.clear();
		}
	}

	async function handleBulkEnable() {
		if (selectedIds.size === 0) return;
		bulkLoading = true;
		try {
			for (const id of selectedIds) {
				await updateUsenetServer(id, { enabled: true });
			}
			await refreshAll();
			selectedIds.clear();
		} finally {
			bulkLoading = false;
		}
	}

	async function handleBulkDisable() {
		if (selectedIds.size === 0) return;
		bulkLoading = true;
		try {
			for (const id of selectedIds) {
				await updateUsenetServer(id, { enabled: false });
			}
			await refreshAll();
			selectedIds.clear();
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
				await deleteUsenetServer(id);
			}
			await refreshAll();
			selectedIds.clear();
			confirmBulkDeleteOpen = false;
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
				try {
					await testUsenetServer(id);
					successCount += 1;
				} catch {
					failCount += 1;
				}
			}
			await refreshAll();
			toasts.info(
				m.settings_integrations_bulkTestComplete({
					successCount: String(successCount),
					failCount: String(failCount)
				})
			);
		} finally {
			bulkLoading = false;
		}
	}

	async function handleReorder(serverIds: string[]) {
		try {
			await Promise.all(
				serverIds.map((id, index) => updateUsenetServer(id, { priority: index + 1 }))
			);
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Failed to reorder priorities');
		} finally {
			await refreshAll();
		}
	}
</script>

<svelte:head>
	<title>{m.nav_nntpServers()}</title>
</svelte:head>

<SettingsPage title={m.nav_nntpServers()} subtitle={m.settings_integrations_nntpServers_subtitle()}>
	{#snippet actions()}
		<button class="btn w-full gap-2 btn-primary btn-sm sm:w-auto" onclick={openAddModal}>
			<Plus class="h-4 w-4" />
			{m.settings_integrations_nntpServers_addServer()}
		</button>
	{/snippet}

	<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
		<div class="form-control relative w-full sm:w-56">
			<Search
				class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/40"
			/>
			<input
				type="text"
				placeholder={m.settings_integrations_nntpServers_searchPlaceholder()}
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
		<NntpServerBulkActions
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
			<NntpServerTable
				servers={sortedServers}
				{selectedIds}
				onSelect={handleSelect}
				onSelectAll={handleSelectAll}
				{sort}
				onSort={updateSort}
				{canReorder}
				onPrioritySortForReorder={handlePrioritySortForReorder}
				onEdit={openEditModal}
				onDelete={confirmDelete}
				onToggle={handleToggle}
				onTest={handleNntpTest}
				{testingId}
				onReorder={handleReorder}
			/>
		</div>
	</div>
</SettingsPage>

<NntpServerModal
	open={modalOpen}
	mode={modalMode}
	server={editingServer}
	{saving}
	error={saveError}
	onClose={closeModal}
	onSave={handleSave}
	onDelete={handleDelete}
	onTest={handleTest}
/>

<ConfirmationModal
	open={confirmDeleteOpen}
	title={m.ui_modal_confirmTitle()}
	messagePrefix={m.settings_integrations_deleteConfirmPrefix()}
	messageEmphasis={deleteTarget?.name ?? m.settings_integrations_nntpServers_thisServer()}
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
	messageEmphasis={m.settings_integrations_nntpServers_bulkDeleteCount({ count: selectedIds.size })}
	messageSuffix={m.settings_integrations_deleteConfirmSuffix()}
	confirmLabel={m.action_delete()}
	confirmVariant="error"
	onConfirm={handleConfirmBulkDelete}
	onCancel={() => (confirmBulkDeleteOpen = false)}
/>
