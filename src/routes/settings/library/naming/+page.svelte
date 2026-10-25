<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import {
		CheckCircle,
		ChevronDown,
		ChevronUp,
		Download,
		FileEdit,
		Film,
		Info,
		Plus,
		RefreshCw,
		RotateCcw,
		Save,
		Settings2,
		Trash2,
		Tv,
		Wand2,
		X
	} from '@lucide/svelte';
	import type { PageData as GeneratedPageData } from './$types';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import {
		NamingFormatField,
		NamingAdvancedOptions,
		NamingReviewPanel
	} from '#lib/components/naming/index.js';
	import { FormInput, FormSelect } from '#lib/components/ui/form/index.js';
	import { ModalWrapper, ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import {
		createNormalizedNamingConfig,
		getPresetLabelById,
		normalizeNamingPresetSelection,
		serializeNamingEditorState,
		type NamingPresetSelection
	} from '#lib/naming/editor-state.js';
	import { buildConfigFromSetup, type NamingPreset } from '#lib/naming/setup-presets.js';
	import type { NamingConfigUpdate } from '#lib/validation/schemas.js';
	import {
		getNamingPresets,
		getNamingPreset,
		createNamingPreset,
		deleteNamingPreset,
		previewNaming,
		validateNamingFormats,
		updateNamingConfig,
		resetNamingConfig
	} from '#lib/api/settings.js';

	interface ValidationResult {
		valid: boolean;
		errors: Array<{ position: number; message: string; token?: string }>;
		warnings: Array<{ position: number; message: string; suggestion?: string }>;
		tokens: string[];
	}

	type PageData = GeneratedPageData & {
		presetSelection: NamingPresetSelection;
	};

	const FORMAT_FIELDS = [
		'movieFolderFormat',
		'movieFileFormat',
		'seriesFolderFormat',
		'seasonFolderFormat',
		'episodeFileFormat',
		'dailyEpisodeFormat',
		'animeEpisodeFormat'
	] as const;

	const FORMAT_FIELD_LABELS: Record<(typeof FORMAT_FIELDS)[number], string> = {
		movieFolderFormat: m.settings_naming_movieFolderFormat(),
		movieFileFormat: m.settings_naming_movieFileFormat(),
		seriesFolderFormat: m.settings_naming_seriesFolderFormat(),
		seasonFolderFormat: m.settings_naming_seasonFolderFormat(),
		episodeFileFormat: m.settings_naming_episodeFileFormat(),
		dailyEpisodeFormat: m.settings_naming_dailyEpisodeFormat(),
		animeEpisodeFormat: m.settings_naming_animeEpisodeFormat()
	};

	let { data }: { data: PageData } = $props();

	function buildSetupSignature(selection: NamingPresetSelection) {
		return `${selection.selectedServerPresetId}|${selection.selectedStylePresetId}|${selection.selectedDetailPresetId}`;
	}

	function getDraftPresetSelection(): NamingPresetSelection {
		return normalizeNamingPresetSelection({
			selectedServerPresetId,
			selectedStylePresetId,
			selectedDetailPresetId,
			selectedCustomPresetId: selectedPresetId || undefined
		});
	}

	function applyPresetSelection(selection: NamingPresetSelection) {
		selectedServerPresetId = selection.selectedServerPresetId;
		selectedStylePresetId = selection.selectedStylePresetId;
		selectedDetailPresetId = selection.selectedDetailPresetId;
		selectedPresetId = selection.selectedCustomPresetId ?? '';
		activeSetupSignature = buildSetupSignature(selection);
		setupDirty = false;
		skipNextSetupApply = false;
	}

	let config = $state(createNormalizedNamingConfig({}));
	let savedConfigSnapshot = $state(createNormalizedNamingConfig({}));
	let savedPresetSelection = $state(normalizeNamingPresetSelection());
	let saving = $state(false);
	let error = $state<string | null>(null);
	let success = $state(false);

	let previews = $state<Record<string, Record<string, string>> | null>(null);
	let loadingPreviews = $state(false);
	let validationResults = $state<Record<string, ValidationResult>>({});
	let validatingFormats = $state(false);
	let previewTimeout: ReturnType<typeof setTimeout> | undefined;

	let movieSectionOpen = $state(true);
	let seriesSectionOpen = $state(true);
	let customPresetsSectionOpen = $state(true);
	let advancedSectionOpen = $state(false);

	let activeFieldId = $state<string>('');
	let activeContext = $derived<'movie' | 'series' | 'general'>(
		activeFieldId.startsWith('movie')
			? 'movie'
			: activeFieldId.startsWith('series') ||
				  activeFieldId.startsWith('season') ||
				  activeFieldId.startsWith('episode') ||
				  activeFieldId.startsWith('daily') ||
				  activeFieldId.startsWith('anime')
				? 'series'
				: 'general'
	);

	let movieFolderField = $state<NamingFormatField | null>(null);
	let movieFileField = $state<NamingFormatField | null>(null);
	let seriesFolderField = $state<NamingFormatField | null>(null);
	let seasonFolderField = $state<NamingFormatField | null>(null);
	let episodeFileField = $state<NamingFormatField | null>(null);
	let dailyEpisodeField = $state<NamingFormatField | null>(null);
	let animeEpisodeField = $state<NamingFormatField | null>(null);

	function handleFieldFocus(id: string) {
		activeFieldId = id;
	}

	function insertToken(token: string) {
		const fieldMap: Record<string, NamingFormatField | null> = {
			movieFolderFormat: movieFolderField,
			movieFileFormat: movieFileField,
			seriesFolderFormat: seriesFolderField,
			seasonFolderFormat: seasonFolderField,
			episodeFileFormat: episodeFileField,
			dailyEpisodeFormat: dailyEpisodeField,
			animeEpisodeFormat: animeEpisodeField
		};

		const field = fieldMap[activeFieldId];
		if (field) {
			field.insertAtCursor(token);
		}
	}

	let presets = $state<NamingPreset[]>([]);
	let selectedPresetId = $state<string>('');
	let loadingPresets = $state(false);
	let showSavePresetModal = $state(false);
	let newPresetName = $state('');
	let newPresetDescription = $state('');
	let savingPreset = $state(false);
	let pendingConfirm = $state<{
		title: string;
		message: string;
		confirmLabel: string;
		confirmVariant: 'error' | 'warning' | 'primary';
		onConfirm: () => void | Promise<void>;
	} | null>(null);
	let selectedServerPresetId = $state('plex');
	let selectedStylePresetId = $state('recommended');
	let selectedDetailPresetId = $state('balanced');
	let activeSetupSignature = $state(buildSetupSignature(normalizeNamingPresetSelection()));
	let setupDirty = $state(false);
	let skipNextSetupApply = $state(false);
	let initializedFromData = $state(false);

	$effect(() => {
		if (initializedFromData) return;

		const initialSavedConfig = createNormalizedNamingConfig(data.config);
		const initialSavedPresetSelection = normalizeNamingPresetSelection(data.presetSelection);

		config = initialSavedConfig;
		savedConfigSnapshot = initialSavedConfig;
		savedPresetSelection = initialSavedPresetSelection;
		applyPresetSelection(initialSavedPresetSelection);
		initializedFromData = true;
	});

	onMount(() => {
		void loadPresets();
	});

	function applySetupPreset(forceConfirm = false) {
		if (forceConfirm && setupDirty) {
			pendingConfirm = {
				title: m.settings_naming_confirmChangePreset(),
				message: m.settings_naming_confirmChangePreset(),
				confirmLabel: m.action_confirm(),
				confirmVariant: 'warning',
				onConfirm: () => {
					pendingConfirm = null;
					applySetupPresetConfig();
				}
			};
			skipNextSetupApply = true;
			return;
		}

		applySetupPresetConfig();
	}

	function applySetupPresetConfig() {
		config = createNormalizedNamingConfig({
			...config,
			...buildConfigFromSetup({
				serverId: selectedServerPresetId,
				styleId: selectedStylePresetId,
				detailId: selectedDetailPresetId
			})
		});
		selectedPresetId = '';
		activeSetupSignature = `${selectedServerPresetId}|${selectedStylePresetId}|${selectedDetailPresetId}`;
		setupDirty = false;
		error = null;
	}

	$effect(() => {
		const nextSignature = `${selectedServerPresetId}|${selectedStylePresetId}|${selectedDetailPresetId}`;
		if (nextSignature === activeSetupSignature) return;

		if (skipNextSetupApply) {
			skipNextSetupApply = false;
			[selectedServerPresetId, selectedStylePresetId, selectedDetailPresetId] =
				activeSetupSignature.split('|');
			return;
		}

		applySetupPreset(true);
	});

	async function loadPresets() {
		loadingPresets = true;
		try {
			const result = await getNamingPresets();
			presets = (result as Record<string, unknown>).presets as NamingPreset[];
			if (selectedPresetId && !presets.some((preset) => preset.id === selectedPresetId)) {
				selectedPresetId = '';
			}
		} catch {
			// Ignore preset loading errors
		} finally {
			loadingPresets = false;
		}
	}

	async function applyCustomPreset() {
		if (!selectedPresetId) return;

		if (hasChanges) {
			pendingConfirm = {
				title: m.settings_naming_confirmLoadCustomPreset(),
				message: m.settings_naming_confirmLoadCustomPreset(),
				confirmLabel: m.action_confirm(),
				confirmVariant: 'warning',
				onConfirm: async () => {
					pendingConfirm = null;
					await loadAndApplyCustomPreset();
				}
			};
			return;
		}

		await loadAndApplyCustomPreset();
	}

	async function loadAndApplyCustomPreset() {
		try {
			error = null;
			const result = await getNamingPreset(selectedPresetId);
			const preset = (result as unknown as { preset?: { config?: Record<string, string> } }).preset;
			if (preset?.config) {
				config = createNormalizedNamingConfig({
					...config,
					...preset.config
				});
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Apply preset failed';
		}
	}

	async function saveAsPreset() {
		if (!newPresetName.trim()) return;

		savingPreset = true;
		error = null;

		try {
			await createNamingPreset({
				name: newPresetName.trim(),
				description: newPresetDescription.trim(),
				config: createNormalizedNamingConfig(config) as unknown as Record<string, unknown>
			});

			await loadPresets();
			closeSavePresetModal();
			success = true;
			setTimeout(() => (success = false), 3000);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Save preset failed';
		} finally {
			savingPreset = false;
		}
	}

	function closeSavePresetModal() {
		showSavePresetModal = false;
		newPresetName = '';
		newPresetDescription = '';
	}

	async function deletePreset(presetId: string, presetName: string) {
		pendingConfirm = {
			title: m.settings_naming_confirmDeletePreset({ name: presetName }),
			message: m.settings_naming_confirmDeletePreset({ name: presetName }),
			confirmLabel: m.action_delete(),
			confirmVariant: 'error',
			onConfirm: async () => {
				pendingConfirm = null;
				try {
					await deleteNamingPreset(presetId);

					await loadPresets();
					if (selectedPresetId === presetId) {
						selectedPresetId = '';
					}
				} catch (e) {
					error = e instanceof Error ? e.message : 'Delete preset failed';
				}
			}
		};
	}

	const customPresets = $derived(presets.filter((preset) => !preset.isBuiltIn));
	const selectedServerPreset = $derived(
		data.setupPresets.servers.find((preset) => preset.id === selectedServerPresetId)
	);
	const selectedStylePreset = $derived(
		data.setupPresets.styles.find((preset) => preset.id === selectedStylePresetId)
	);
	const selectedDetailPreset = $derived(
		data.setupPresets.details.find((preset) => preset.id === selectedDetailPresetId)
	);
	const draftPresetSelection = $derived(getDraftPresetSelection());
	const hasChanges = $derived(
		serializeNamingEditorState($state.snapshot(config), draftPresetSelection) !==
			serializeNamingEditorState(savedConfigSnapshot, savedPresetSelection)
	);
	const renameHref = $derived(
		hasChanges
			? `/settings/library/naming/rename?unsaved=1&returnTo=${encodeURIComponent(page.url.pathname)}`
			: '/settings/library/naming/rename'
	);
	const savedCustomPresetName = $derived(
		getPresetLabelById(customPresets, savedPresetSelection.selectedCustomPresetId)
	);
	const draftCustomPresetName = $derived(getPresetLabelById(customPresets, selectedPresetId));
	const invalidFormatFields = $derived(
		FORMAT_FIELDS.filter((field) => validationResults[field] && !validationResults[field].valid)
	);
	const validationWarningFields = $derived(
		FORMAT_FIELDS.filter((field) => (validationResults[field]?.warnings.length ?? 0) > 0)
	);
	const canSave = $derived(!saving && hasChanges && invalidFormatFields.length === 0);
	const movieFolderUsesBackslash = $derived(config.movieFolderFormat.includes('\\'));
	const seriesFolderUsesBackslash = $derived(
		config.seriesFolderFormat.includes('\\') || config.seasonFolderFormat.includes('\\')
	);

	$effect(() => {
		const currentSignature = `${selectedServerPresetId}|${selectedStylePresetId}|${selectedDetailPresetId}`;
		setupDirty = currentSignature === activeSetupSignature && hasChanges;
	});

	async function loadPreviews(previewConfig: PageData['config']) {
		loadingPreviews = true;
		try {
			const result = await previewNaming({ config: previewConfig } as Record<string, unknown>);
			previews = (result as Record<string, unknown>).previews as typeof previews;
		} catch {
			// Ignore preview errors
		} finally {
			loadingPreviews = false;
		}
	}

	let validationRequestId = 0;
	async function loadValidation(previewConfig: PageData['config']) {
		validatingFormats = true;
		const requestId = ++validationRequestId;
		try {
			const result = await validateNamingFormats(
				Object.fromEntries(FORMAT_FIELDS.map((field) => [field, previewConfig[field]]))
			);

			validationResults =
				((result as Record<string, unknown>).results as Record<string, ValidationResult>) ?? {};
		} catch {
			// Ignore validation errors
		} finally {
			if (requestId === validationRequestId) {
				validatingFormats = false;
			}
		}
	}
	$effect(() => {
		const previewConfig = createNormalizedNamingConfig($state.snapshot(config));
		clearTimeout(previewTimeout);
		previewTimeout = setTimeout(() => {
			void loadPreviews(previewConfig);
			void loadValidation(previewConfig);
		}, 400);

		return () => clearTimeout(previewTimeout);
	});

	async function saveConfig() {
		saving = true;
		error = null;
		success = false;

		try {
			const normalizedConfig = createNormalizedNamingConfig($state.snapshot(config));
			const presetSelection = getDraftPresetSelection();
			const result = await updateNamingConfig(
				normalizedConfig as NamingConfigUpdate,
				presetSelection
			);
			const responseData = result as unknown as {
				config: Record<string, string>;
				presetSelection: NamingPresetSelection;
			};
			savedConfigSnapshot = createNormalizedNamingConfig(responseData.config);
			savedPresetSelection = normalizeNamingPresetSelection(responseData.presetSelection);
			config = createNormalizedNamingConfig(responseData.config);
			applyPresetSelection(savedPresetSelection);
			await refreshAll();
			success = true;
			setTimeout(() => (success = false), 3000);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Save failed';
		} finally {
			saving = false;
		}
	}

	async function resetToDefaults() {
		pendingConfirm = {
			title: m.settings_naming_confirmResetDefaults(),
			message: m.settings_naming_confirmResetDefaults(),
			confirmLabel: m.action_confirm(),
			confirmVariant: 'warning',
			onConfirm: async () => {
				pendingConfirm = null;
				await performResetToDefaults();
			}
		};
	}

	async function performResetToDefaults() {
		saving = true;
		error = null;

		try {
			const result = await resetNamingConfig();

			config = createNormalizedNamingConfig(
				(result as Record<string, unknown>).config as Record<string, string>
			);
			savedConfigSnapshot = createNormalizedNamingConfig(
				(result as Record<string, unknown>).config as Record<string, string>
			);
			savedPresetSelection = normalizeNamingPresetSelection(
				(result as Record<string, unknown>).presetSelection as NamingPresetSelection
			);
			applyPresetSelection(savedPresetSelection);
			await refreshAll();
			success = true;
			setTimeout(() => (success = false), 3000);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Reset failed';
		} finally {
			saving = false;
		}
	}

	function resetField(field: keyof typeof config) {
		// @ts-expect-error - dynamic field access
		config[field] = data.defaults[field];
	}
</script>

<svelte:head>
	<title>{m.settings_naming_pageTitle()}</title>
</svelte:head>

<div class="naming-settings">
	<SettingsPage title={m.settings_naming_heading()} subtitle={m.settings_naming_subtitle()}>
		{#snippet actions()}
			<a href={renameHref} class="btn gap-2 btn-ghost btn-sm">
				<FileEdit class="h-4 w-4" />
				<span class="hidden sm:inline">{m.settings_naming_reviewRenamePlan()}</span>
				<span class="sm:hidden">{m.settings_naming_review()}</span>
			</a>
			<button class="btn gap-2 btn-ghost btn-sm" onclick={resetToDefaults} disabled={saving}>
				<RotateCcw class="h-4 w-4" />
				<span class="hidden sm:inline">{m.action_reset()}</span>
				<span class="sm:hidden">{m.action_reset()}</span>
			</button>
			<button class="btn gap-2 btn-primary btn-sm" onclick={saveConfig} disabled={!canSave}>
				{#if saving}
					<RefreshCw class="h-4 w-4 animate-spin" />
					{m.common_saving()}
				{:else if success}
					<CheckCircle class="h-4 w-4" />
					{m.settings_naming_saved()}
				{:else}
					<Save class="h-4 w-4" />
					{m.settings_naming_saveChanges()}
				{/if}
			</button>
		{/snippet}

		<!-- Alerts -->
		{#if error}
			<div class="alert alert-error">
				<span>{error}</span>
			</div>
		{/if}

		{#if hasChanges}
			<div class="alert alert-warning">
				<div class="flex items-start gap-3">
					<Info class="mt-0.5 h-5 w-5 shrink-0" />
					<div>
						<p class="font-medium">{m.settings_naming_unsavedChanges()}</p>
						<p class="text-sm opacity-90">
							{m.settings_naming_unsavedChangesDesc()}
						</p>
					</div>
				</div>
			</div>
		{/if}

		<!-- Setup Presets Card -->
		<div class="card mb-6 bg-base-200">
			<div class="card-body p-4 sm:p-5">
				<div class="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
					<div>
						<div class="flex items-center gap-2">
							<Wand2 class="h-5 w-5 text-primary" />
							<h2 class="card-title text-base">{m.settings_naming_setupPresets()}</h2>
						</div>
						<p class="mt-1 text-sm text-base-content/65">
							{m.settings_naming_setupPresetsDesc()}
						</p>
					</div>
					<div class="rounded-full bg-base-100 px-3 py-1 text-xs font-medium text-base-content/60">
						{m.settings_naming_presetsUpdateDraftOnly()}
					</div>
				</div>

				<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
					<FormSelect
						id="setupServerPreset"
						label={m.settings_naming_serverPreset()}
						bind:value={selectedServerPresetId}
						options={data.setupPresets.servers.map((preset) => ({
							value: preset.id,
							label: preset.name
						}))}
						helpText={selectedServerPreset?.description}
					/>

					<FormSelect
						id="setupStylePreset"
						label={m.settings_naming_namingStyle()}
						bind:value={selectedStylePresetId}
						options={data.setupPresets.styles.map((preset) => ({
							value: preset.id,
							label: preset.name
						}))}
						helpText={selectedStylePreset?.description}
					/>

					<FormSelect
						id="setupDetailPreset"
						label={m.settings_naming_detailLevel()}
						bind:value={selectedDetailPresetId}
						options={data.setupPresets.details.map((preset) => ({
							value: preset.id,
							label: preset.name
						}))}
						helpText={selectedDetailPreset?.description}
					/>
				</div>

				<div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
					<div class="rounded-xl border border-base-300 bg-base-100 p-3">
						<p class="text-xs font-semibold tracking-wide text-base-content/50 uppercase">
							{m.settings_naming_server()}
						</p>
						<p class="mt-1 font-medium">{selectedServerPreset?.name}</p>
						<p class="mt-1 text-sm text-base-content/65">{selectedServerPreset?.description}</p>
					</div>
					<div class="rounded-xl border border-base-300 bg-base-100 p-3">
						<p class="text-xs font-semibold tracking-wide text-base-content/50 uppercase">
							{m.settings_naming_style()}
						</p>
						<p class="mt-1 font-medium">{selectedStylePreset?.name}</p>
						<p class="mt-1 text-sm text-base-content/65">{selectedStylePreset?.description}</p>
					</div>
					<div class="rounded-xl border border-base-300 bg-base-100 p-3">
						<p class="text-xs font-semibold tracking-wide text-base-content/50 uppercase">
							{m.settings_naming_detail()}
						</p>
						<p class="mt-1 font-medium">{selectedDetailPreset?.name}</p>
						<p class="mt-1 text-sm text-base-content/65">{selectedDetailPreset?.description}</p>
					</div>
				</div>

				<div class="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-3">
					<div
						class="rounded-xl border border-base-300 bg-base-100 p-3 text-sm text-base-content/70 xl:col-span-2"
					>
						<p class="font-medium">{m.settings_naming_currentSavedSetup()}</p>
						<p class="mt-1">
							{m.settings_naming_currentSavedSetupDesc()}
						</p>
						{#if savedCustomPresetName}
							<p class="mt-2 text-xs text-base-content/55">
								{m.settings_naming_savedCustomSource()}: {savedCustomPresetName}
							</p>
						{/if}
						{#if draftCustomPresetName && draftCustomPresetName !== savedCustomPresetName}
							<p class="mt-1 text-xs text-base-content/55">
								{m.settings_naming_draftCustomSource()}: {draftCustomPresetName}
							</p>
						{/if}
					</div>
					<div
						class="rounded-xl border border-base-300 bg-base-100 p-3 text-sm text-base-content/70"
					>
						<p class="font-medium">{m.settings_naming_editorHealth()}</p>
						<p class="mt-1">
							{#if validatingFormats}
								{m.settings_naming_checkingFormats()}
							{:else if invalidFormatFields.length > 0}
								{m.settings_naming_fixInvalidFormats({ count: invalidFormatFields.length })}
							{:else if validationWarningFields.length > 0}
								{m.settings_naming_formatWarnings({ count: validationWarningFields.length })}
							{:else}
								{m.settings_naming_allFormatsValid()}
							{/if}
						</p>
					</div>
				</div>

				{#if setupDirty}
					<div
						class="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-base-content/75"
					>
						{m.settings_naming_presetDraftEdited()}
					</div>
				{/if}
			</div>
		</div>

		<!-- Custom Presets Section -->
		<div class="card mb-6 bg-base-200">
			<button
				type="button"
				class="card-body w-full p-4 text-left"
				onclick={() => (customPresetsSectionOpen = !customPresetsSectionOpen)}
				aria-expanded={customPresetsSectionOpen}
				aria-controls="custom-presets-panel"
			>
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-2">
						<Settings2 class="h-5 w-5 text-secondary" />
						<h2 class="card-title text-base">{m.settings_naming_customPresets()}</h2>
						{#if customPresets.length > 0}
							<span class="badge badge-ghost badge-sm">{customPresets.length}</span>
						{/if}
					</div>
					{#if customPresetsSectionOpen}
						<ChevronUp class="h-5 w-5" />
					{:else}
						<ChevronDown class="h-5 w-5" />
					{/if}
				</div>
			</button>
			{#if customPresetsSectionOpen}
				<div id="custom-presets-panel" class="card-body border-t border-base-300 pt-4">
					<div class="flex flex-wrap items-start gap-3">
						{#if customPresets.length > 0}
							<div class="form-control max-w-md min-w-50 flex-1">
								<select
									id="customPresetSelect"
									class="select-bordered select select-sm"
									bind:value={selectedPresetId}
									disabled={loadingPresets}
								>
									<option value="">{m.settings_naming_selectCustomPreset()}</option>
									{#each customPresets as preset (preset.id)}
										<option value={preset.id}>{preset.name}</option>
									{/each}
								</select>
								{#if selectedPresetId}
									{@const selectedPreset = customPresets.find((p) => p.id === selectedPresetId)}
									{#if selectedPreset?.description}
										<p class="mt-1 text-xs text-base-content/60">{selectedPreset.description}</p>
									{/if}
									<p class="mt-1 text-xs text-base-content/50">
										{m.settings_naming_loadPresetDraftOnly()}
									</p>
								{/if}
							</div>
							<div class="flex items-center gap-2">
								<button
									class="btn gap-1 btn-primary btn-sm"
									onclick={applyCustomPreset}
									disabled={!selectedPresetId}
								>
									<Download class="h-4 w-4" />
									{m.settings_naming_load()}
								</button>
								{#if selectedPresetId}
									<button
										class="btn gap-1 btn-ghost btn-error btn-sm"
										onclick={() => {
											const preset = customPresets.find((p) => p.id === selectedPresetId);
											if (preset) deletePreset(preset.id, preset.name);
										}}
									>
										<Trash2 class="h-4 w-4" />
									</button>
								{/if}
							</div>
						{:else}
							<p class="py-2 text-sm text-base-content/60">{m.settings_naming_noCustomPresets()}</p>
						{/if}
						<button
							class="btn ml-auto gap-1 btn-ghost btn-sm"
							onclick={() => (showSavePresetModal = true)}
						>
							<Plus class="h-4 w-4" />
							{m.settings_naming_saveCurrentAsPreset()}
						</button>
					</div>
					{#if savedCustomPresetName || draftCustomPresetName}
						<div class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
							<div
								class="rounded-xl border border-base-300 bg-base-100 p-3 text-sm text-base-content/70"
							>
								<p class="font-medium">{m.settings_naming_savedCustomSource()}</p>
								<p class="mt-1">{savedCustomPresetName ?? m.common_none()}</p>
							</div>
							<div
								class="rounded-xl border border-base-300 bg-base-100 p-3 text-sm text-base-content/70"
							>
								<p class="font-medium">{m.settings_naming_draftCustomSource()}</p>
								<p class="mt-1">{draftCustomPresetName ?? m.common_none()}</p>
							</div>
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Main Content Grid -->
		<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
			<!-- Settings Column -->
			<div class="space-y-4 lg:col-span-2">
				<!-- Movie Settings -->
				<div class="card overflow-hidden bg-base-200">
					<button
						type="button"
						class="card-body w-full p-4 text-left"
						onclick={() => (movieSectionOpen = !movieSectionOpen)}
						aria-expanded={movieSectionOpen}
						aria-controls="movie-naming-panel"
					>
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-3">
								<div class="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
									<Film class="h-5 w-5 text-primary" />
								</div>
								<div>
									<h2 class="card-title">{m.settings_naming_movieNaming()}</h2>
									<p class="text-sm text-base-content/60">{m.settings_naming_movieNamingDesc()}</p>
								</div>
							</div>
							{#if movieSectionOpen}
								<ChevronUp class="h-5 w-5" />
							{:else}
								<ChevronDown class="h-5 w-5" />
							{/if}
						</div>
					</button>
					{#if movieSectionOpen}
						<div id="movie-naming-panel" class="card-body space-y-5 border-t border-base-300 pt-4">
							<NamingFormatField
								id="movieFolderFormat"
								label={m.settings_naming_folderFormat()}
								mode="single"
								bind:this={movieFolderField}
								bind:value={config.movieFolderFormat}
								preview={previews?.movie?.folder}
								onReset={() => resetField('movieFolderFormat')}
								onFocus={handleFieldFocus}
							/>
							{#if movieFolderUsesBackslash}
								<div
									class="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-base-content/75"
								>
									<Info class="mt-0.5 h-4 w-4 shrink-0 text-warning" />
									<span
										>Backslash <code class="rounded bg-base-300 px-1 font-mono text-xs">\</code> is
										treated as an illegal character and will be <strong>stripped</strong> from
										folder names, merging the segments into one. Use
										<code class="rounded bg-base-300 px-1 font-mono text-xs">/</code> instead; it creates
										subfolders correctly on all platforms.</span
									>
								</div>
							{:else}
								<div
									class="flex items-start gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-sm text-base-content/75"
								>
									<Info class="mt-0.5 h-4 w-4 shrink-0 text-info" />
									<span
										>Use <code class="rounded bg-base-300 px-1 font-mono text-xs">/</code> to create
										subfolders; it works correctly on all platforms. Backslash
										<code class="rounded bg-base-300 px-1 font-mono text-xs">\</code> is treated as an
										illegal character and will be stripped from folder names.</span
									>
								</div>
							{/if}
							<NamingFormatField
								id="movieFileFormat"
								label={m.settings_naming_fileFormat()}
								mode="multi"
								bind:this={movieFileField}
								bind:value={config.movieFileFormat}
								preview={previews?.movie?.file}
								onReset={() => resetField('movieFileFormat')}
								onFocus={handleFieldFocus}
							/>
						</div>
					{/if}
				</div>

				<!-- Series Settings -->
				<div class="card overflow-hidden bg-base-200">
					<button
						type="button"
						class="card-body w-full p-4 text-left"
						onclick={() => (seriesSectionOpen = !seriesSectionOpen)}
						aria-expanded={seriesSectionOpen}
						aria-controls="series-naming-panel"
					>
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-3">
								<div class="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary/10">
									<Tv class="h-5 w-5 text-secondary" />
								</div>
								<div>
									<h2 class="card-title">{m.settings_naming_seriesNaming()}</h2>
									<p class="text-sm text-base-content/60">{m.settings_naming_seriesNamingDesc()}</p>
								</div>
							</div>
							{#if seriesSectionOpen}
								<ChevronUp class="h-5 w-5" />
							{:else}
								<ChevronDown class="h-5 w-5" />
							{/if}
						</div>
					</button>
					{#if seriesSectionOpen}
						<div id="series-naming-panel" class="card-body space-y-5 border-t border-base-300 pt-4">
							<NamingFormatField
								id="seriesFolderFormat"
								label={m.settings_naming_seriesFolder()}
								mode="single"
								bind:this={seriesFolderField}
								bind:value={config.seriesFolderFormat}
								preview={previews?.series?.folder}
								onReset={() => resetField('seriesFolderFormat')}
								onFocus={handleFieldFocus}
							/>
							<NamingFormatField
								id="seasonFolderFormat"
								label={m.settings_naming_seasonFolder()}
								mode="single"
								bind:this={seasonFolderField}
								bind:value={config.seasonFolderFormat}
								preview={previews?.series?.season}
								onReset={() => resetField('seasonFolderFormat')}
								onFocus={handleFieldFocus}
							/>
							{#if seriesFolderUsesBackslash}
								<div
									class="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-base-content/75"
								>
									<Info class="mt-0.5 h-4 w-4 shrink-0 text-warning" />
									<span
										>Backslash <code class="rounded bg-base-300 px-1 font-mono text-xs">\</code> is
										treated as an illegal character and will be <strong>stripped</strong> from
										folder names, merging the segments into one. Use
										<code class="rounded bg-base-300 px-1 font-mono text-xs">/</code> instead; it creates
										subfolders correctly on all platforms.</span
									>
								</div>
							{:else}
								<div
									class="flex items-start gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-sm text-base-content/75"
								>
									<Info class="mt-0.5 h-4 w-4 shrink-0 text-info" />
									<span
										>Use <code class="rounded bg-base-300 px-1 font-mono text-xs">/</code> to create
										subfolders; it works correctly on all platforms. Backslash
										<code class="rounded bg-base-300 px-1 font-mono text-xs">\</code> is treated as an
										illegal character and will be stripped from folder names.</span
									>
								</div>
							{/if}
							<NamingFormatField
								id="episodeFileFormat"
								label={m.settings_naming_standardEpisode()}
								mode="multi"
								bind:this={episodeFileField}
								bind:value={config.episodeFileFormat}
								preview={previews?.episode?.file}
								onReset={() => resetField('episodeFileFormat')}
								onFocus={handleFieldFocus}
							/>
							<NamingFormatField
								id="dailyEpisodeFormat"
								label={m.settings_naming_dailyShowEpisode()}
								mode="multi"
								bind:this={dailyEpisodeField}
								bind:value={config.dailyEpisodeFormat}
								preview={previews?.daily?.file}
								onReset={() => resetField('dailyEpisodeFormat')}
								onFocus={handleFieldFocus}
							/>
							<NamingFormatField
								id="animeEpisodeFormat"
								label={m.settings_naming_animeEpisode()}
								mode="multi"
								bind:this={animeEpisodeField}
								bind:value={config.animeEpisodeFormat}
								preview={previews?.anime?.file}
								onReset={() => resetField('animeEpisodeFormat')}
								onFocus={handleFieldFocus}
							/>
						</div>
					{/if}
				</div>

				<!-- Advanced Options -->
				<NamingAdvancedOptions {config} bind:open={advancedSectionOpen} />
			</div>

			<!-- Right Column -->
			<div class="lg:col-span-1">
				<NamingReviewPanel
					{validatingFormats}
					{loadingPreviews}
					{hasChanges}
					{invalidFormatFields}
					{validationWarningFields}
					formatFieldLabels={FORMAT_FIELD_LABELS}
					tokens={data.tokens}
					{activeFieldId}
					{activeContext}
					onInsertToken={insertToken}
				/>
			</div>
		</div>
	</SettingsPage>
</div>

<!-- Save Preset Modal -->
<ModalWrapper
	open={showSavePresetModal}
	onClose={closeSavePresetModal}
	maxWidth="md"
	labelledBy="preset-modal-title"
>
	<div class="p-6">
		<div class="mb-4 flex items-center justify-between">
			<h3 id="preset-modal-title" class="text-lg font-bold">{m.settings_naming_savePreset()}</h3>
			<button class="btn btn-square btn-ghost btn-sm" onclick={closeSavePresetModal}>
				<X class="h-4 w-4" />
			</button>
		</div>

		<div class="space-y-4">
			<FormInput
				id="newPresetName"
				label={m.settings_naming_presetName()}
				bind:value={newPresetName}
				placeholder={m.settings_naming_presetNamePlaceholder()}
				required
			/>

			<div class="form-control">
				<label class="label py-1" for="newPresetDescription">
					<span class="label-text">{m.settings_naming_descriptionOptional()}</span>
				</label>
				<textarea
					id="newPresetDescription"
					class="textarea-bordered textarea"
					placeholder={m.settings_naming_presetDescPlaceholder()}
					bind:value={newPresetDescription}></textarea>
			</div>
		</div>

		<div class="modal-action mt-6">
			<button class="btn btn-ghost" onclick={closeSavePresetModal}>{m.action_cancel()}</button>
			<button
				class="btn gap-2 btn-primary"
				onclick={saveAsPreset}
				disabled={!newPresetName.trim() || savingPreset}
			>
				{#if savingPreset}
					<RefreshCw class="h-4 w-4 animate-spin" />
					{m.common_saving()}
				{:else}
					<Save class="h-4 w-4" />
					{m.settings_naming_savePreset()}
				{/if}
			</button>
		</div>
	</div>
</ModalWrapper>

<ConfirmationModal
	open={pendingConfirm !== null}
	title={pendingConfirm?.title ?? ''}
	message={pendingConfirm?.message ?? ''}
	confirmLabel={pendingConfirm?.confirmLabel ?? m.action_confirm()}
	confirmVariant={pendingConfirm?.confirmVariant ?? 'primary'}
	onConfirm={() => {
		const fn = pendingConfirm?.onConfirm;
		if (fn) void fn();
	}}
	onCancel={() => (pendingConfirm = null)}
/>
