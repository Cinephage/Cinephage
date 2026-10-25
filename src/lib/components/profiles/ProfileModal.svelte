<script lang="ts">
	import type {
		ScoringProfile,
		ScoringProfileFormData,
		RequiredFormatEntry
	} from '#lib/types/profile.js';
	import type { FormatCategory } from '#lib/types/format.js';
	import * as m from '#lib/paraglide/messages.js';
	import { groupFormatScoresByCategory, FORMAT_CATEGORY_LABELS } from '#lib/types/format.js';
	import { X, Save, Info, Loader2, Settings, Layers, Search } from '@lucide/svelte';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { SectionHeader } from '#lib/components/ui/modal/index.js';
	import FormatScoreAccordion from './FormatScoreAccordion.svelte';

	interface Props {
		open: boolean;
		mode: 'add' | 'edit' | 'view';
		profile?: ScoringProfile | null;
		/** All profiles available to copy from (built-in + custom) */
		allProfiles: { id: string; name: string; isBuiltIn?: boolean }[];
		/** All available formats for score editing */
		allFormats?: { id: string; name: string; category: FormatCategory }[];
		defaultCopyFromId?: string;
		saving?: boolean;
		error?: string | null;
		errorPrefix?: string | null;
		errorEmphasis?: string | null;
		errorSuffix?: string | null;
		onClose: () => void;
		onSave: (data: ScoringProfileFormData) => void;
		/** Called when resetting a built-in profile's scores to defaults */
		onReset?: (profileId: string) => void;
	}

	let {
		open,
		mode,
		profile = null,
		allProfiles,
		allFormats = [],
		defaultCopyFromId = 'balanced',
		saving = false,
		error = null,
		errorPrefix = null,
		errorEmphasis = null,
		errorSuffix = null,
		onClose,
		onSave,
		onReset
	}: Props = $props();

	// Tab state
	let activeTab = $state<'general' | 'formats'>('general');
	let requiredFormats = $state<RequiredFormatEntry[]>([]);
	let requiredFormatSearch = $state('');
	// Modal title
	const modalTitle = $derived(
		mode === 'add'
			? m.profiles_createProfile()
			: profile?.isBuiltIn
				? m.profiles_editSizeLimits()
				: m.profiles_editProfile()
	);

	// Form state
	let name = $state('');
	let description = $state('');
	let copyFromId = $state<string>('');
	let upgradesAllowed = $state(true);
	let preventDowngrades = $state(true);
	// Score thresholds (enforced at grab time; both are disallowed fields on
	// built-in profiles, so they only apply to custom profiles)
	let minScore = $state(0);
	let minScoreIncrement = $state(0);
	// Media-specific size limits (string inputs to preserve cursor/editing)
	let movieMinSizeGbInput = $state('');
	let movieMaxSizeGbInput = $state('');
	let episodeMinSizeMbInput = $state('');
	let episodeMaxSizeMbInput = $state('');
	let isDefault = $state(false);
	// Format scores state
	let formatScores = $state<Record<string, number>>({});

	function coerceLimit(value: number | string | null | undefined): number | null {
		if (value === null || value === undefined) return null;
		if (typeof value === 'number') return Number.isFinite(value) ? value : null;
		const trimmed = value.trim();
		if (!trimmed) return null;
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	}

	const movieMinSizeGbValue = $derived(parseNumberInput(movieMinSizeGbInput));
	const movieMaxSizeGbValue = $derived(parseNumberInput(movieMaxSizeGbInput));
	const episodeMinSizeMbValue = $derived(parseNumberInput(episodeMinSizeMbInput));
	const episodeMaxSizeMbValue = $derived(parseNumberInput(episodeMaxSizeMbInput));

	function stringifyLimit(value: number | null | undefined): string {
		if (value === null || value === undefined) return '';
		return Number.isFinite(value) ? String(value) : '';
	}

	// Initialize form when profile changes
	$effect(() => {
		if (open) {
			if (profile) {
				name = profile.name;
				description = profile.description || '';
				copyFromId = ''; // No copy when editing existing profile
				upgradesAllowed = profile.upgradesAllowed;
				preventDowngrades = profile.preventDowngrades;
				minScore = profile.minScore ?? 0;
				minScoreIncrement = profile.minScoreIncrement ?? 0;
				movieMinSizeGbInput = stringifyLimit(coerceLimit(profile.movieMinSizeGb));
				movieMaxSizeGbInput = stringifyLimit(coerceLimit(profile.movieMaxSizeGb));
				episodeMinSizeMbInput = stringifyLimit(coerceLimit(profile.episodeMinSizeMb));
				episodeMaxSizeMbInput = stringifyLimit(coerceLimit(profile.episodeMaxSizeMb));
				isDefault = profile.isDefault;
				// Initialize format scores from profile
				formatScores = { ...(profile.formatScores ?? {}) };
				requiredFormats = [...(profile.requiredFormats ?? [])];
			} else {
				// Reset form for new profile - use provided default
				name = '';
				description = '';
				copyFromId = defaultCopyFromId;
				upgradesAllowed = true;
				preventDowngrades = true;
				minScore = 0;
				minScoreIncrement = 0;
				movieMinSizeGbInput = '';
				movieMaxSizeGbInput = '';
				episodeMinSizeMbInput = '';
				episodeMaxSizeMbInput = '';
				isDefault = false;
				// For new profiles, start with empty scores (copyFrom is handled server-side)
				formatScores = {};
				requiredFormats = [];
			}
			// Reset to General tab when opening
			activeTab = 'general';
			requiredFormatSearch = '';
		}
	});

	const maxDescriptionLength = 70;
	const descriptionTooLong = $derived(description.length > maxDescriptionLength);

	// Derived counts for tab badges and summary chip
	const scoredFormatCount = $derived(Object.values(formatScores).filter((s) => s !== 0).length);
	const requiredFormatCount = $derived(requiredFormats.length);

	// Convert Record<string, number> to Map<FormatCategory, FormatScoreEntry[]> for accordion
	const groupedFormatScores = $derived(() => {
		const enriched: Record<string, { score: number; formatName: string; formatCategory: string }> =
			{};

		for (const format of allFormats) {
			enriched[format.id] = {
				score: formatScores[format.id] ?? 0,
				formatName: format.name,
				formatCategory: format.category
			};
		}

		return groupFormatScoresByCategory(enriched);
	});

	function handleScoreChange(formatId: string, score: number) {
		formatScores = { ...formatScores, [formatId]: score };
	}

	function normalizeLimit(value: number | string | null | undefined) {
		const coerced = coerceLimit(value);
		if (coerced === null) return null;
		if (coerced === 0 || Number.isNaN(coerced)) return null;
		return coerced;
	}

	function normalizeGbLimit(value: number | string | null | undefined) {
		const coerced = normalizeLimit(value);
		if (coerced === null) return null;
		return Number(coerced.toFixed(2));
	}

	function normalizeMbLimit(value: number | string | null | undefined) {
		const coerced = normalizeLimit(value);
		if (coerced === null) return null;
		return Math.round(coerced);
	}

	function parseNumberInput(value: string): number | null {
		const trimmed = value.trim();
		if (!trimmed) return null;
		if (!/^\d*(\.\d*)?$/.test(trimmed)) return null;
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	}

	function sanitizeDecimalInput(value: string, maxDecimals: number): string {
		// Keep only digits and a single dot; enforce max decimals.
		let cleaned = '';
		let dotSeen = false;
		let decimals = 0;
		for (const ch of value) {
			if (ch >= '0' && ch <= '9') {
				if (dotSeen) {
					if (decimals >= maxDecimals) continue;
					decimals += 1;
				}
				cleaned += ch;
				continue;
			}
			if (ch === '.' && !dotSeen && maxDecimals > 0) {
				cleaned += ch;
				dotSeen = true;
			}
		}
		return cleaned;
	}

	function allowDecimalKey(event: KeyboardEvent, currentValue: string, maxDecimals: number) {
		const key = event.key;
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (
			key === 'Backspace' ||
			key === 'Delete' ||
			key === 'ArrowLeft' ||
			key === 'ArrowRight' ||
			key === 'ArrowUp' ||
			key === 'ArrowDown' ||
			key === 'Home' ||
			key === 'End' ||
			key === 'Tab'
		) {
			return;
		}
		if (key === '.') {
			if (maxDecimals === 0 || currentValue.includes('.')) {
				event.preventDefault();
			}
			return;
		}
		if (key >= '0' && key <= '9') {
			if (maxDecimals === 0 && currentValue.includes('.')) {
				event.preventDefault();
				return;
			}
			const dotIndex = currentValue.indexOf('.');
			if (dotIndex !== -1 && currentValue.length - dotIndex - 1 >= maxDecimals) {
				event.preventDefault();
				return;
			}
			return;
		}
		event.preventDefault();
	}

	function sanitizePaste(
		event: ClipboardEvent,
		setter: (value: string) => void,
		maxDecimals: number
	) {
		const text = event.clipboardData?.getData('text') ?? '';
		const cleaned = sanitizeDecimalInput(text, maxDecimals);
		if (cleaned !== text) {
			event.preventDefault();
			setter(cleaned);
		}
	}

	function handleSave() {
		if (descriptionTooLong) {
			return;
		}

		const filteredFormatScores = Object.fromEntries(
			Object.entries(formatScores).filter(([, score]) => score !== 0)
		);

		if (profile?.isBuiltIn) {
			onSave({
				preventDowngrades,
				movieMinSizeGb: normalizeGbLimit(movieMinSizeGbValue),
				movieMaxSizeGb: normalizeGbLimit(movieMaxSizeGbValue),
				episodeMinSizeMb: normalizeMbLimit(episodeMinSizeMbValue),
				episodeMaxSizeMb: normalizeMbLimit(episodeMaxSizeMbValue),
				isDefault,
				formatScores: filteredFormatScores,
				requiredFormats
			});
			return;
		}

		onSave({
			name,
			description: description || undefined,
			copyFromId: copyFromId || undefined, // Only include if creating new profile
			upgradesAllowed,
			preventDowngrades,
			minScore: minScore ?? 0,
			minScoreIncrement: minScoreIncrement ?? 0,
			movieMinSizeGb: normalizeGbLimit(movieMinSizeGbValue),
			movieMaxSizeGb: normalizeGbLimit(movieMaxSizeGbValue),
			episodeMinSizeMb: normalizeMbLimit(episodeMinSizeMbValue),
			episodeMaxSizeMb: normalizeMbLimit(episodeMaxSizeMbValue),
			isDefault,
			formatScores: filteredFormatScores,
			requiredFormats
		});
	}

	const isCoreReadonly = $derived(mode === 'view' || (profile?.isBuiltIn ?? false));
	const isFullyReadonly = $derived(mode === 'view');
	const isNewProfile = $derived(mode === 'add');
	const isStreamerProfile = $derived(profile?.id === 'streamer');

	// Show Format Scores tab for all profiles except when in view mode
	const showFormatsTab = $derived(mode !== 'view' && allFormats.length > 0);

	// Separate built-in and custom profiles for the dropdown
	const builtInProfiles = $derived(allProfiles.filter((p) => p.isBuiltIn));
	const customProfiles = $derived(allProfiles.filter((p) => !p.isBuiltIn));
