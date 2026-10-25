<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { AlertCircle } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { ModalWrapper, ModalHeader, ModalFooter } from '#lib/components/ui/modal/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { refreshAll } from '$app/navigation';
	import { createLibrary, updateLibrary, getScoringProfiles } from '#lib/api/settings.js';
	import { getLanguageProfiles } from '#lib/api/subtitles.js';
	import type { LibraryCreate, LibraryUpdate } from '#lib/validation/schemas.js';
	import type { RootFolderMediaType, RootFolderMediaSubType } from '#lib/types/downloadClient.js';

	type LibraryRootFolderRef = {
		id: string;
		name?: string;
		path?: string;
		mediaType?: string;
		mediaSubType?: string;
	};

	type LibraryRef = {
		id: string;
		name: string;
		mediaType: RootFolderMediaType;
		mediaSubType: RootFolderMediaSubType;
		isSystem?: boolean;
		rootFolders?: LibraryRootFolderRef[];
		defaultSearchOnAdd?: boolean | null;
		defaultWantsSubtitles?: boolean | null;
		qualityProfileId?: string | null;
		/** Library-wide subtitle language profile; null = inherit instance default */
		languageProfileId?: string | null;
	};

	type RootFolderRef = {
		id: string;
		name: string;
		path: string;
		mediaType: string;
		mediaSubType?: string;
	};

	type ProfileRef = {
		id: string;
		name: string;
		isDefault?: boolean;
	};

	type LibraryFormData = {
		name: string;
		mediaType: RootFolderMediaType;
		mediaSubType: RootFolderMediaSubType;
		rootFolderIds: string[];
		defaultSearchOnAdd: boolean;
		defaultWantsSubtitles: boolean;
		qualityProfileId: string | null;
		/** '' = inherit the instance default; persisted as null */
		languageProfileId: string;
	};

	interface Props {
		open: boolean;
		libraryId: string | null;
		libraries: LibraryRef[];
		rootFolders: RootFolderRef[];
		onClose: () => void;
	}

	let { open, libraryId, libraries, rootFolders, onClose }: Props = $props();

	let libraryForm = $state<LibraryFormData>({
		name: '',
		mediaType: 'movie',
		mediaSubType: 'standard',
		rootFolderIds: [],
		defaultSearchOnAdd: true,
		defaultWantsSubtitles: false,
		qualityProfileId: null,
		languageProfileId: ''
	});
	let librarySaving = $state(false);
	let editingLibraryLanguageProfileId = '';
	let showApplyConfirm = $state(false);
	let pendingApplyProfileId: string | null = null;
	let applyingToItems = $state(false);
	let librarySaveError = $state<string | null>(null);
	let availableProfiles = $state<ProfileRef[]>([]);
	let availableLanguageProfiles = $state<ProfileRef[]>([]);

	onMount(() => {
		void (async () => {
			try {
				const data = (await getScoringProfiles()) as unknown as {
					profiles?: Array<{ id: string; name: string; isDefault?: boolean }>;
				};
				availableProfiles = (data.profiles ?? []).map((p) => ({
					id: p.id,
					name: p.name,
					isDefault: p.isDefault ?? false
				}));
			} catch {
				availableProfiles = [];
			}
		})();
		void (async () => {
			try {
				const profiles = (await getLanguageProfiles()) as unknown as Array<{
					id: string;
					name: string;
				}>;
				availableLanguageProfiles = (profiles ?? []).map((p) => ({ id: p.id, name: p.name }));
			} catch {
				availableLanguageProfiles = [];
			}
		})();
	});

	const defaultProfileName = $derived(
		availableProfiles.find((p) => p.isDefault)?.name ?? m.common_default()
	);

	const isCreateMode = $derived(libraryId === null);
	const editingLibrary = $derived(
		!isCreateMode ? (libraries.find((l) => l.id === libraryId) ?? null) : null
	);
	const editingLibraryIsSystem = $derived(editingLibrary?.isSystem ?? false);

	const filteredLibraryRootFolders = $derived(
		rootFolders.filter(
			(folder) =>
				folder.mediaType === libraryForm.mediaType &&
				(folder.mediaSubType ?? 'standard') === libraryForm.mediaSubType
		)
	);
	const selectedLibraryRootFolderIds = $derived(new Set(libraryForm.rootFolderIds));
	const selectedLibraryRootFolderCount = $derived(selectedLibraryRootFolderIds.size);

	$effect(() => {
		if (!open) return;
		if (isCreateMode) {
			libraryForm = {
				name: '',
				mediaType: 'movie',
				mediaSubType: 'standard',
				rootFolderIds: [],
				defaultSearchOnAdd: true,
				defaultWantsSubtitles: false,
				qualityProfileId: null,
				languageProfileId: ''
			};
			librarySaveError = null;
		} else if (libraryId) {
			const library = libraries.find((l) => l.id === libraryId) ?? null;
			if (library) {
				const profileId = library.languageProfileId ?? '';
				libraryForm = {
					name: library.name,
					mediaType: library.mediaType,
					mediaSubType: library.mediaSubType,
					rootFolderIds: library.rootFolders?.map((f) => f.id) ?? [],
					defaultSearchOnAdd: library.defaultSearchOnAdd ?? true,
					defaultWantsSubtitles: library.defaultWantsSubtitles ?? false,
					qualityProfileId: library.qualityProfileId ?? null,
					languageProfileId: profileId
				};
				// Read from the row (not libraryForm) so this effect doesn't
				// depend on the state it just wrote.
				editingLibraryLanguageProfileId = profileId;
				librarySaveError = null;
			}
		}
	});

	async function saveLibrary() {
		librarySaving = true;
		librarySaveError = null;

		// '' (inherit the instance default) is persisted as null.
		const payload = {
			...libraryForm,
			languageProfileId: libraryForm.languageProfileId || null
		};

		try {
			if (isCreateMode) {
				await createLibrary(payload as LibraryCreate);
				toasts.success(m.settings_general_libraryCreated());
			} else if (libraryId) {
				await updateLibrary(libraryId, payload as LibraryUpdate);
				toasts.success(m.settings_general_libraryUpdated());
			}
			await refreshAll();

			// Offer to apply the new library default to existing items when the
			// profile assignment CHANGED (edit mode only).
			const previous = editingLibraryLanguageProfileId;
			const next = libraryForm.languageProfileId || '';
			if (!isCreateMode && previous !== next) {
				pendingApplyProfileId = next || null;
				showApplyConfirm = true;
				return; // keep the modal open until the user decides
			}
			onClose();
		} catch (error) {
			librarySaveError =
				error instanceof Error ? error.message : m.settings_general_failedToSaveLibrary();
		} finally {
			librarySaving = false;
		}
	}

	async function applyToExistingItems(): Promise<void> {
		if (!libraryId || !pendingApplyProfileId) {
			showApplyConfirm = false;
			onClose();
			return;
		}
		applyingToItems = true;
		try {
			const response = await fetch('/api/subtitles/language-profiles/bulk-assign', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mediaType: libraryForm.mediaType === 'tv' ? 'series' : 'movie',
					libraryId,
					languageProfileId: pendingApplyProfileId || null,
					clearOverrides: true
				})
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? 'Bulk assignment failed');
			}
			toasts.success(m.settings_general_libraryUpdated());
			showApplyConfirm = false;
			onClose();
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Bulk assignment failed');
		} finally {
			applyingToItems = false;
		}
	}
