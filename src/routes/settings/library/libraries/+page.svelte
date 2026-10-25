<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Plus } from '@lucide/svelte';
	import { SettingsPage, SettingsSection } from '#lib/components/ui/settings/index.js';
	import { goto, refreshAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import type { PageData } from './$types';
	import { LibraryList, LibraryEditModal } from '#lib/components/libraries/index.js';
	import { ModalWrapper, ModalHeader } from '#lib/components/ui/modal/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { deleteLibrary } from '#lib/api/settings.js';
	import {
		getScanSettings,
		saveScanSettings,
		type ScanSettings
	} from '#lib/api/library-settings.js';
	import { formatBytes } from '#lib/utils/format.js';

	type RootFolderRef = {
		id: string;
		name: string;
		path: string;
		mediaType: string;
		mediaSubType?: string;
	};
	type LibraryEntity = NonNullable<PageData['libraries']>[number] & {
		rootFolders?: RootFolderRef[];
	};
	type LibraryDeleteOption = {
		targetLibraryId: string | null;
		targetLibraryName: string;
		selectionMode: 'system' | 'choose-custom' | 'none';
		customCandidates: LibraryEntity[];
	};

	let { data }: { data: PageData } = $props();

	let libraryModalOpen = $state(false);
	let editingLibraryId = $state<string | null>(null);
	let confirmLibraryDeleteOpen = $state(false);
	let deleteLibraryTarget = $state<LibraryEntity | null>(null);
	let deleteLibraryTargetOption = $state<LibraryDeleteOption | null>(null);
	let deleteLibraryDestinationId = $state<string>('');
	let deleteLibraryLoading = $state(false);

	// Scan settings (interim UI for previously-hidden librarySettings keys)
	let scanSettings = $state<ScanSettings | null>(null);
	let scanSettingsSaving = $state(false);

	onMount(() => {
		void (async () => {
			try {
				scanSettings = await getScanSettings();
			} catch {
				scanSettings = null;
			}
		})();
	});

	async function handleSaveScanSettings() {
		if (!scanSettings) return;
		scanSettingsSaving = true;
		try {
			await saveScanSettings(scanSettings);
			toasts.success(m.settings_libraries_scan_saved());
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : m.settings_libraries_scan_failed());
		} finally {
			scanSettingsSaving = false;
		}
	}

	async function clearEditQueryParam() {
		const url = new URL(page.url.href);
		if (!url.searchParams.has('edit')) return;
		url.searchParams.delete('edit');
		await goto(url.toString(), { replace: true, reset: false });
	}

	function openAddLibraryModal() {
		editingLibraryId = null;
		libraryModalOpen = true;
	}

	function openEditLibraryModal(library: LibraryEntity) {
		editingLibraryId = library.id;
		libraryModalOpen = true;
	}

	function closeLibraryModal() {
		libraryModalOpen = false;
		editingLibraryId = null;
	}

	$effect(() => {
		const editLibraryId = page.url.searchParams.get('edit');
		if (!editLibraryId || libraryModalOpen) return;
		const target = data.libraries.find((library) => library.id === editLibraryId);
		if (!target) return;
		editingLibraryId = target.id;
		libraryModalOpen = true;
		void clearEditQueryParam();
	});

	function confirmLibraryDelete(library: LibraryEntity) {
		deleteLibraryTarget = library;
		deleteLibraryDestinationId = '';
		deleteLibraryLoading = false;

		const compatibleCustomLibraries = data.libraries.filter(
			(l: LibraryEntity) =>
				l.id !== library.id &&
				l.mediaType === library.mediaType &&
				l.mediaSubType === library.mediaSubType
		);

		const systemLibrary = data.libraries.find(
			(l: LibraryEntity) => l.isSystem && l.mediaType === library.mediaType && l.id !== library.id
		);

		if (systemLibrary) {
			deleteLibraryTargetOption = {
				targetLibraryId: systemLibrary.id,
				targetLibraryName: systemLibrary.name,
				selectionMode: 'system',
				customCandidates: []
			};
		} else if (compatibleCustomLibraries.length > 0) {
			const candidate = compatibleCustomLibraries[0];
			deleteLibraryTargetOption = {
				targetLibraryId: candidate.id,
				targetLibraryName: candidate.name,
				selectionMode: 'choose-custom',
				customCandidates: compatibleCustomLibraries
			};
		} else {
			deleteLibraryTargetOption = {
				targetLibraryId: null,
				targetLibraryName: '',
				selectionMode: 'none',
				customCandidates: []
			};
		}

		confirmLibraryDeleteOpen = true;
	}

	function closeLibraryDeleteModal() {
		confirmLibraryDeleteOpen = false;
	}

	async function handleConfirmLibraryDelete() {
		if (!deleteLibraryTarget) return;
		deleteLibraryLoading = true;

		try {
			const body: Record<string, unknown> = {};
			if (deleteLibraryDestinationId) {
				body.targetLibraryId = deleteLibraryDestinationId;
			}

			await deleteLibrary(deleteLibraryTarget.id, Object.keys(body).length > 0 ? body : undefined);

			toasts.success('Library deleted');
			confirmLibraryDeleteOpen = false;
			await refreshAll();
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Failed to delete library');
		} finally {
			deleteLibraryLoading = false;
		}
	}
</script>

<svelte:head>
	<title>{m.nav_libraries()}</title>
</svelte:head>

