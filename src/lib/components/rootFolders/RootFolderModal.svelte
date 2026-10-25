<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Loader2, CheckCircle2, XCircle, FolderOpen, Info } from '@lucide/svelte';
	import type {
		RootFolder,
		RootFolderFormData,
		PathValidationResult
	} from '#lib/types/downloadClient.js';
	import { FolderBrowser } from '#lib/components/library/index.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import ModalHeader from '#lib/components/ui/modal/ModalHeader.svelte';
	import ModalFooter from '#lib/components/ui/modal/ModalFooter.svelte';
	import TagInput from '#lib/components/ui/TagInput.svelte';

	interface Props {
		open: boolean;
		mode: 'add' | 'edit';
		folder?: RootFolder | null;
		saving: boolean;
		error?: string | null;
		onClose: () => void;
		behindSidebarOnDesktop?: boolean;
		lockScroll?: boolean;
		symlinkModeEnabled?: boolean;
		onSave: (data: RootFolderFormData) => void;
		onValidatePath: (
			path: string,
			readOnly?: boolean,
			folderId?: string
		) => Promise<PathValidationResult>;
	}

	let {
		open,
		mode,
		folder = null,
		saving,
		error = null,
		onClose,
		behindSidebarOnDesktop = false,
		lockScroll = true,
		symlinkModeEnabled = false,
		onSave,
		onValidatePath
	}: Props = $props();

	// Form state (defaults only, effect syncs from props)
	let name = $state('');
	let path = $state('');
	let mediaType = $state<'movie' | 'tv'>('movie');
	let mediaSubType = $state<'standard' | 'anime'>('standard');
	let isDefault = $state(false);
	let readOnly = $state(false);
	let preserveSymlinks = $state(false);
	let defaultMonitored = $state(true);
	let skipFolderPatterns = $state<string[]>([]);
	let blockedVideoExtensions = $state<string[]>([]);

	// UI state
	let validating = $state(false);
	let validationResult = $state<PathValidationResult | null>(null);
	let showFolderBrowser = $state(false);

	// Derived
	const modalTitle = $derived(
		mode === 'add' ? m.rootFolders_addTitle() : m.rootFolders_editTitle()
	);
	const defaultScopeLabel = $derived.by(() => {
		const mediaLabel = mediaType === 'movie' ? 'Movies' : 'TV Shows';
		const subtypeLabel = mediaSubType === 'anime' ? 'Anime' : 'Standard';
		return `${subtypeLabel} ${mediaLabel}`;
	});

	// Reset form when modal opens or folder changes
	$effect(() => {
		if (open) {
			name = folder?.name ?? '';
			path = folder?.path ?? '';
			mediaType = folder?.mediaType ?? 'movie';
			mediaSubType = folder?.mediaSubType ?? 'standard';
			isDefault = folder?.isDefault ?? false;
			readOnly = folder?.readOnly ?? false;
			preserveSymlinks = folder?.preserveSymlinks ?? false;
			defaultMonitored = folder?.defaultMonitored ?? true;
			skipFolderPatterns = folder?.skipFolderPatterns ?? [];
			blockedVideoExtensions = folder?.blockedVideoExtensions ?? [];
			validationResult = null;
			showFolderBrowser = false;
		}
	});

	function getFormData(): RootFolderFormData {
		return {
			name,
			path,
			mediaType,
			mediaSubType,
			isDefault,
			readOnly,
			preserveSymlinks,
			defaultMonitored,
			skipFolderPatterns,
			blockedVideoExtensions
		};
	}

	async function handleValidatePath() {
		if (!path) return;

		validating = true;
		validationResult = null;
		try {
			validationResult = await onValidatePath(path, readOnly, folder?.id ?? undefined);
		} finally {
			validating = false;
		}
	}

	function handleSave() {
		onSave(getFormData());
	}

	function handleFolderSelect(selectedPath: string) {
		path = selectedPath;
		showFolderBrowser = false;
		// Auto-validate after selection
		handleValidatePath();
	}
</script>