</script>

<ModalWrapper
	{open}
	{onClose}
	maxWidth="2xl"
	labelledBy="status-library-edit-modal-title"
	lockScroll={false}
>
	<ModalHeader
		title={isCreateMode
			? m.settings_general_libraryModalCreateTitle()
			: m.settings_general_libraryModalEditPlainTitle()}
		{onClose}
	/>
	<div class="space-y-4">
		{#if librarySaveError}
			<div class="alert alert-error">
				<AlertCircle class="h-5 w-5" />
				<span>{librarySaveError}</span>
			</div>
		{/if}

		<div class="grid gap-4 md:grid-cols-2">
			<div class="form-control">
				<label class="label py-1" for="status-library-name">
					<span class="label-text">{m.settings_general_libraryName()}</span>
				</label>
				<input
					id="status-library-name"
					class="input-bordered input input-sm {editingLibraryIsSystem ? 'input-disabled' : ''}"
					bind:value={libraryForm.name}
					disabled={editingLibraryIsSystem}
				/>
			</div>

			<div class="form-control">
				<label class="label py-1" for="status-library-media-type">
					<span class="label-text">{m.settings_general_mediaType()}</span>
				</label>
				<select
					id="status-library-media-type"
					class="select-bordered select select-sm"
					bind:value={libraryForm.mediaType}
					disabled={editingLibraryIsSystem}
				>
					<option value="movie">{m.rootFolders_movies()}</option>
					<option value="tv">{m.rootFolders_tvShows()}</option>
				</select>
			</div>

			<div class="form-control">
				<label class="label py-1" for="status-library-classification">
					<span class="label-text">{m.settings_general_classification()}</span>
				</label>
				<select
					id="status-library-classification"
					class="select-bordered select select-sm"
					bind:value={libraryForm.mediaSubType}
					disabled={editingLibraryIsSystem}
				>
					<option value="standard">{m.settings_general_standard()}</option>
					<option value="anime">{m.settings_general_badgeAnime()}</option>
				</select>
			</div>

			<div class="form-control">
				<label class="label py-1" for="status-library-quality-profile">
					<span class="label-text">{m.common_qualityProfile()}</span>
				</label>
				<select
					id="status-library-quality-profile"
					class="select-bordered select select-sm"
					bind:value={libraryForm.qualityProfileId}
				>
					<option value={null}>{defaultProfileName}</option>
					{#each availableProfiles.filter((p) => !p.isDefault) as profile (profile.id)}
						<option value={profile.id}>{profile.name}</option>
					{/each}
				</select>
			</div>

			<div class="form-control">
				<label class="label py-1" for="status-library-language-profile">
					<span class="label-text">{m.settings_general_subtitleProfile()}</span>
				</label>
				<select
					id="status-library-language-profile"
					class="select-bordered select select-sm"
					bind:value={libraryForm.languageProfileId}
				>
					<option value="">{m.settings_general_subtitleProfileInherit()}</option>
					{#each availableLanguageProfiles as profile (profile.id)}
						<option value={profile.id}>{profile.name}</option>
					{/each}
				</select>
			</div>

			<div class="form-control md:col-span-2">
				<div class="space-y-3 rounded-xl border border-base-300 bg-base-100 p-4">
					<div class="flex items-center gap-2">
						<span class="text-sm font-medium text-base-content">
							{m.settings_general_rootFoldersLabel()}
						</span>
						<span class="badge badge-ghost badge-sm">
							{m.settings_general_selectedCount({ count: selectedLibraryRootFolderCount })}
						</span>
					</div>

					<div class="max-h-64 space-y-2 overflow-y-auto pr-1">
						{#if filteredLibraryRootFolders.length === 0}
							<div
								class="flex items-start gap-3 rounded-xl border border-dashed border-base-300 bg-base-200/60 p-4"
							>
								<AlertCircle class="mt-0.5 h-4 w-4 shrink-0 text-base-content/50" />
								<div class="space-y-1 text-sm text-base-content/70">
									<div class="font-medium text-base-content">
										{m.settings_general_noMatchingRootFolders()}
									</div>
								</div>
							</div>
						{:else}
							{#each filteredLibraryRootFolders as folder (folder.id)}
								<label
									class={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors ${selectedLibraryRootFolderIds.has(folder.id) ? 'border-primary/40 bg-primary/5' : 'border-base-300 bg-base-100 hover:border-primary/30 hover:bg-base-200/40'}`}
								>
									<input
										type="checkbox"
										class="checkbox mt-1 shrink-0 checkbox-sm checkbox-primary"
										checked={selectedLibraryRootFolderIds.has(folder.id)}
										onchange={(event) => {
											const checked = (event.currentTarget as HTMLInputElement).checked;
											libraryForm.rootFolderIds = checked
												? Array.from(new Set([...libraryForm.rootFolderIds, folder.id]))
												: libraryForm.rootFolderIds.filter((id) => id !== folder.id);
										}}
									/>
									<div class="min-w-0 flex-1 space-y-0.5">
										<div class="flex flex-wrap items-center justify-between gap-2">
											<span class="font-medium text-base-content">{folder.name}</span>
											{#if selectedLibraryRootFolderIds.has(folder.id)}
												<span class="badge badge-sm badge-primary">{m.action_select()}</span>
											{/if}
										</div>
										<div class="truncate text-xs text-base-content/60">{folder.path}</div>
									</div>
								</label>
							{/each}
						{/if}
					</div>
				</div>
			</div>
		</div>

		<div class="grid gap-3 sm:grid-cols-2">
			<label class="label cursor-pointer justify-start gap-3 rounded-lg border border-base-300 p-3">
				<input
					type="checkbox"
					class="checkbox shrink-0 checkbox-sm checkbox-primary"
					bind:checked={libraryForm.defaultSearchOnAdd}
				/>
				<span class="label-text text-base-content">{m.settings_general_searchOnAddLabel()}</span>
			</label>
			<label class="label cursor-pointer justify-start gap-3 rounded-lg border border-base-300 p-3">
				<input
					type="checkbox"
					class="checkbox shrink-0 checkbox-sm checkbox-primary"
					bind:checked={libraryForm.defaultWantsSubtitles}
				/>
				<span class="label-text text-base-content">{m.settings_general_wantSubtitles()}</span>
			</label>
		</div>
	</div>
	<ModalFooter
		onCancel={onClose}
		onSave={saveLibrary}
		saving={librarySaving}
		saveLabel={m.settings_general_saveLibrary()}
		saveDisabled={!libraryForm.name.trim()}
	/>

	{#if showApplyConfirm}
		<div class="modal modal-open">
			<div class="modal-box max-w-md">
				<h3 class="text-lg font-bold">{m.library_languageProfile_applyConfirmTitle()}</h3>
				<p class="mt-2 text-sm text-base-content/70">
					{m.library_languageProfile_applyConfirmBody()}
				</p>
				<div class="modal-action">
					<button
						class="btn btn-ghost btn-sm"
						onclick={() => {
							showApplyConfirm = false;
							onClose();
						}}
					>
						{m.library_languageProfile_applySkip()}
					</button>
					<button
						class="btn btn-primary btn-sm"
						onclick={applyToExistingItems}
						disabled={applyingToItems}
					>
						{#if applyingToItems}
							<span class="loading loading-xs loading-spinner"></span>
						{/if}
						{m.library_languageProfile_applyConfirmAction()}
					</button>
				</div>
			</div>
			<button
				class="modal-backdrop cursor-default"
				aria-label="Close"
				onclick={() => {
					showApplyConfirm = false;
					onClose();
				}}
			></button>
		</div>
	{/if}
</ModalWrapper>
