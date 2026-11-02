<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { Plus, Search } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { getResponseErrorMessage } from '#lib/utils/http.js';
	import { isBlankOrRedacted } from '#lib/shared/sensitiveSettings.js';
	import type { PageData } from './$types';
	import type {
		MediaBrowserServerPublic,
		MediaBrowserTestResult,
		MediaBrowserPathMapping
	} from '#lib/server/notifications/mediabrowser/types.js';

	import {
		MediaBrowserBulkActions,
		MediaBrowserModal,
		MediaBrowserTable
	} from '#lib/components/mediaBrowsers/index.js';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import {
		createMediaBrowserNotification,
		updateMediaBrowserNotification,
		deleteMediaBrowserNotification,
		testMediaBrowserNotification,
		testNewMediaBrowserNotification,
		ApiError
	} from '#lib/api/index.js';
	import type {
		MediaBrowserServerCreate,
		MediaBrowserServerUpdate
	} from '#lib/validation/schemas.js';

	interface MediaBrowserFormData {
		name: string;
		serverType: 'jellyfin' | 'emby' | 'plex';
		host: string;
		apiKey: string;
		enabled: boolean;
		onImport: boolean;
		onUpgrade: boolean;
		onRename: boolean;
		onDelete: boolean;
		pathMappings: MediaBrowserPathMapping[];
	}

	let { data }: { data: PageData } = $props();

	// Modal state
	let modalOpen = $state(false);
	let modalMode = $state<'add' | 'edit'>('add');
	let editingServer = $state<MediaBrowserServerPublic | null>(null);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let confirmDeleteOpen = $state(false);
	let deleteTarget = $state<MediaBrowserServerPublic | null>(null);
	let confirmBulkDeleteOpen = $state(false);
	let testingId = $state<string | null>(null);
	let bulkLoading = $state(false);
	let selectedIds = new SvelteSet<string>();

	interface MediaBrowserPageFilters {
		type: 'all' | 'jellyfin' | 'emby' | 'plex';
		status: 'all' | 'enabled' | 'disabled';
		search: string;
	}

	interface MediaBrowserSortState {
		column: 'status' | 'name' | 'type';
		direction: 'asc' | 'desc';
	}

	let filters = $state<MediaBrowserPageFilters>({
		type: 'all',
		status: 'all',
		search: ''
	});

	let sort = $state<MediaBrowserSortState>({
		column: 'name',
		direction: 'asc'
	});

	function getStatusSortRank(server: MediaBrowserServerPublic): number {
		if (!server.enabled) return 2;
		if (server.testResult === 'failed') return 1;
		return 0;
	}

	const filteredServers = $derived.by(() => {
		let result = [...data.servers];

		if (filters.type !== 'all') {
			result = result.filter((server) => server.serverType === filters.type);
		}

		if (filters.status === 'enabled') {
			result = result.filter((server) => !!server.enabled);
		} else if (filters.status === 'disabled') {
			result = result.filter((server) => !server.enabled);
		}

		const query = filters.search.trim().toLowerCase();
		if (query) {
			result = result.filter((server) => {
				return (
					server.name.toLowerCase().includes(query) ||
					server.serverType.toLowerCase().includes(query) ||
					server.host.toLowerCase().includes(query) ||
					(server.serverName ?? '').toLowerCase().includes(query) ||
					(server.serverVersion ?? '').toLowerCase().includes(query)
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
			if (sort.column === 'type') {
				return a.serverType.localeCompare(b.serverType) * direction;
			}
			return a.name.localeCompare(b.name) * direction;
		});

		return result;
	});

	// Modal Functions
	function openAddModal() {
		modalMode = 'add';
		editingServer = null;
		saveError = null;
		modalOpen = true;
	}

	function openEditModal(server: MediaBrowserServerPublic) {
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

	function getServerErrorMessage(payload: unknown, fallback: string): string {
		return getResponseErrorMessage(payload, fallback);
	}

	function updateFilter<K extends keyof MediaBrowserPageFilters>(
		key: K,
		value: MediaBrowserPageFilters[K]
	) {
		filters = { ...filters, [key]: value };
	}

	function updateSort(column: MediaBrowserSortState['column']) {
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

	async function handleTest(formData: MediaBrowserFormData): Promise<MediaBrowserTestResult> {
		try {
			if (editingServer) {
				const payload = await testMediaBrowserNotification(editingServer.id, {
					host: formData.host,
					serverType: formData.serverType,
					apiKey: isBlankOrRedacted(formData.apiKey?.trim()) ? undefined : formData.apiKey,
					persist: false
				});
				return payload;
			}

			const payload = await testNewMediaBrowserNotification({
				host: formData.host,
				apiKey: formData.apiKey,
				serverType: formData.serverType
			});
			return payload;
		} catch (e) {
			return {
				success: false,
				error:
					e instanceof ApiError
						? getServerErrorMessage(e.response, 'Connection test failed')
						: e instanceof Error
							? e.message
							: 'Unknown error'
			};
		}
	}

	async function handleSave(formData: MediaBrowserFormData) {
		saving = true;
		saveError = null;
		try {
			const payload: Partial<MediaBrowserFormData> = { ...formData };
			if (modalMode === 'edit' && isBlankOrRedacted(payload.apiKey?.trim())) {
				delete payload.apiKey;
			}

			if (modalMode === 'edit' && editingServer) {
				await updateMediaBrowserNotification(
					editingServer.id,
					payload as unknown as MediaBrowserServerUpdate
				);
			} else {
				await createMediaBrowserNotification(payload as unknown as MediaBrowserServerCreate);
			}

			await refreshAll();
			closeModal();
		} catch (error) {
			if (error instanceof ApiError) {
				saveError = getServerErrorMessage(error.response, 'Failed to save server');
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
			await deleteMediaBrowserNotification(editingServer.id);
			await refreshAll();
			closeModal();
		} catch (error) {
			toasts.error(
				getServerErrorMessage(
					error instanceof ApiError
						? error.response
						: error instanceof Error
							? error.message
							: null,
					'Failed to delete server'
				)
			);
		}
	}

	function confirmDelete(server: MediaBrowserServerPublic) {
		deleteTarget = server;
		confirmDeleteOpen = true;
	}

	async function handleConfirmDelete() {
		if (!deleteTarget) return;
		try {
			await deleteMediaBrowserNotification(deleteTarget.id);
			await refreshAll();
			confirmDeleteOpen = false;
			deleteTarget = null;
		} catch (error) {
			toasts.error(
				getServerErrorMessage(
					error instanceof ApiError
						? error.response
						: error instanceof Error
							? error.message
							: null,
					'Failed to delete server'
				)
			);
		}
	}

	async function handleToggle(server: MediaBrowserServerPublic) {
		try {
			await updateMediaBrowserNotification(server.id, { enabled: !server.enabled });
			await refreshAll();
		} catch (error) {
			toasts.error(
				getServerErrorMessage(
					error instanceof ApiError
						? error.response
						: error instanceof Error
							? error.message
							: null,
					'Failed to update server state'
				)
			);
		}
	}

	async function handleTestFromTable(server: MediaBrowserServerPublic) {
		testingId = server.id;
		try {
			const result = await testMediaBrowserNotification(server.id);
			if (!result || !result.success) {
				toasts.error(getServerErrorMessage(result, 'Connection test failed'));
			} else {
				toasts.success(m.settings_integrations_connectionSuccessful());
			}
		} catch (error) {
			toasts.error(
				getServerErrorMessage(
					error instanceof ApiError
						? error.response
						: error instanceof Error
							? error.message
							: null,
					'Connection test failed'
				)
			);
		} finally {
			await refreshAll();
			testingId = null;
		}
	}

	async function handleBulkEnable() {
		if (selectedIds.size === 0) return;
		bulkLoading = true;
		try {
			for (const id of selectedIds) {
				await updateMediaBrowserNotification(id, { enabled: true });
			}

			await refreshAll();
			selectedIds.clear();
		} catch (error) {
			toasts.error(
				error instanceof ApiError
					? getServerErrorMessage(error.response, 'Failed to enable selected servers')
					: error instanceof Error
						? error.message
						: 'Failed to enable selected servers'
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
				await updateMediaBrowserNotification(id, { enabled: false });
			}

			await refreshAll();
			selectedIds.clear();
		} catch (error) {
			toasts.error(
				error instanceof ApiError
					? getServerErrorMessage(error.response, 'Failed to disable selected servers')
					: error instanceof Error
						? error.message
						: 'Failed to disable selected servers'
			);
		} finally {
			bulkLoading = false;
		}
	}

	function handleBulkDelete() {
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
				await deleteMediaBrowserNotification(id);
			}

			await refreshAll();
			selectedIds.clear();
			confirmBulkDeleteOpen = false;
		} catch (error) {
			toasts.error(
				error instanceof ApiError
					? getServerErrorMessage(error.response, 'Failed to delete selected servers')
					: error instanceof Error
						? error.message
						: 'Failed to delete selected servers'
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
				try {
					const result = await testMediaBrowserNotification(id);
					if (result && result.success) {
						successCount += 1;
					} else {
						failCount += 1;
					}
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
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Failed to test selected servers');
		} finally {
			bulkLoading = false;
		}
	}
</script>

<svelte:head>
	<title>{m.nav_mediaServers()}</title>
</svelte:head>

<SettingsPage
	title={m.nav_mediaServers()}
	subtitle={m.settings_integrations_mediaBrowsers_subtitle()}
>
	{#snippet actions()}
		<button class="btn w-full gap-2 btn-primary btn-sm sm:w-auto" onclick={openAddModal}>
			<Plus class="h-4 w-4" />
			{m.settings_integrations_mediaBrowsers_addServer()}
		</button>
	{/snippet}

	<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
		<div class="form-control relative w-full sm:w-56">
			<Search
				class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/40"
			/>
			<input
				type="text"
				placeholder={m.settings_integrations_mediaBrowsers_searchPlaceholder()}
				class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-4 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
				value={filters.search}
				oninput={(e) => updateFilter('search', e.currentTarget.value)}
			/>
		</div>

		<div class="join w-full sm:w-auto">
			<button
				class="btn join-item flex-1 btn-sm sm:flex-none"
				class:btn-active={filters.type === 'all'}
				onclick={() => updateFilter('type', 'all')}
			>
				{m.common_all()}
			</button>
			<button
				class="btn join-item flex-1 btn-sm sm:flex-none"
				class:btn-active={filters.type === 'jellyfin'}
				onclick={() => updateFilter('type', 'jellyfin')}
			>
				Jellyfin
			</button>
			<button
				class="btn join-item flex-1 btn-sm sm:flex-none"
				class:btn-active={filters.type === 'emby'}
				onclick={() => updateFilter('type', 'emby')}
			>
				Emby
			</button>
			<button
				class="btn join-item flex-1 btn-sm sm:flex-none"
				class:btn-active={filters.type === 'plex'}
				onclick={() => updateFilter('type', 'plex')}
			>
				Plex
			</button>
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
		<MediaBrowserBulkActions
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
			<MediaBrowserTable
				servers={sortedServers}
				{selectedIds}
				onSelect={handleSelect}
				onSelectAll={handleSelectAll}
				{sort}
				onSort={updateSort}
				onEdit={openEditModal}
				onDelete={confirmDelete}
				onToggle={handleToggle}
				onTest={handleTestFromTable}
				{testingId}
			/>
		</div>
	</div>
</SettingsPage>

<!-- Media Server Modal -->
<MediaBrowserModal
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

<!-- Delete Confirmation Modal -->
<ConfirmationModal
	open={confirmDeleteOpen}
	title={m.ui_modal_confirmTitle()}
	messagePrefix={m.settings_integrations_deleteConfirmPrefix()}
	messageEmphasis={deleteTarget?.name ?? m.settings_integrations_mediaBrowsers_thisServer()}
	messageSuffix={m.settings_integrations_deleteConfirmSuffix()}
	confirmLabel={m.action_delete()}
	confirmVariant="error"
	onConfirm={handleConfirmDelete}
	onCancel={() => {
		confirmDeleteOpen = false;
		deleteTarget = null;
	}}
/>

<ConfirmationModal
	open={confirmBulkDeleteOpen}
	title={m.ui_modal_confirmTitle()}
	messagePrefix={m.settings_integrations_deleteConfirmPrefix()}
	messageEmphasis={m.settings_integrations_mediaBrowsers_bulkDeleteCount({
		count: selectedIds.size
	})}
	messageSuffix={m.settings_integrations_deleteConfirmSuffix()}
	confirmLabel={m.action_delete()}
	confirmVariant="error"
	loading={bulkLoading}
	onConfirm={handleConfirmBulkDelete}
	onCancel={() => {
		confirmBulkDeleteOpen = false;
	}}
/>