<SettingsPage title={m.nav_libraries()} subtitle={m.settings_general_librariesDescription()}>
	{#snippet actions()}
		<button
			type="button"
			class="btn ml-auto w-full gap-2 btn-primary btn-sm sm:w-auto"
			onclick={openAddLibraryModal}
		>
			<Plus class="h-4 w-4" />
			{m.action_add()}
		</button>
	{/snippet}

	<LibraryList
		libraries={data.libraries}
		storageBreakdown={data.storage.libraryBreakdown}
		onEdit={openEditLibraryModal}
		onDelete={confirmLibraryDelete}
		{formatBytes}
	/>

	{#if scanSettings}
		<SettingsSection
			title={m.settings_libraries_scan_title()}
			description={m.settings_libraries_scan_description()}
		>
			<div class="grid gap-4 sm:grid-cols-2">
				<div class="form-control">
					<label class="label py-1" for="scan-interval">
						<span class="label-text">{m.settings_libraries_scan_interval()}</span>
					</label>
					<input
						id="scan-interval"
						type="number"
						class="input-bordered input w-full input-sm"
						bind:value={scanSettings.scanIntervalHours}
						min="1"
						max="168"
					/>
					<span class="text-xs text-base-content/60">
						{m.settings_libraries_scan_interval_hint()}
					</span>
				</div>
				<div class="form-control">
					<label class="label py-1" for="auto-match-threshold">
						<span class="label-text">{m.settings_libraries_scan_threshold()}</span>
					</label>
					<input
						id="auto-match-threshold"
						type="number"
						step="0.05"
						class="input-bordered input w-full input-sm"
						bind:value={scanSettings.autoMatchThreshold}
						min="0"
						max="1"
					/>
					<span class="text-xs text-base-content/60">
						{m.settings_libraries_scan_threshold_hint()}
					</span>
				</div>
			</div>
			<div class="mt-2 space-y-2">
				<label
					class="label cursor-pointer justify-start gap-3 rounded-lg border border-base-300 p-3"
				>
					<input
						type="checkbox"
						class="toggle toggle-primary toggle-sm"
						bind:checked={scanSettings.watchEnabled}
					/>
					<div>
						<span class="label-text text-base-content">
							{m.settings_libraries_scan_watch()}
						</span>
						<div class="text-xs whitespace-normal text-base-content/60">
							{m.settings_libraries_scan_watch_hint()}
						</div>
					</div>
				</label>
				<label
					class="label cursor-pointer justify-start gap-3 rounded-lg border border-base-300 p-3"
				>
					<input
						type="checkbox"
						class="toggle toggle-primary toggle-sm"
						bind:checked={scanSettings.scanOnStartup}
					/>
					<div>
						<span class="label-text text-base-content">
							{m.settings_libraries_scan_on_startup()}
						</span>
						<div class="text-xs whitespace-normal text-base-content/60">
							{m.settings_libraries_scan_on_startup_hint()}
						</div>
					</div>
				</label>
			</div>
			<div class="modal-action mt-4 border-t border-base-300 pt-4">
				<button
					type="button"
					class="btn btn-primary btn-sm"
					onclick={handleSaveScanSettings}
					disabled={scanSettingsSaving}
				>
					{m.settings_general_saveLibrary()}
				</button>
			</div>
		</SettingsSection>
	{/if}
</SettingsPage>

{#if confirmLibraryDeleteOpen}
	<ModalWrapper
		open={confirmLibraryDeleteOpen}
		onClose={closeLibraryDeleteModal}
		maxWidth="md"
		labelledBy="library-delete-modal-title"
	>
		<ModalHeader title={m.settings_general_confirmDelete()} onClose={closeLibraryDeleteModal} />
		<div class="space-y-4">
			<p>
				{m.settings_general_confirmDeleteMessagePrefix()}
				<strong>{deleteLibraryTarget?.name ?? ''}</strong>
				{m.settings_general_confirmDeleteMessageSuffix()}
			</p>

			{#if deleteLibraryTargetOption?.selectionMode === 'system'}
				<div class="rounded-lg border border-base-300 bg-base-200 p-3 text-sm text-base-content/80">
					{m.settings_general_attachedRootFoldersWillMoveTo()}
					<strong>{deleteLibraryTargetOption.targetLibraryName}</strong>.
				</div>
			{:else if deleteLibraryTargetOption?.selectionMode === 'choose-custom'}
				<div class="space-y-3">
					<div
						class="rounded-lg border border-base-300 bg-base-200 p-3 text-sm text-base-content/80"
					>
						{m.settings_general_attachedRootFoldersDefaultMoveTo()}
						<strong>{deleteLibraryTargetOption.targetLibraryName}</strong>.
					</div>
					<div class="space-y-2">
						<p class="text-sm text-base-content/80">
							{m.settings_general_optionalChooseCompatibleLibrary()}
						</p>
						<select
							class="select-bordered select w-full"
							bind:value={deleteLibraryDestinationId}
							disabled={deleteLibraryLoading}
						>
							<option value="">{deleteLibraryTargetOption.targetLibraryName}</option>
							{#each deleteLibraryTargetOption.customCandidates as candidate (candidate.id)}
								<option value={candidate.id}>{candidate.name}</option>
							{/each}
						</select>
					</div>
				</div>
			{/if}
		</div>
		<div class="modal-action mt-6 flex-wrap gap-2 border-t border-base-300 pt-4">
			<button
				type="button"
				class="btn btn-ghost"
				onclick={closeLibraryDeleteModal}
				disabled={deleteLibraryLoading}
			>
				{m.action_cancel()}
			</button>
			<button
				type="button"
				class="btn btn-error"
				onclick={handleConfirmLibraryDelete}
				disabled={deleteLibraryLoading}
			>
				{m.action_delete()}
			</button>
		</div>
	</ModalWrapper>
{/if}

{#if libraryModalOpen}
	<LibraryEditModal
		open={libraryModalOpen}
		libraryId={editingLibraryId}
		libraries={data.libraries}
		rootFolders={data.rootFolders}
		onClose={closeLibraryModal}
	/>
{/if}