</script>

<ModalWrapper {open} {onClose} maxWidth="3xl" labelledBy="profile-modal-title">
	<!-- Header -->
	<div class="mb-6 flex items-center justify-between">
		<h3 id="profile-modal-title" class="text-xl font-bold">{modalTitle}</h3>
		<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
			<X class="h-4 w-4" />
		</button>
	</div>

	{#if error}
		<div class="mb-4 alert alert-error">
			{#if errorPrefix !== null && errorEmphasis !== null && errorSuffix !== null}
				<span>{errorPrefix}<strong>{errorEmphasis}</strong>{errorSuffix}</span>
			{:else}
				<span>{error}</span>
			{/if}
		</div>
	{/if}

	<!-- Tab Navigation (only show if formats tab is available) -->
	{#if showFormatsTab}
		<div class="tabs-bordered tabs mb-6 w-full">
			<button
				type="button"
				class="tab-lg tab flex-1 gap-2"
				class:tab-active={activeTab === 'general'}
				onclick={() => (activeTab = 'general')}
			>
				<Settings class="h-4 w-4" />
				{m.profiles_tab_general()}
			</button>
			<button
				type="button"
				class="tab-lg tab flex-1 gap-2"
				class:tab-active={activeTab === 'formats'}
				onclick={() => (activeTab = 'formats')}
			>
				<Layers class="h-4 w-4" />
				{m.profiles_tab_formatScores()}
			</button>
		</div>
	{/if}

	<!-- Tab Content -->
	{#if activeTab === 'general'}
		<!-- Main Form - Responsive Two Column Layout -->
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
			<!-- Left Column: Profile Details -->
			<div class="space-y-4">
				<SectionHeader title={m.profiles_section_profile()} />

				<div class="form-control">
					<label class="label py-1" for="profile-name">
						<span class="label-text">{m.common_name()}</span>
					</label>
					<input
						id="profile-name"
						type="text"
						class="input-bordered input input-sm"
						bind:value={name}
						disabled={isCoreReadonly}
						placeholder="My Custom Profile"
					/>
				</div>

				<div class="form-control">
					<label class="label py-1" for="profile-description">
						<span class="label-text">{m.common_description()}</span>
					</label>
					<textarea
						id="profile-description"
						class="textarea-bordered textarea h-20 resize-none textarea-sm"
						bind:value={description}
						disabled={isCoreReadonly}
						maxlength={maxDescriptionLength}
						placeholder="Describe what this profile is for..."></textarea>
					{#if !isCoreReadonly}
						<div class="label py-1">
							<span class="label-text-alt text-xs {descriptionTooLong ? 'text-error' : ''}">
								{description.length}/{maxDescriptionLength}
							</span>
							{#if descriptionTooLong}
								<span class="label-text-alt text-xs text-error">
									Max {maxDescriptionLength} characters.
								</span>
							{/if}
						</div>
					{/if}
				</div>

				<!-- Copy From (only shown when creating new profile) -->
				{#if isNewProfile}
					<div class="form-control">
						<label class="label py-1" for="copy-from">
							<span class="label-text">{m.profiles_copyFrom_label()}</span>
						</label>
						<select id="copy-from" class="select-bordered select select-sm" bind:value={copyFromId}>
							<option value="">{m.profiles_copyFrom_scratch()}</option>
							{#if builtInProfiles.length > 0}
								<optgroup label={m.profiles_copyFrom_builtInLabel()}>
									{#each builtInProfiles as bp (bp.id)}
										<option value={bp.id}>{bp.name}</option>
									{/each}
								</optgroup>
							{/if}
							{#if customProfiles.length > 0}
								<optgroup label={m.profiles_copyFrom_customLabel()}>
									{#each customProfiles as cp (cp.id)}
										<option value={cp.id}>{cp.name}</option>
									{/each}
								</optgroup>
							{/if}
						</select>
						<div class="label py-1">
							<span class="label-text-alt text-xs">
								{copyFromId ? m.profiles_copyFrom_helpCopied() : m.profiles_copyFrom_helpZero()}
							</span>
						</div>
					</div>
				{/if}

				<!-- Options -->
				<div class="flex flex-wrap gap-x-4 gap-y-1 pt-2">
					<label class="label cursor-pointer gap-2">
						<input
							type="checkbox"
							class="checkbox checkbox-sm checkbox-primary"
							bind:checked={upgradesAllowed}
							disabled={isCoreReadonly}
						/>
						<span class="label-text">{m.profiles_allowUpgrades_label()}</span>
					</label>

					<label class="label cursor-pointer gap-2">
						<input
							type="checkbox"
							class="checkbox checkbox-sm checkbox-primary"
							bind:checked={preventDowngrades}
							disabled={isFullyReadonly}
						/>
						<span class="label-text">{m.profiles_preventDowngrades_label()}</span>
					</label>

					{#if !profile?.isBuiltIn}
						<label class="label cursor-pointer gap-2">
							<input
								type="checkbox"
								class="checkbox checkbox-sm checkbox-primary"
								bind:checked={isDefault}
								disabled={isFullyReadonly}
							/>
							<span class="label-text">{m.profiles_setAsDefault()}</span>
						</label>
					{/if}
				</div>
			</div>

			<!-- Right Column: Size Limits -->
			<div class="space-y-4">
				<SectionHeader title={m.profiles_section_sizeLimits()} />

				{#if isStreamerProfile}
					<div class="rounded-lg bg-base-200 p-3 text-xs text-base-content/70">
						<Info class="mr-1 inline h-3 w-3" />
						{m.profiles_streamerProfileSizeLimitsInfo()}
					</div>
				{:else}
					<div class="grid grid-cols-2 gap-2 sm:gap-3">
						<div class="form-control">
							<label class="label py-1" for="movie-min-size">
								<span class="label-text">{m.profiles_movieMinSize_label()}</span>
							</label>
							<input
								id="movie-min-size"
								type="text"
								inputmode="decimal"
								class="input-bordered input input-sm"
								value={movieMinSizeGbInput}
								oninput={(event) => {
									const target = event.currentTarget as HTMLInputElement;
									movieMinSizeGbInput = sanitizeDecimalInput(target.value, 2);
								}}
								onkeydown={(event) => allowDecimalKey(event, movieMinSizeGbInput, 2)}
								onpaste={(event) =>
									sanitizePaste(
										event,
										(value) => {
											movieMinSizeGbInput = value;
										},
										2
									)}
								disabled={isFullyReadonly}
								placeholder="No min"
							/>
						</div>

						<div class="form-control">
							<label class="label py-1" for="movie-max-size">
								<span class="label-text">{m.profiles_movieMaxSize_label()}</span>
							</label>
							<input
								id="movie-max-size"
								type="text"
								inputmode="decimal"
								class="input-bordered input input-sm"
								value={movieMaxSizeGbInput}
								oninput={(event) => {
									const target = event.currentTarget as HTMLInputElement;
									movieMaxSizeGbInput = sanitizeDecimalInput(target.value, 2);
								}}
								onkeydown={(event) => allowDecimalKey(event, movieMaxSizeGbInput, 2)}
								onpaste={(event) =>
									sanitizePaste(
										event,
										(value) => {
											movieMaxSizeGbInput = value;
										},
										2
									)}
								disabled={isFullyReadonly}
								placeholder="No max"
							/>
						</div>
					</div>

					<div class="grid grid-cols-2 gap-2 sm:gap-3">
						<div class="form-control">
							<label class="label py-1" for="episode-min-size">
								<span class="label-text">{m.profiles_episodeMinSize_label()}</span>
							</label>
							<input
								id="episode-min-size"
								type="text"
								inputmode="decimal"
								class="input-bordered input input-sm"
								value={episodeMinSizeMbInput}
								oninput={(event) => {
									const target = event.currentTarget as HTMLInputElement;
									episodeMinSizeMbInput = sanitizeDecimalInput(target.value, 0);
								}}
								onkeydown={(event) => allowDecimalKey(event, episodeMinSizeMbInput, 0)}
								onpaste={(event) =>
									sanitizePaste(
										event,
										(value) => {
											episodeMinSizeMbInput = value;
										},
										0
									)}
								disabled={isFullyReadonly}
								placeholder="No min"
							/>
							{#if episodeMinSizeMbValue}
								<div class="label py-0">
									<span class="label-text-alt text-xs">
										= {(episodeMinSizeMbValue / 1024).toFixed(2)} GB
									</span>
								</div>
							{/if}
						</div>

						<div class="form-control">
							<label class="label py-1" for="episode-max-size">
								<span class="label-text">{m.profiles_episodeMaxSize_label()}</span>
							</label>
							<input
								id="episode-max-size"
								type="text"
								inputmode="decimal"
								class="input-bordered input input-sm"
								value={episodeMaxSizeMbInput}
								oninput={(event) => {
									const target = event.currentTarget as HTMLInputElement;
									episodeMaxSizeMbInput = sanitizeDecimalInput(target.value, 0);
								}}
								onkeydown={(event) => allowDecimalKey(event, episodeMaxSizeMbInput, 0)}
								onpaste={(event) =>
									sanitizePaste(
										event,
										(value) => {
											episodeMaxSizeMbInput = value;
										},
										0
									)}
								disabled={isFullyReadonly}
								placeholder="No max"
							/>
							{#if episodeMaxSizeMbValue}
								<div class="label py-0">
									<span class="label-text-alt text-xs">
										= {(episodeMaxSizeMbValue / 1024).toFixed(2)} GB
									</span>
								</div>
							{/if}
						</div>
					</div>
				{/if}

				<SectionHeader title={m.profiles_section_scoreThresholds()} />

				<div class="grid grid-cols-2 gap-2 sm:gap-3">
					<div class="form-control">
						<label class="label py-1" for="profile-min-score">
							<span class="label-text">{m.profiles_minScore_label()}</span>
						</label>
						<input
							id="profile-min-score"
							type="number"
							step={1}
							class="input-bordered input input-sm"
							bind:value={minScore}
							disabled={isCoreReadonly}
						/>
						<div class="label py-0.5">
							<span class="label-text-alt text-xs">
								{m.profiles_minScore_desc()}
							</span>
						</div>
					</div>

					<div class="form-control">
						<label class="label py-1" for="profile-min-score-increment">
							<span class="label-text">{m.profiles_minScoreIncrement_label()}</span>
						</label>
						<input
							id="profile-min-score-increment"
							type="number"
							step={1}
							min={0}
							class="input-bordered input input-sm"
							bind:value={minScoreIncrement}
							disabled={isCoreReadonly}
						/>
						<div class="label py-0.5">
							<span class="label-text-alt text-xs">
								{m.profiles_minScoreIncrement_desc()}
							</span>
						</div>
					</div>
				</div>

				<div class="rounded-lg bg-base-200 p-3 text-xs text-base-content/70">
					<Info class="mr-1 inline h-3 w-3" />
					{m.profiles_seasonPackSizeInfo()}
				</div>
			</div>
		</div>

		{#if requiredFormatCount > 0 || scoredFormatCount > 0}
			<button
				type="button"
				class="mt-4 flex w-full items-center gap-2 rounded-lg border border-base-300 bg-base-100 px-4 py-2.5 text-sm transition-colors hover:bg-base-200"
				onclick={() => (activeTab = 'formats')}
			>
				<Layers class="h-4 w-4 text-base-content/50" />
				<span class="flex-1 text-left text-base-content/70">Format configuration</span>
				{#if scoredFormatCount > 0}
					<span class="badge badge-sm badge-primary">{scoredFormatCount} scored</span>
				{/if}
				{#if requiredFormatCount > 0}
					<span class="badge badge-sm badge-warning">{requiredFormatCount} required</span>
				{/if}
			</button>
		{/if}
	{:else if activeTab === 'formats'}
		<div class="space-y-5 py-2">
			{#if isNewProfile && copyFromId}
				<div class="alert text-sm alert-info">
					<Info class="h-4 w-4" />
					<span>
						{m.profiles_formatScoresCopyInfo()}
					</span>
				</div>
			{/if}

			<!-- Required Formats -->
			{#if allFormats.length > 0}
				<div class="rounded-lg border border-base-300 p-4">
					<p class="text-sm font-medium">Required Formats</p>
					<p class="mt-0.5 text-xs text-base-content/60">
						AND formats must all match. OR formats need at least one match. Leave empty for normal
						scoring behaviour.
					</p>

					{#if requiredFormats.length > 0}
						<div class="mt-3 flex flex-wrap gap-1.5">
							{#each requiredFormats as entry (entry.id)}
								{@const name = allFormats.find((f) => f.id === entry.id)?.name ?? entry.id}
								<span
									class="badge gap-1"
									class:badge-primary={entry.op === 'AND'}
									class:badge-warning={entry.op === 'OR'}
								>
									{#if !isFullyReadonly}
										<button
											type="button"
											class="font-mono text-xs opacity-70 hover:opacity-100"
											aria-label="Toggle operator for {name}"
											onclick={() => {
												requiredFormats = requiredFormats.map((e) =>
													e.id === entry.id ? { ...e, op: e.op === 'AND' ? 'OR' : 'AND' } : e
												);
											}}>{entry.op}</button
										>
									{:else}
										<span class="font-mono text-xs opacity-70">{entry.op}</span>
									{/if}
									{name}
									{#if !isFullyReadonly}
										<button
											type="button"
											class="opacity-70 hover:opacity-100"
											aria-label="Remove {name}"
											onclick={() => {
												requiredFormats = requiredFormats.filter((e) => e.id !== entry.id);
											}}
										>
											<svg class="h-3 w-3" viewBox="0 0 12 12" fill="currentColor"
												><path
													d="M9 3L6 6 3 3l-.7.7L5.3 6.7 2.3 9.7 3 10.4l3-3 3 3 .7-.7-3-3 3-3z"
												/></svg
											>
										</button>
									{/if}
								</span>
							{/each}
						</div>
					{/if}

					{#if !isFullyReadonly}
						{@const filteredAvailable = allFormats.filter(
							(f) =>
								!requiredFormats.some((e) => e.id === f.id) &&
								(requiredFormatSearch === '' ||
									f.name.toLowerCase().includes(requiredFormatSearch.toLowerCase()))
						)}
						<div class="mt-3 space-y-1.5">
							<div class="group relative">
								<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
									<Search
										class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
									/>
								</div>
								<input
									type="text"
									class="input w-full rounded-full border-base-content/20 bg-base-200/60 py-2 pr-4 pl-10 text-sm transition-all duration-200 placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
									placeholder="Search formats to require..."
									bind:value={requiredFormatSearch}
								/>
							</div>
							{#if requiredFormatSearch && filteredAvailable.length > 0}
								<div class="max-h-40 overflow-y-auto rounded-lg border border-base-300 bg-base-100">
									{#each filteredAvailable as format (format.id)}
										<button
											type="button"
											class="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-base-200"
											onclick={() => {
												requiredFormats = [...requiredFormats, { id: format.id, op: 'OR' }];
												requiredFormatSearch = '';
											}}
										>
											<span>{format.name}</span>
											<span class="shrink-0 text-xs text-base-content/40"
												>{FORMAT_CATEGORY_LABELS[
													format.category as keyof typeof FORMAT_CATEGORY_LABELS
												] ?? format.category}</span
											>
										</button>
									{/each}
								</div>
							{:else if requiredFormatSearch && filteredAvailable.length === 0}
								<p class="px-1 text-xs text-base-content/50">
									No formats match "{requiredFormatSearch}"
								</p>
							{/if}
						</div>
					{/if}
				</div>
				<div class="divider my-0"></div>
			{/if}

			<FormatScoreAccordion
				formatScores={groupedFormatScores()}
				{requiredFormats}
				readonly={isFullyReadonly}
				onScoreChange={handleScoreChange}
			/>
		</div>
	{/if}

	<!-- Footer -->
	<div class="modal-action mt-6 border-t border-base-300 pt-4">
		{#if profile?.isBuiltIn && mode !== 'view' && onReset}
			<button
				class="btn btn-ghost text-error"
				onclick={() => onReset(profile.id)}
				disabled={saving}
			>
				Reset scores to defaults
			</button>
		{/if}
		<div class="flex-1"></div>
		<button class="btn btn-ghost" onclick={onClose}>
			{isFullyReadonly ? m.action_close() : m.action_cancel()}
		</button>
		{#if !isFullyReadonly}
			<button
				class="btn gap-2 btn-primary"
				onclick={handleSave}
				disabled={saving || !name || descriptionTooLong}
			>
				{#if saving}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<Save class="h-4 w-4" />
				{/if}
				{m.action_save()}
			</button>
		{/if}
	</div>
</ModalWrapper>
