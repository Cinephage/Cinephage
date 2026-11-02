<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { Plus, Search } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { SvelteSet } from 'svelte/reactivity';
	import { toFriendlyDownloadClientError } from '#lib/downloadClients/errorMessages.js';
	import type { PageData } from './$types';
	import type {
		DownloadClientFormData,
		ConnectionTestResult,
		UnifiedClientItem
	} from '#lib/types/downloadClient.js';
	import {
		DownloadClientBulkActions,
		DownloadClientModal,
		DownloadClientTable
	} from '#lib/components/downloadClients/index.js';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { isBlankOrRedacted } from '#lib/shared/sensitiveSettings.js';
	import {
		createDownloadClient,
		updateDownloadClient,
		deleteDownloadClient,
		testDownloadClient,
		testNewDownloadClient,
		updateMonitoringSettings,
		ApiError
	} from '#lib/api/index.js';
	import type {
		DownloadClientCreate,
		DownloadClientUpdate,
		DownloadClientTest
	} from '#lib/validation/schemas.js';

	let { data }: { data: PageData } = $props();

	let modalOpen = $state(false);
	let modalMode = $state<'add' | 'edit'>('add');
	let editingClient = $state<UnifiedClientItem | null>(null);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let confirmDeleteOpen = $state(false);
	let deleteTarget = $state<UnifiedClientItem | null>(null);
	let confirmBulkDeleteOpen = $state(false);
	let testingId = $state<string | null>(null);
	let bulkLoading = $state(false);
	let defaultAcquisitionProtocol = $state<'torrent' | 'debrid'>('torrent');
	let selectedIds = new SvelteSet<string>();

	interface DownloadClientPageFilters {
		protocol: 'all' | 'torrent' | 'usenet' | 'debrid';
		status: 'all' | 'enabled' | 'disabled';
		search: string;
	}

	interface DownloadClientSortState {
		column: 'status' | 'name' | 'protocol';
		direction: 'asc' | 'desc';
	}

	let filters = $state<DownloadClientPageFilters>({
		protocol: 'all',
		status: 'all',
		search: ''
	});

	let sort = $state<DownloadClientSortState>({
		column: 'name',
		direction: 'asc'
	});

	$effect(() => {
		defaultAcquisitionProtocol = data.defaultAcquisitionProtocol;
	});

	const debridAvailable = $derived(
		data.downloadClients.some(
			(client) =>
				(client.implementation === 'realdebrid' || client.implementation === 'torbox') &&
				client.enabled &&
				client.hasApiToken
		)
	);

	// If the last usable debrid client is removed/disabled, fall back to torrent
	// rather than leaving an unreachable "debrid" preference in place with no
	// control left in the UI to change it back.
	$effect(() => {
		if (!debridAvailable && defaultAcquisitionProtocol === 'debrid') {
			defaultAcquisitionProtocol = 'torrent';
			void saveDefaultAcquisitionProtocol();
		}
	});

	async function saveDefaultAcquisitionProtocol() {
		const response = await fetch('/api/settings/acquisition', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ defaultAcquisitionProtocol })
		});
		if (!response.ok) toasts.error(m.common_failedToSave());
	}

	interface NntpServerFormData {
		name: string;
		host: string;
		port: number;
		useSsl: boolean;
		username: string | null;
		password: string | null;
		maxConnections: number;
		priority: number;
		enabled: boolean;
	}

	const downloadClientRows = $derived(
		data.downloadClients.map((c): UnifiedClientItem => ({
			...c,
			type: 'download-client',
			implementation: c.implementation
		}))
	);

	function getClientProtocol(
		implementation: UnifiedClientItem['implementation']
	): 'torrent' | 'usenet' | 'debrid' {
		switch (implementation) {
			case 'sabnzbd':
			case 'nzbget':
			case 'nntp':
				return 'usenet';
			case 'realdebrid':
			case 'torbox':
				return 'debrid';
			default:
				return 'torrent';
		}
	}

	const filteredDownloadClientRows = $derived.by(() => {
		let result = [...downloadClientRows];

		if (filters.protocol !== 'all') {
			result = result.filter(
				(client) => getClientProtocol(client.implementation) === filters.protocol
			);
		}

		if (filters.status === 'enabled') {
			result = result.filter((client) => !!client.enabled);
		} else if (filters.status === 'disabled') {
			result = result.filter((client) => !client.enabled);
		}

		const query = filters.search.trim().toLowerCase();
		if (query) {
			result = result.filter((client) => {
				const hostAndPort = `${client.host}:${client.port}`;
				return (
					client.name.toLowerCase().includes(query) ||
					client.implementation.toLowerCase().includes(query) ||
					client.host?.toLowerCase().includes(query) ||
					hostAndPort.toLowerCase().includes(query) ||
					client.movieCategory?.toLowerCase().includes(query) ||
					client.tvCategory?.toLowerCase().includes(query)
				);
			});
		}

		return result;
	});

	function getStatusSortRank(client: UnifiedClientItem): number {
		if (!client.enabled) return 3;

		switch (client.status?.health) {
			case 'failing':
				return 2;
			case 'warning':
				return 1;
			default:
				return 0;
		}
	}

	const sortedDownloadClientRows = $derived.by(() => {
		const result = [...filteredDownloadClientRows];
		const direction = sort.direction === 'asc' ? 1 : -1;

		result.sort((a, b) => {
			if (sort.column === 'status') {
				return (getStatusSortRank(a) - getStatusSortRank(b)) * direction;
			}

			if (sort.column === 'name') {
				return a.name.localeCompare(b.name) * direction;
			}

			const aProtocol = getClientProtocol(a.implementation);
			const bProtocol = getClientProtocol(b.implementation);
			return aProtocol.localeCompare(bProtocol) * direction;
		});

		return result;
	});

	function updateFilter<K extends keyof DownloadClientPageFilters>(
		key: K,
		value: DownloadClientPageFilters[K]
	) {
		filters = { ...filters, [key]: value };
	}

	function updateSort(column: DownloadClientSortState['column']) {
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
			for (const client of sortedDownloadClientRows) {
				selectedIds.add(client.id);
			}
		} else {
			selectedIds.clear();
		}
	}

	function openAddDownloadClientModal() {
		modalMode = 'add';
		editingClient = null;
		saveError = null;
		modalOpen = true;
	}

	function openEditModal(client: UnifiedClientItem) {
		modalMode = 'edit';
		editingClient = client;
		saveError = null;
		modalOpen = true;
	}

	function closeModal() {
		modalOpen = false;
		editingClient = null;
		saveError = null;
	}

	function errorFromResponse(payload: unknown, fallback: string): string {
		if (payload && typeof payload === 'object') {
			const err = (payload as Record<string, unknown>).error;
			if (typeof err === 'string' && err.trim()) return err;
		}
		return fallback;
	}

	function toDownloadClientErrorMessage(payload: unknown, fallback: string): string {
		return toFriendlyDownloadClientError(errorFromResponse(payload, fallback));
	}

	async function handleTest(
		formData: DownloadClientFormData | NntpServerFormData,
		isNntp: boolean
	): Promise<ConnectionTestResult> {
		if (isNntp) {
			return {
				success: false,
				error: 'NNTP servers are managed on the NNTP Servers page.'
			};
		}

		const dcFormData = formData as DownloadClientFormData;
		const hasPasswordOverride = !isBlankOrRedacted(dcFormData.password?.trim());
		const hasTokenOverride = !isBlankOrRedacted(dcFormData.apiToken?.trim());
		const fallbackId =
			modalMode === 'edit' && editingClient && !hasPasswordOverride && !hasTokenOverride
				? editingClient.id
				: undefined;

		try {
			return await testNewDownloadClient({
				id: fallbackId,
				implementation: dcFormData.implementation,
				host: dcFormData.host,
				port: dcFormData.port,
				useSsl: dcFormData.useSsl,
				urlBase: dcFormData.urlBase,
				mountMode: dcFormData.mountMode,
				username: dcFormData.username || null,
				password: dcFormData.password || null,
				apiToken: dcFormData.apiToken || null
			} as DownloadClientTest);
		} catch (e) {
			return {
				success: false,
				error:
					e instanceof ApiError
						? toDownloadClientErrorMessage(e.response, 'Connection test failed')
						: toFriendlyDownloadClientError(
								e instanceof Error ? e.message : 'Connection test failed'
							)
			};
		}
	}

	async function handleSave(
		formData: DownloadClientFormData | NntpServerFormData,
		isNntp: boolean
	) {
		if (isNntp) {
			saveError = 'NNTP servers are managed on the NNTP Servers page.';
			return;
		}

		saving = true;
		saveError = null;
		try {
			const payload = formData as DownloadClientFormData;
			if (modalMode === 'edit' && editingClient) {
				await updateDownloadClient(editingClient.id, payload as unknown as DownloadClientUpdate);
			} else {
				await createDownloadClient(payload as unknown as DownloadClientCreate);
			}

			await refreshAll();
			closeModal();
		} catch (error) {
			if (error instanceof ApiError) {
				saveError = toDownloadClientErrorMessage(error.response, 'Failed to save download client');
			} else {
				saveError = toFriendlyDownloadClientError(
					error instanceof Error ? error.message : 'An unexpected error occurred'
				);
			}
		} finally {
			saving = false;
		}
	}

	async function handleDelete() {
		if (!editingClient) return;
		try {
			await deleteDownloadClient(editingClient.id);
			await refreshAll();
			closeModal();
		} catch (error) {
			toasts.error(
				toDownloadClientErrorMessage(
					error instanceof ApiError
						? error.response
						: error instanceof Error
							? error.message
							: null,
					'Failed to delete download client'
				)
			);
		}
	}

	function confirmDelete(client: UnifiedClientItem) {
		deleteTarget = client;
		confirmDeleteOpen = true;
	}

	async function handleConfirmDelete() {
		if (!deleteTarget) return;
		try {
			await deleteDownloadClient(deleteTarget.id);
			await refreshAll();
			confirmDeleteOpen = false;
			deleteTarget = null;
		} catch (error) {
			toasts.error(
				toDownloadClientErrorMessage(
					error instanceof ApiError
						? error.response
						: error instanceof Error
							? error.message
							: null,
					'Failed to delete download client'
				)
			);
		}
	}

	async function handleToggle(client: UnifiedClientItem) {
		try {
			await updateDownloadClient(client.id, { enabled: !client.enabled });
			await refreshAll();
		} catch (error) {
			toasts.error(
				toDownloadClientErrorMessage(
					error instanceof ApiError
						? error.response
						: error instanceof Error
							? error.message
							: null,
					'Failed to update client state'
				)
			);
		}
	}

	async function handleRowTest(client: UnifiedClientItem) {
		testingId = client.id;
		try {
			const result = await testDownloadClient(client.id);
			if (!result || !result.success) {
				toasts.error(toDownloadClientErrorMessage(result, 'Connection test failed'));
				return;
			}

			toasts.success(m.settings_integrations_connectionSuccessful());
		} catch (error) {
			toasts.error(
				toFriendlyDownloadClientError(
					error instanceof Error ? error.message : 'Connection test failed'
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
				await updateDownloadClient(id, { enabled: true });
			}

			await refreshAll();
			selectedIds.clear();
		} catch (error) {
			toasts.error(
				toDownloadClientErrorMessage(
					error instanceof ApiError
						? error.response
						: error instanceof Error
							? error.message
							: null,
					'Failed to enable selected clients'
				)
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
				await updateDownloadClient(id, { enabled: false });
			}

			await refreshAll();
			selectedIds.clear();
		} catch (error) {
			toasts.error(
				toDownloadClientErrorMessage(
					error instanceof ApiError
						? error.response
						: error instanceof Error
							? error.message
							: null,
					'Failed to disable selected clients'
				)
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
				await deleteDownloadClient(id);
			}

			await refreshAll();
			selectedIds.clear();
			confirmBulkDeleteOpen = false;
		} catch (error) {
			toasts.error(
				toDownloadClientErrorMessage(
					error instanceof ApiError
						? error.response
						: error instanceof Error
							? error.message
							: null,
					'Failed to delete selected clients'
				)
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
					const result = await testDownloadClient(id);
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
			toasts.error(error instanceof Error ? error.message : 'Failed to test selected clients');
		} finally {
			bulkLoading = false;
		}
	}
</script>

<svelte:head>
	<title>{m.nav_downloadClients()}</title>
</svelte:head>

<SettingsPage
	title={m.nav_downloadClients()}
	subtitle={m.settings_integrations_downloadClients_subtitle()}
>
	{#snippet actions()}
		<button
			class="btn w-full gap-2 btn-primary btn-sm sm:w-auto"
			onclick={openAddDownloadClientModal}
		>
			<Plus class="h-4 w-4" />
			{m.settings_integrations_downloadClients_addButton()}
		</button>
	{/snippet}

	<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
		<div class="form-control relative w-full sm:w-56">
			<Search
				class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/40"
			/>
			<input
				type="text"
				placeholder={m.settings_integrations_downloadClients_searchPlaceholder()}
				class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-4 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
				value={filters.search}
				oninput={(e) => updateFilter('search', e.currentTarget.value)}
			/>
		</div>

		<div class="join w-full sm:w-auto">
			<button
				class="btn join-item flex-1 btn-sm sm:flex-none"
				class:btn-active={filters.protocol === 'all'}
				onclick={() => updateFilter('protocol', 'all')}
			>
				{m.common_all()}
			</button>
			<button
				class="btn join-item flex-1 btn-sm sm:flex-none"
				class:btn-active={filters.protocol === 'torrent'}
				onclick={() => updateFilter('protocol', 'torrent')}
			>
				{m.settings_integrations_downloadClients_torrent()}
			</button>
			<button
				class="btn join-item flex-1 btn-sm sm:flex-none"
				class:btn-active={filters.protocol === 'usenet'}
				onclick={() => updateFilter('protocol', 'usenet')}
			>
				{m.settings_integrations_downloadClients_usenet()}
			</button>
			<button
				class="btn join-item flex-1 btn-sm sm:flex-none"
				class:btn-active={filters.protocol === 'debrid'}
				onclick={() => updateFilter('protocol', 'debrid')}
			>
				{m.settings_integrations_downloadClients_debrid()}
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

	{#if debridAvailable}
		<div class="mb-4 rounded-lg border border-base-300 bg-base-100 p-4">
			<label class="label py-1" for="defaultAcquisitionProtocol">
				<span class="label-text font-medium">{m.acquisition_defaultPreference()}</span>
			</label>
			<select
				id="defaultAcquisitionProtocol"
				class="select-bordered select select-sm"
				bind:value={defaultAcquisitionProtocol}
				onchange={saveDefaultAcquisitionProtocol}
			>
				<option value="torrent">{m.acquisition_torrentClient()}</option>
				<option value="debrid">{m.acquisition_debrid()}</option>
			</select>
		</div>
	{/if}

	{#if selectedIds.size > 0}
		<DownloadClientBulkActions
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
			<DownloadClientTable
				clients={sortedDownloadClientRows}
				{selectedIds}
				onSelect={handleSelect}
				onSelectAll={handleSelectAll}
				{sort}
				onSort={updateSort}
				onEdit={openEditModal}
				onDelete={confirmDelete}
				onToggle={handleToggle}
				onTest={handleRowTest}
				{testingId}
			/>
		</div>
	</div>
</SettingsPage>

<DownloadClientModal
	open={modalOpen}
	mode={modalMode}
	client={editingClient as unknown as import('#lib/types/downloadClient.js').DownloadClient | null}
	{saving}
	error={saveError}
	stalledTimeoutMinutes={data.stalledDownloadTimeoutMinutes}
	stalledProgressThreshold={data.stalledDownloadProgressThreshold}
	stalledBlocklistHours={data.stalledDownloadBlocklistHours}
	onSaveStalledBehavior={async (timeout, threshold, blocklistHours) => {
		try {
			await updateMonitoringSettings({
				stalledDownloadTimeoutMinutes: timeout,
				stalledDownloadProgressThreshold: threshold,
				stalledDownloadBlocklistHours: blocklistHours
			});
			toasts.success(m.toast_settings_stalledSettingsUpdated());
		} catch (e) {
			const err = e instanceof ApiError ? e.response : undefined;
			throw new Error(
				(err && typeof err === 'object' && 'error' in (err as Record<string, unknown>)
					? (err as Record<string, unknown>).error
					: m.common_failedToSave()) as string,
				{ cause: e }
			);
		}
	}}
	onClose={closeModal}
	onSave={handleSave}
	onDelete={handleDelete}
	onTest={handleTest}
	allowNntp={false}
	existingClients={data.downloadClients.map((c) => ({
		id: c.id,
		implementation: c.implementation
	}))}
/>

<ConfirmationModal
	open={confirmDeleteOpen}
	title={m.ui_modal_deleteTitle()}
	messagePrefix={m.settings_integrations_deleteConfirmPrefix()}
	messageEmphasis={deleteTarget?.name ?? m.settings_integrations_downloadClients_thisClient()}
	messageSuffix={m.settings_integrations_deleteConfirmSuffix()}
	confirmLabel={m.action_delete()}
	confirmVariant="error"
	onConfirm={handleConfirmDelete}
	onCancel={() => (confirmDeleteOpen = false)}
/>

<ConfirmationModal
	open={confirmBulkDeleteOpen}
	title={m.ui_modal_deleteTitle()}
	messagePrefix={m.settings_integrations_deleteConfirmPrefix()}
	messageEmphasis={m.settings_integrations_downloadClients_bulkDeleteCount({
		count: selectedIds.size
	})}
	messageSuffix={m.settings_integrations_deleteConfirmSuffix()}
	confirmLabel={m.action_delete()}
	confirmVariant="error"
	onConfirm={handleConfirmBulkDelete}
	onCancel={() => (confirmBulkDeleteOpen = false)}
/>
