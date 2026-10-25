<script lang="ts">
	import { untrack } from 'svelte';
	import { FolderSync } from '@lucide/svelte';
	import FolderBrowser from '#lib/components/library/FolderBrowser.svelte';
	import TagInput from '#lib/components/ui/TagInput.svelte';
	import { SettingsPage, SettingsSection } from '#lib/components/ui/settings/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { updateFileManagementSettings, updateSidecarSettings } from '#lib/api/settings.js';
	import { refreshAll } from '$app/navigation';
	import type { PageData } from './$types';
	import type { ImportMethod } from '#lib/validation/schemas.js';
	import { DANGEROUS_EXTENSIONS, EXECUTABLE_EXTENSIONS } from '#lib/config/constants.js';

	const BLOCKED_EXTS = new Set<string>([
		...(DANGEROUS_EXTENSIONS as readonly string[]),
		...(EXECUTABLE_EXTENSIONS as readonly string[])
	]);

	let { data }: { data: PageData } = $props();

	// Form fields intentionally capture the initial load value once — untrack
	// keeps the data reads out of the reactive graph inside $state initializers.
	let importMode = $state<ImportMethod>(untrack(() => data.settings.importMode));
	let preferHardlink = $state<boolean>(untrack(() => data.settings.preferHardlink));
	let minimumFreeSpaceGb = $state<number>(untrack(() => data.settings.minimumFreeSpaceGb));
	let deleteEmptyFolders = $state<boolean>(untrack(() => data.settings.deleteEmptyFolders));
	let recycleEnabled = $state<boolean>(untrack(() => data.settings.recycleEnabled));
	let extraFileExtensions = $state<string[]>(untrack(() => data.settings.extraFileExtensions));
	let defaultImportFolder = $state<string>(untrack(() => data.settings.defaultImportFolder ?? ''));
	let showFolderBrowser = $state(false);

	// Sidecar files (.nfo + artwork)
	let sidecar = $state(untrack(() => ({ ...data.sidecarSettings })));
	// Keyed per-field so toggling one checkbox doesn't disable/flash all the others.
	let sidecarSaving = $state<Partial<Record<keyof typeof sidecar, boolean>>>({});

	async function saveSidecar(update: Partial<typeof sidecar>) {
		const keys = Object.keys(update) as (keyof typeof sidecar)[];
		const previous = { ...sidecar };
		sidecar = { ...sidecar, ...update };
		for (const key of keys) sidecarSaving[key] = true;
		try {
			await updateSidecarSettings(update);
			if (update.enabled !== undefined) {
				toasts.success(
					update.enabled
						? m.settings_fileManagement_sidecarEnabled()
						: m.settings_fileManagement_sidecarDisabled()
				);
			}
		} catch (err) {
			sidecar = previous;
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			for (const key of keys) sidecarSaving[key] = false;
		}
	}

	// Permissions
	type PermissionsMode = 'default' | 'preserve' | 'custom';
	let permissionsMode = $state<PermissionsMode>(
		untrack(() =>
			data.settings.chmodFile
				? 'custom'
				: data.settings.preservePermissions
					? 'preserve'
					: 'default'
		)
	);
	let chmodInput = $state(untrack(() => data.settings.chmodFile));
	const chmodError = $derived(
		permissionsMode === 'custom' && !/^[0-7]{3,4}$/.test(chmodInput)
			? m.settings_fileManagement_permissionsChmodError()
			: ''
	);
	const canSave = $derived(permissionsMode !== 'custom' || !chmodError);

	let saving = $state(false);

	async function save() {
		if (!canSave) return;
		saving = true;
		try {
			const stripped = extraFileExtensions.filter((e) => BLOCKED_EXTS.has(e.toLowerCase()));
			if (stripped.length > 0) {
				extraFileExtensions = extraFileExtensions.filter((e) => !BLOCKED_EXTS.has(e.toLowerCase()));
				toasts.warning(
					`Removed blocked extensions: ${stripped.join(', ')} — these are dangerous or executable file types that can never be imported.`
				);
			}
			const preservePermissions = permissionsMode === 'preserve';
			const chmodFile = permissionsMode === 'custom' ? chmodInput : '';
			const result = (await updateFileManagementSettings({
				importMode,
				preferHardlink,
				minimumFreeSpaceGb,
				deleteEmptyFolders,
				recycleEnabled,
				extraFileExtensions,
				preservePermissions,
				chmodFile,
				autoEnabledPreserveSymlinkFolderIds: data.settings.autoEnabledPreserveSymlinkFolderIds,
				defaultImportFolder: defaultImportFolder.trim() || undefined
			})) as { autoEnabledCount?: number; autoRevertedCount?: number } | undefined;
			await refreshAll();
			toasts.success(m.settings_fileManagement_saved());
			if (result?.autoEnabledCount) {
				toasts.warning(
					m.settings_fileManagement_symlinkPreserveAutoEnabled({ count: result.autoEnabledCount })
				);
			}
			if (result?.autoRevertedCount) {
				toasts.info(
					m.settings_fileManagement_symlinkPreserveAutoReverted({ count: result.autoRevertedCount })
				);
			}
		} catch {
			toasts.error(m.settings_fileManagement_failedToSave());
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>{m.settings_fileManagement_pageTitle()}</title>
</svelte:head>

<SettingsPage
	title={m.settings_fileManagement_pageTitle()}
	subtitle={m.settings_fileManagement_pageDescription()}
>
	<SettingsSection
		title={m.settings_fileManagement_sectionTitle()}
		description={m.settings_fileManagement_sectionDescription()}
	>
		<div class="flex flex-col gap-3">
			<!-- Move option -->
			<label
				class="flex cursor-pointer items-start gap-4 rounded-lg border p-4 transition-colors
					{importMode === 'move'
					? 'border-primary bg-primary/5'
					: 'border-base-300 hover:border-base-content/30'}"
			>
				<input
					type="radio"
					name="importMode"
					value="move"
					class="radio mt-0.5 shrink-0 radio-primary"
					bind:group={importMode}
				/>
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<span class="font-medium">{m.settings_fileManagement_moveLabel()}</span>
						<span class="badge badge-sm badge-primary">Recommended</span>
					</div>
					<p class="mt-1 text-sm text-base-content/60">
						{m.settings_fileManagement_moveDesc()}
					</p>
				</div>
			</label>

			<!-- Copy option -->
			<label
				class="flex cursor-pointer items-start gap-4 rounded-lg border p-4 transition-colors
					{importMode === 'copy'
					? 'border-primary bg-primary/5'
					: 'border-base-300 hover:border-base-content/30'}"
			>
				<input
					type="radio"
					name="importMode"
					value="copy"
					class="radio mt-0.5 shrink-0 radio-primary"
					bind:group={importMode}
				/>
				<div class="min-w-0 flex-1">
					<span class="font-medium">{m.settings_fileManagement_copyLabel()}</span>
					<p class="mt-1 text-sm text-base-content/60">
						{m.settings_fileManagement_copyDesc()}
					</p>
				</div>
			</label>

			<!-- Symlink option -->
			<label
				class="flex cursor-pointer items-start gap-4 rounded-lg border p-4 transition-colors
					{importMode === 'symlink'
					? 'border-primary bg-primary/5'
					: 'border-base-300 hover:border-base-content/30'}"
			>
				<input
					type="radio"
					name="importMode"
					value="symlink"
					class="radio mt-0.5 shrink-0 radio-primary"
					bind:group={importMode}
				/>
				<div class="min-w-0 flex-1">
					<span class="font-medium">{m.settings_fileManagement_symlinkLabel()}</span>
					<p class="mt-1 text-sm text-base-content/60">
						{m.settings_fileManagement_symlinkDesc()}
					</p>
					<p class="mt-1 text-sm text-base-content/60">
						<span class="font-medium text-base-content/80"
							>{m.settings_fileManagement_symlinkDescNote()}</span
						>
					</p>
				</div>
			</label>

			<!-- Hardlink toggle -->
			<label
				class="flex cursor-pointer items-start gap-4 rounded-lg border border-base-300 p-4 transition-colors hover:border-base-content/30 {preferHardlink
					? 'border-primary bg-primary/5'
					: ''}"
			>
				<input
					type="checkbox"
					class="checkbox mt-0.5 shrink-0 checkbox-primary"
					bind:checked={preferHardlink}
				/>
				<div class="min-w-0 flex-1">
					<span class="font-medium">{m.settings_fileManagement_preferHardlinkLabel()}</span>
					<p class="mt-1 text-sm text-base-content/60">
						{m.settings_fileManagement_preferHardlinkDesc()}
					</p>
				</div>
			</label>
		</div>
	</SettingsSection>

	<SettingsSection
		title={m.settings_fileManagement_diskSpaceSectionTitle()}
		description={m.settings_fileManagement_diskSpaceSectionDescription()}
	>
		<div class="flex flex-col gap-1">
			<label class="label-text text-sm font-medium" for="minFreeSpace">
				{m.settings_fileManagement_minimumFreeSpaceLabel()}
			</label>
			<p class="mb-2 text-sm text-base-content/70">
				{m.settings_fileManagement_minimumFreeSpaceDesc()}
			</p>
			<div class="flex items-center gap-2">
				<input
					id="minFreeSpace"
					type="number"
					min="0"
					step="1"
					class="input-bordered input w-32"
					bind:value={minimumFreeSpaceGb}
				/>
				<span class="text-sm text-base-content/70">
					{m.settings_fileManagement_minimumFreeSpaceUnit()}
				</span>
			</div>
		</div>
	</SettingsSection>

	<SettingsSection
		title={m.settings_fileManagement_folderCleanupSectionTitle()}
		description={m.settings_fileManagement_folderCleanupSectionDescription()}
	>
		<label
			class="flex cursor-pointer items-start gap-4 rounded-lg border border-base-300 p-4 transition-colors hover:border-base-content/30 {deleteEmptyFolders
				? 'border-primary bg-primary/5'
				: ''}"
		>
			<input
				type="checkbox"
				class="checkbox mt-0.5 shrink-0 checkbox-primary"
				bind:checked={deleteEmptyFolders}
			/>
			<div class="min-w-0 flex-1">
				<span class="font-medium">{m.settings_fileManagement_deleteEmptyFoldersLabel()}</span>
				<p class="mt-1 text-sm text-base-content/60">
					{m.settings_fileManagement_deleteEmptyFoldersDesc()}
				</p>
			</div>
		</label>
	</SettingsSection>

	<SettingsSection
		title={m.settings_fileManagement_recycleBinSectionTitle()}
		description={m.settings_fileManagement_recycleBinSectionDescription()}
	>
		<label
			class="flex cursor-pointer items-start gap-4 rounded-lg border border-base-300 p-4 transition-colors hover:border-base-content/30 {recycleEnabled
				? 'border-primary bg-primary/5'
				: ''}"
		>
			<input
				type="checkbox"
				class="checkbox mt-0.5 shrink-0 checkbox-primary"
				bind:checked={recycleEnabled}
			/>
			<div class="min-w-0 flex-1">
				<span class="font-medium">{m.settings_fileManagement_recycleEnabledLabel()}</span>
				<p class="mt-1 text-sm text-base-content/60">
					{m.settings_fileManagement_recycleEnabledDesc()}
				</p>
			</div>
		</label>
	</SettingsSection>

	<SettingsSection
		title={m.settings_fileManagement_extraFilesSectionTitle()}
		description={m.settings_fileManagement_extraFilesSectionDescription()}
	>
		<TagInput
			bind:values={extraFileExtensions}
			label={m.settings_fileManagement_extraFilesLabel()}
			placeholder="e.g. .srt"
			hint={m.settings_fileManagement_extraFilesHint()}
			normalize={(v) => {
				const t = v.trim().toLowerCase();
				return t.startsWith('.') ? t : `.${t}`;
			}}
		/>
	</SettingsSection>

	<SettingsSection
		title={m.settings_fileManagement_sidecarSectionTitle()}
		description={m.settings_fileManagement_sidecarSectionDescription()}
	>
		{#snippet actions()}
			<input
				type="checkbox"
				class="toggle toggle-primary"
				checked={sidecar.enabled}
				disabled={sidecarSaving.enabled}
				onchange={(e) => saveSidecar({ enabled: e.currentTarget.checked })}
				aria-label={m.settings_fileManagement_sidecarSectionTitle()}
			/>
		{/snippet}

		{#if sidecar.enabled}
			<div class="mt-4 flex flex-col gap-3">
				<label class="flex cursor-pointer items-start gap-3">
					<input
						type="checkbox"
						class="checkbox mt-0.5 checkbox-primary"
						checked={sidecar.overwriteExisting}
						disabled={sidecarSaving.overwriteExisting}
						onchange={(e) => saveSidecar({ overwriteExisting: e.currentTarget.checked })}
					/>
					<span>
						<span class="block text-sm">{m.settings_fileManagement_sidecarOverwriteLabel()}</span>
						<span class="block text-xs text-base-content/60">
							{sidecar.overwriteExisting
								? m.settings_fileManagement_sidecarOverwriteHintOn()
								: m.settings_fileManagement_sidecarOverwriteHintOff()}
						</span>
					</span>
				</label>

				<label class="flex cursor-pointer items-start gap-3">
					<input
						type="checkbox"
						class="checkbox mt-0.5 checkbox-primary"
						checked={sidecar.includeArtwork}
						disabled={sidecarSaving.includeArtwork}
						onchange={(e) => saveSidecar({ includeArtwork: e.currentTarget.checked })}
					/>
					<span>
						<span class="block text-sm">{m.settings_fileManagement_sidecarArtworkLabel()}</span>
						<span class="block text-xs text-base-content/60"
							>{m.settings_fileManagement_sidecarArtworkHint()}</span
						>
					</span>
				</label>

				<p class="text-xs text-base-content/60">
					{sidecar.includeArtwork
						? m.settings_fileManagement_sidecarMovieNoteWithArtwork()
						: m.settings_fileManagement_sidecarMovieNoteNfoOnly()}
				</p>

				<div class="mt-2">
					<span class="block text-sm font-medium"
						>{m.settings_fileManagement_sidecarTvLevelsLabel()}</span
					>
					<span class="mb-2 block text-xs text-base-content/60"
						>{m.settings_fileManagement_sidecarTvLevelsHint()}</span
					>
					<div class="flex flex-col gap-2 sm:flex-row sm:gap-6">
						<label class="flex cursor-pointer items-center gap-2">
							<input
								type="checkbox"
								class="checkbox checkbox-sm checkbox-primary"
								checked={sidecar.tvSeriesLevel}
								disabled={sidecarSaving.tvSeriesLevel}
								onchange={(e) => saveSidecar({ tvSeriesLevel: e.currentTarget.checked })}
							/>
							<span class="text-sm">
								{sidecar.includeArtwork
									? m.settings_fileManagement_sidecarTvSeriesLabelWithArtwork()
									: m.settings_fileManagement_sidecarTvSeriesLabelNfoOnly()}
							</span>
						</label>
						<label class="flex cursor-pointer items-center gap-2">
							<input
								type="checkbox"
								class="checkbox checkbox-sm checkbox-primary"
								checked={sidecar.tvSeasonLevel}
								disabled={sidecarSaving.tvSeasonLevel}
								onchange={(e) => saveSidecar({ tvSeasonLevel: e.currentTarget.checked })}
							/>
							<span class="text-sm">
								{sidecar.includeArtwork
									? m.settings_fileManagement_sidecarTvSeasonLabelWithArtwork()
									: m.settings_fileManagement_sidecarTvSeasonLabelNfoOnly()}
							</span>
						</label>
						<label class="flex cursor-pointer items-center gap-2">
							<input
								type="checkbox"
								class="checkbox checkbox-sm checkbox-primary"
								checked={sidecar.tvEpisodeLevel}
								disabled={sidecarSaving.tvEpisodeLevel}
								onchange={(e) => saveSidecar({ tvEpisodeLevel: e.currentTarget.checked })}
							/>
							<span class="text-sm">{m.settings_fileManagement_sidecarTvEpisodeLabel()}</span>
						</label>
					</div>
				</div>
			</div>
		{/if}
	</SettingsSection>

	<SettingsSection
		title={m.settings_fileManagement_permissionsSectionTitle()}
		description={m.settings_fileManagement_permissionsSectionDescription()}
	>
		<div class="flex flex-col gap-3">
			<!-- Default -->
			<label
				class="flex cursor-pointer items-start gap-4 rounded-lg border p-4 transition-colors {permissionsMode ===
				'default'
					? 'border-primary bg-primary/5'
					: 'border-base-300 hover:border-base-content/30'}"
			>
				<input
					type="radio"
					name="permissionsMode"
					value="default"
					class="radio mt-0.5 shrink-0 radio-primary"
					bind:group={permissionsMode}
				/>
				<div class="min-w-0 flex-1">
					<span class="font-medium">{m.settings_fileManagement_permissionsDefaultLabel()}</span>
					<p class="mt-1 text-sm text-base-content/60">
						{m.settings_fileManagement_permissionsDefaultDesc()}
					</p>
				</div>
			</label>

			<!-- Preserve source -->
			<label
				class="flex cursor-pointer items-start gap-4 rounded-lg border p-4 transition-colors {permissionsMode ===
				'preserve'
					? 'border-primary bg-primary/5'
					: 'border-base-300 hover:border-base-content/30'}"
			>
				<input
					type="radio"
					name="permissionsMode"
					value="preserve"
					class="radio mt-0.5 shrink-0 radio-primary"
					bind:group={permissionsMode}
				/>
				<div class="min-w-0 flex-1">
					<span class="font-medium">{m.settings_fileManagement_permissionsPreserveLabel()}</span>
					<p class="mt-1 text-sm text-base-content/60">
						{m.settings_fileManagement_permissionsPreserveDesc()}
					</p>
				</div>
			</label>

			<!-- Custom chmod -->
			<label
				class="flex cursor-pointer items-start gap-4 rounded-lg border p-4 transition-colors {permissionsMode ===
				'custom'
					? 'border-primary bg-primary/5'
					: 'border-base-300 hover:border-base-content/30'}"
			>
				<input
					type="radio"
					name="permissionsMode"
					value="custom"
					class="radio mt-0.5 shrink-0 radio-primary"
					bind:group={permissionsMode}
				/>
				<div class="min-w-0 flex-1">
					<span class="font-medium">{m.settings_fileManagement_permissionsCustomLabel()}</span>
					<p class="mt-1 text-sm text-base-content/60">
						{m.settings_fileManagement_permissionsCustomDesc()}
					</p>
					{#if permissionsMode === 'custom'}
						<div class="mt-3">
							<input
								type="text"
								class="input-bordered input w-32 font-mono {chmodError ? 'input-error' : ''}"
								placeholder={m.settings_fileManagement_permissionsChmodPlaceholder()}
								bind:value={chmodInput}
							/>
							{#if chmodError}
								<p class="mt-1 text-sm text-error">{chmodError}</p>
							{/if}
						</div>
					{/if}
				</div>
			</label>
		</div>
	</SettingsSection>

	<SettingsSection
		title={m.settings_fileManagement_defaultImportFolderSectionTitle()}
		description={m.settings_fileManagement_defaultImportFolderSectionDescription()}
	>
		<div class="flex flex-col gap-1">
			<label class="label-text text-sm font-medium" for="defaultImportFolder">
				{m.settings_fileManagement_defaultImportFolderLabel()}
			</label>
			<p class="mb-2 text-sm text-base-content/70">
				{m.settings_fileManagement_defaultImportFolderDesc()}
			</p>
			<div class="flex items-center gap-2">
				<input
					id="defaultImportFolder"
					type="text"
					class="input-bordered input flex-1"
					placeholder={m.settings_fileManagement_defaultImportFolderPlaceholder()}
					bind:value={defaultImportFolder}
				/>
				<button
					type="button"
					class="btn btn-outline btn-sm"
					onclick={() => (showFolderBrowser = !showFolderBrowser)}
				>
					{m.settings_fileManagement_defaultImportFolderBrowse()}
				</button>
				{#if defaultImportFolder}
					<button
						type="button"
						class="btn btn-ghost btn-sm"
						onclick={() => {
							defaultImportFolder = '';
							showFolderBrowser = false;
						}}
					>
						{m.settings_fileManagement_defaultImportFolderClear()}
					</button>
				{/if}
			</div>
			{#if showFolderBrowser}
				<div class="mt-3">
					<FolderBrowser
						value={defaultImportFolder || '/'}
						onSelect={(path) => {
							defaultImportFolder = path;
							showFolderBrowser = false;
						}}
						onCancel={() => (showFolderBrowser = false)}
					/>
				</div>
			{/if}
		</div>
	</SettingsSection>

	<div class="flex justify-end">
		<button class="btn btn-primary" onclick={save} disabled={saving || !canSave}>
			{#if saving}
				<span class="loading loading-sm loading-spinner"></span>
			{:else}
				<FolderSync class="h-4 w-4" />
			{/if}
			Save
		</button>
	</div>
</SettingsPage>