<ModalWrapper
	{open}
	{onClose}
	maxWidth="2xl"
	labelledBy="root-folder-modal-title"
	{behindSidebarOnDesktop}
	{lockScroll}
>
	<ModalHeader title={modalTitle} {onClose} />

	<!-- Folder Browser -->
	{#if showFolderBrowser}
		<FolderBrowser
			value={path || '/'}
			onSelect={handleFolderSelect}
			onCancel={() => (showFolderBrowser = false)}
		/>
	{:else}
		<!-- Form -->
		<div class="root-folder-editor space-y-4">
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
				<div class="form-control">
					<label class="label py-1" for="name">
						<span class="label-text">Name</span>
					</label>
					<input
						id="name"
						type="text"
						class="input-bordered input input-sm"
						bind:value={name}
						placeholder={m.rootFolders_namePlaceholder()}
					/>
				</div>

				<div class="form-control">
					<label class="label py-1" for="mediaType">
						<span class="label-text">{m.rootFolders_mediaTypeLabel()}</span>
					</label>
					<select id="mediaType" class="select-bordered select select-sm" bind:value={mediaType}>
						<option value="movie">{m.rootFolders_movies()}</option>
						<option value="tv">{m.rootFolders_tvShows()}</option>
					</select>
				</div>

				<div class="form-control">
					<label class="label py-1" for="mediaSubType">
						<span class="label-text">Library Subtype</span>
					</label>
					<select
						id="mediaSubType"
						class="select-bordered select select-sm"
						bind:value={mediaSubType}
					>
						<option value="standard">Standard</option>
						<option value="anime">Anime</option>
					</select>
				</div>
			</div>

			<div class="form-control">
				<label class="label py-1" for="path">
					<span class="label-text">{m.rootFolders_pathLabel()}</span>
				</label>
				<div class="flex gap-2">
					<div class="join flex-1">
						<input
							id="path"
							type="text"
							class="input-bordered input join-item flex-1 input-sm"
							bind:value={path}
							placeholder={m.rootFolders_pathPlaceholder()}
						/>
						<button
							type="button"
							class="btn join-item border border-base-300 btn-ghost btn-sm"
							onclick={() => (showFolderBrowser = true)}
							title={m.rootFolders_browseFolders()}
						>
							<FolderOpen class="h-4 w-4" />
						</button>
					</div>
					<button
						class="btn btn-ghost btn-sm"
						onclick={handleValidatePath}
						disabled={validating || !path}
					>
						{#if validating}
							<Loader2 class="h-4 w-4 animate-spin" />
						{/if}
						{m.rootFolders_validate()}
					</button>
				</div>
				<div class="label py-1">
					<span class="label-text-alt text-xs">
						{m.rootFolders_pathHint()}
					</span>
				</div>
			</div>

			<label class="flex cursor-pointer items-center gap-3 py-2">
				<input
					type="checkbox"
					class="checkbox shrink-0 checkbox-sm checkbox-primary"
					bind:checked={isDefault}
				/>
				<span class="text-sm"
					>{m.rootFolders_setAsDefault({
						mediaType: defaultScopeLabel
					})}</span
				>
			</label>

			<label class="flex cursor-pointer items-center gap-3 py-2">
				<input
					type="checkbox"
					class="checkbox shrink-0 checkbox-sm checkbox-primary"
					bind:checked={readOnly}
				/>
				<span class="text-sm">{m.rootFolders_readOnlyLabel()}</span>
			</label>

			<label
				class="flex cursor-pointer items-center gap-3 py-2 {symlinkModeEnabled ? 'opacity-60' : ''}"
			>
				<input
					type="checkbox"
					class="checkbox shrink-0 checkbox-sm checkbox-primary"
					bind:checked={preserveSymlinks}
					disabled={symlinkModeEnabled}
				/>
				<span class="text-sm">{m.rootFolders_preserveSymlinksLabel()}</span>
				{#if symlinkModeEnabled}
					<span class="badge badge-sm badge-warning"
						>{m.rootFolders_preserveSymlinksLockedBadge()}</span
					>
				{/if}
			</label>
			{#if symlinkModeEnabled}
				<p class="ml-7 text-xs text-base-content/60">
					{m.rootFolders_preserveSymlinksLockedHint()}
				</p>
			{/if}

			<label class="flex cursor-pointer items-center gap-3 py-2">
				<input
					type="checkbox"
					class="checkbox shrink-0 checkbox-sm checkbox-primary"
					bind:checked={defaultMonitored}
				/>
				<span class="min-w-0 text-sm">{m.rootFolders_monitorNewContent()}</span>
				<button
					type="button"
					class="tooltip btn tooltip-right shrink-0 btn-ghost btn-xs"
					data-tip={m.rootFolders_monitorNewContentTooltip()}
					onclick={(e) => e.stopPropagation()}
					aria-label="More information about monitor new content"
				>
					<Info class="h-3.5 w-3.5 shrink-0 text-base-content/50" aria-hidden="true" />
				</button>
			</label>

			<div class="divider my-1 text-xs text-base-content/40">Scan Filters</div>

			<TagInput
				bind:values={skipFolderPatterns}
				label="Skip Folder Patterns"
				placeholder="e.g. backdrops"
				hint="Folder names to ignore during scan (case-insensitive). Common Jellyfin artifacts: backdrops, extrafanart, .actors"
			/>

			<TagInput
				bind:values={blockedVideoExtensions}
				label="Blocked Video Extensions"
				placeholder="e.g. .webm"
				hint="Video file extensions to exclude from import scanning (e.g. .webm, .mp4)."
				normalize={(v) => {
					const t = v.trim().toLowerCase();
					return t.startsWith('.') ? t : `.${t}`;
				}}
			/>

			{#if preserveSymlinks}
				<div class="alert alert-info">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
						class="h-6 w-6 shrink-0 stroke-current"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
						></path>
					</svg>
					<div>
						<div class="font-medium">{m.rootFolders_symlinkAlertTitle()}</div>
						<div class="text-sm opacity-80">
							{m.rootFolders_symlinkAlertDesc()}
						</div>
					</div>
				</div>
			{/if}

			{#if readOnly}
				<div class="alert alert-info">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
						class="h-6 w-6 shrink-0 stroke-current"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
						></path>
					</svg>
					<div>
						<div class="font-medium">{m.rootFolders_readOnlyAlertTitle()}</div>
						<div class="text-sm opacity-80">
							{m.rootFolders_readOnlyAlertDesc()}
						</div>
					</div>
				</div>
			{/if}

			<!-- Save Error -->
			{#if error}
				<div class="alert alert-error">
					<XCircle class="h-5 w-5" />
					<div>
						<div class="font-medium">{m.rootFolders_saveFailed()}</div>
						<div class="text-sm opacity-80">{error}</div>
					</div>
				</div>
			{/if}

			<!-- Validation Result -->
			{#if validationResult}
				<div class="alert {validationResult.valid ? 'alert-success' : 'alert-error'}">
					{#if validationResult.valid}
						<CheckCircle2 class="h-5 w-5" />
						<div>
							<div class="font-medium">
								{readOnly ? m.rootFolders_pathReadable() : m.rootFolders_pathValid()}
							</div>
							{#if validationResult.freeSpaceFormatted}
								<div class="text-sm opacity-80">
									{m.rootFolders_freeSpace({ space: validationResult.freeSpaceFormatted })}
								</div>
							{:else if readOnly}
								<div class="text-sm opacity-80">{m.rootFolders_freeSpaceNa()}</div>
							{/if}
						</div>
					{:else}
						<XCircle class="h-5 w-5" />
						<div>
							<div class="font-medium">{m.rootFolders_validationFailed()}</div>
							<div class="text-sm opacity-80">{validationResult.error}</div>
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<ModalFooter
			onCancel={onClose}
			onSave={handleSave}
			{saving}
			saveLabel={m.action_save()}
			saveDisabled={saving || !path || !name}
		/>
	{/if}
</ModalWrapper>
