<script lang="ts">
	import type {
		ScoringProfile,
		ScoringProfileFormData,
		RequiredFormatEntry,
		ProfileMusicTier
	} from '#lib/types/profile.js';
	import type { FormatCategory } from '#lib/types/format.js';
	import * as m from '#lib/paraglide/messages.js';
	import { groupFormatScoresByCategory, FORMAT_CATEGORY_LABELS } from '#lib/types/format.js';
	import {
		X,
		Save,
		Info,
		Loader2,
		Settings,
		Layers,
		Search,
		Server,
		ArrowDown,
		ArrowUp,
		Plus,
		Trash2
	} from '@lucide/svelte';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { SectionHeader } from '#lib/components/ui/modal/index.js';
	import FormatScoreAccordion from './FormatScoreAccordion.svelte';
	import { handleTablistKeydown } from '#lib/utils/tabs.js';

	/** A configured indexer, as offered in the profile indexer picker. */
	export interface ProfileIndexerOption {
		id: string;
		name: string;
		protocol: 'torrent' | 'usenet' | 'streaming';
		enabled: boolean;
	}

	interface Props {
		open: boolean;
		mode: 'add' | 'edit' | 'view';
		/** Which kind of profile this dialog edits. Music uses the same shell. */
		mediaKind?: 'video' | 'music';
		profile?: ScoringProfile | null;
		/** All profiles available to copy from (built-in + custom) */
		allProfiles: {
			id: string;
			name: string;
			isBuiltIn?: boolean;
			musicTiers?: ProfileMusicTier[];
			allowFallback?: boolean;
			musicMinSizeMb?: number | null;
			musicMaxSizeMb?: number | null;
		}[];
		/** All available formats for score editing */
		allFormats?: { id: string; name: string; category: FormatCategory }[];
		/** Configured indexers available for the profile's indexer allowlist */
		indexers?: ProfileIndexerOption[];
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
		mediaKind = 'video',
		profile = null,
		allProfiles,
		allFormats = [],
		indexers = [],
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
	type ProfileTab = 'general' | 'formats' | 'indexers';
	let activeTab = $state<ProfileTab>('general');
	// Unique per dialog instance, for the tab/tabpanel id wiring.
	const uid = $props.id();
	let requiredFormats = $state<RequiredFormatEntry[]>([]);
	let requiredFormatSearch = $state('');
	// Modal title
	const modalTitle = $derived(
		mode === 'add' ? m.profiles_createProfile() : m.profiles_editProfile()
	);

	// Form state
	let name = $state('');
	let description = $state('');
	let copyFromId = $state<string>('');
	let upgradesAllowed = $state(true);
	let preventDowngrades = $state(true);
	// Score thresholds (enforced at grab time; editable on every profile)
	let minScore = $state(0);
	let minScoreIncrement = $state(0);
	// Media-specific size limits (string inputs to preserve cursor/editing)
	let movieMinSizeGbInput = $state('');
	let movieMaxSizeGbInput = $state('');
	let episodeMinSizeMbInput = $state('');
	let episodeMaxSizeMbInput = $state('');
	let isDefault = $state(false);
	// Indexer allowlist: null = all indexers, array = only these
	let allowedIndexerIds = $state<string[] | null>(null);
	// Format scores state
	let formatScores = $state<Record<string, number>>({});

	// --- Music ladder (same dialog, music mode) ---
	const isMusic = $derived(mediaKind === 'music');
	type TierDraft = {
		kind: ProfileMusicTier['kind'];
		label: string;
		formats: string;
		minBitrateKbps: string;
		minBitDepth: string;
	};
	let musicTiers = $state<TierDraft[]>([]);
	let allowFallback = $state(true);
	let musicMinSizeMbInput = $state('');
	let musicMaxSizeMbInput = $state('');

	function toTierDraft(tier: ProfileMusicTier): TierDraft {
		return {
			kind: tier.kind,
			label: tier.label,
			formats: (tier.formats ?? []).join(', '),
			minBitrateKbps: tier.minBitrateKbps ? String(tier.minBitrateKbps) : '',
			minBitDepth: tier.minBitDepth ? String(tier.minBitDepth) : ''
		};
	}

	function blankTier(kind: TierDraft['kind'] = 'lossless'): TierDraft {
		return { kind, label: '', formats: '', minBitrateKbps: '', minBitDepth: '' };
	}

	function addTier() {
		musicTiers = [...musicTiers, blankTier('lossy')];
	}

	function removeTier(index: number) {
		musicTiers = musicTiers.filter((_, i) => i !== index);
	}

	function moveTier(index: number, direction: -1 | 1) {
		const next = [...musicTiers];
		const target = index + direction;
		if (target < 0 || target >= next.length) return;
		[next[index], next[target]] = [next[target], next[index]];
		musicTiers = next;
	}

	function validOptionalInteger(value: string): boolean {
		const trimmed = value.trim();
		return trimmed === '' || /^\d+$/.test(trimmed);
	}

	function musicTierPayload(): ProfileMusicTier[] {
		return musicTiers.map((tier) => ({
			kind: tier.kind,
			label: tier.label.trim(),
			...(tier.kind !== 'streaming' && tier.formats.trim()
				? {
						formats: tier.formats
							.split(',')
							.map((format) => format.trim().toLowerCase())
							.filter(Boolean)
					}
				: {}),
			...(tier.kind === 'lossy' && tier.minBitrateKbps.trim()
				? { minBitrateKbps: Number.parseInt(tier.minBitrateKbps, 10) }
				: {}),
			...(tier.kind === 'lossless' && tier.minBitDepth.trim()
				? { minBitDepth: Number.parseInt(tier.minBitDepth, 10) }
				: {})
		}));
	}

	const musicTiersValid = $derived(
		musicTiers.length > 0 &&
			musicTiers.every(
				(tier) =>
					tier.label.trim().length > 0 &&
					(tier.kind !== 'lossy' || validOptionalInteger(tier.minBitrateKbps)) &&
					(tier.kind !== 'lossless' || validOptionalInteger(tier.minBitDepth))
			)
	);

	/** The same "Copy from" control as video; for music it seeds the ladder. */
	function applyCopyFrom() {
		if (!isMusic || !copyFromId) return;
		const source = allProfiles.find((candidate) => candidate.id === copyFromId);
		if (!source) return;
		musicTiers = (source.musicTiers ?? []).map(toTierDraft);
		allowFallback = source.allowFallback ?? true;
		musicMinSizeMbInput = source.musicMinSizeMb ? String(source.musicMinSizeMb) : '';
		musicMaxSizeMbInput = source.musicMaxSizeMb ? String(source.musicMaxSizeMb) : '';
	}

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
			if (isMusic) {
				if (profile) {
					name = profile.name;
					description = profile.description || '';
					copyFromId = '';
					musicTiers = (profile.musicTiers ?? []).map(toTierDraft);
					allowFallback = profile.allowFallback ?? true;
					musicMinSizeMbInput = stringifyLimit(coerceLimit(profile.musicMinSizeMb));
					musicMaxSizeMbInput = stringifyLimit(coerceLimit(profile.musicMaxSizeMb));
					isDefault = profile.isDefault;
				} else {
					name = '';
					description = '';
					copyFromId = defaultCopyFromId || '';
					musicTiers = [blankTier('lossless')];
					allowFallback = true;
					musicMinSizeMbInput = '';
					musicMaxSizeMbInput = '';
					isDefault = false;
					// Same starting point as a video profile: copy the default.
					if (copyFromId) applyCopyFrom();
				}
			} else if (profile) {
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
				// Initialize indexer allowlist from profile
				allowedIndexerIds = profile.allowedIndexerIds?.length
					? [...profile.allowedIndexerIds]
					: null;
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
				allowedIndexerIds = null;
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

	// --- Indexer allowlist ---
	const restrictIndexers = $derived(allowedIndexerIds !== null);
	const selectedIndexerSet = $derived(new Set(allowedIndexerIds ?? []));
	const configuredIndexerIds = $derived(new Set(indexers.map((i) => i.id)));
	/** IDs kept from a deleted indexer, so the user can see and clear them. */
	const missingIndexerIds = $derived(
		(allowedIndexerIds ?? []).filter((id) => !configuredIndexerIds.has(id))
	);
	const selectedConfiguredCount = $derived(
		(allowedIndexerIds ?? []).filter((id) => configuredIndexerIds.has(id)).length
	);
	const indexerSelectionInvalid = $derived(
		restrictIndexers && (allowedIndexerIds?.length ?? 0) === 0
	);

	function setIndexerMode(restricted: boolean) {
		if (restricted) {
			// Seed with everything so "only selected" never starts empty.
			allowedIndexerIds = indexers.map((i) => i.id);
		} else {
			allowedIndexerIds = null;
		}
	}

	function toggleIndexer(id: string) {
		const current = allowedIndexerIds ?? [];
		allowedIndexerIds = current.includes(id)
			? current.filter((existing) => existing !== id)
			: [...current, id];
	}

	function selectAllIndexers() {
		allowedIndexerIds = indexers.map((i) => i.id);
	}

	function clearAllIndexers() {
		allowedIndexerIds = [];
	}

	function protocolLabel(protocol: ProfileIndexerOption['protocol']): string {
		if (protocol === 'usenet') return m.profiles_indexers_protocolUsenet();
		if (protocol === 'streaming') return m.profiles_indexers_protocolStreaming();
		return m.profiles_indexers_protocolTorrent();
	}

	// Derived counts for tab badges and summary chip
	const scoredFormatCount = $derived(Object.values(formatScores).filter((s) => s !== 0).length);
	const requiredFormatCount = $derived(requiredFormats.length);

	// Convert Record<string, number> to Map<FormatCategory, FormatScoreEntry[]> for accordion
	const groupedFormatScores = $derived.by(() => {
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
		if (descriptionTooLong || indexerSelectionInvalid) {
			return;
		}

		if (isMusic) {
			onSave({
				mediaKind: 'music',
				name,
				description: description || undefined,
				musicTiers: musicTierPayload(),
				musicAllowFallback: allowFallback,
				musicMinSizeMb: normalizeMbLimit(parseNumberInput(musicMinSizeMbInput)),
				musicMaxSizeMb: normalizeMbLimit(parseNumberInput(musicMaxSizeMbInput)),
				isDefault
			});
			return;
		}

		const filteredFormatScores = Object.fromEntries(
			Object.entries(formatScores).filter(([, score]) => score !== 0)
		);

		if (profile?.isBuiltIn) {
			onSave({
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
				requiredFormats,
				allowedIndexerIds: allowedIndexerIds?.length ? allowedIndexerIds : null
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
			requiredFormats,
			allowedIndexerIds: allowedIndexerIds?.length ? allowedIndexerIds : null
		});
	}

	const isCoreReadonly = $derived(mode === 'view' || (!isMusic && (profile?.isBuiltIn ?? false)));
	const isFullyReadonly = $derived(mode === 'view');
	const isNewProfile = $derived(mode === 'add');
	const isStreamerProfile = $derived(profile?.id === 'streamer');

	// Music has one tab: the ladder and its bounds. Video keeps its three.
	const showFormatsTab = $derived(!isMusic && mode !== 'view' && allFormats.length > 0);
	const showIndexersTab = $derived(!isMusic && (indexers.length > 0 || restrictIndexers));
	const showTabBar = $derived(showFormatsTab || showIndexersTab);
	// Tabs in DOM order, for arrow-key navigation.
	const visibleTabs = $derived<ProfileTab[]>([
		'general',
		...(showIndexersTab ? (['indexers'] as const) : []),
		...(showFormatsTab ? (['formats'] as const) : [])
	]);

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

	<!-- Tab Navigation -->
	{#if showTabBar}
		<!-- svelte-ignore a11y_interactive_supports_focus (focus is on the tabs: roving tabindex) -->
		<div
			role="tablist"
			aria-labelledby="profile-modal-title"
			class="tabs-border mb-6 tabs w-full"
			onkeydown={(e) => handleTablistKeydown(e, visibleTabs, activeTab, (t) => (activeTab = t))}
		>
			<button
				type="button"
				role="tab"
				id="{uid}-tab-general"
				data-tab="general"
				aria-selected={activeTab === 'general'}
				aria-controls="{uid}-panel"
				tabindex={activeTab === 'general' ? 0 : -1}
				class="sm:tab-lg tab flex-1 gap-2 px-2 whitespace-nowrap sm:px-4"
				class:tab-active={activeTab === 'general'}
				onclick={() => (activeTab = 'general')}
			>
				<Settings class="hidden h-4 w-4 sm:block" aria-hidden="true" />
				{m.profiles_tab_general()}
			</button>
			{#if showIndexersTab}
				<button
					type="button"
					role="tab"
					id="{uid}-tab-indexers"
					data-tab="indexers"
					aria-selected={activeTab === 'indexers'}
					aria-controls="{uid}-panel"
					tabindex={activeTab === 'indexers' ? 0 : -1}
					class="sm:tab-lg tab flex-1 gap-2 px-2 whitespace-nowrap sm:px-4"
					class:tab-active={activeTab === 'indexers'}
					onclick={() => (activeTab = 'indexers')}
				>
					<Server class="hidden h-4 w-4 sm:block" aria-hidden="true" />
					{m.profiles_tab_indexers()}
					{#if restrictIndexers}
						<span class="badge badge-sm">{selectedConfiguredCount}</span>
					{/if}
				</button>
			{/if}
			{#if showFormatsTab}
				<button
					type="button"
					role="tab"
					id="{uid}-tab-formats"
					data-tab="formats"
					aria-selected={activeTab === 'formats'}
					aria-controls="{uid}-panel"
					tabindex={activeTab === 'formats' ? 0 : -1}
					class="sm:tab-lg tab flex-1 gap-2 px-2 whitespace-nowrap sm:px-4"
					class:tab-active={activeTab === 'formats'}
					onclick={() => (activeTab = 'formats')}
				>
					<Layers class="hidden h-4 w-4 sm:block" aria-hidden="true" />
					{m.profiles_tab_formatScores()}
				</button>
			{/if}
		</div>
	{/if}

	<!-- Tab Content -->
	<div
		id="{uid}-panel"
		role={showTabBar ? 'tabpanel' : undefined}
		aria-labelledby={showTabBar ? `${uid}-tab-${activeTab}` : undefined}
	>
		{#if activeTab === 'general'}
			{#if isMusic}
				<!-- Music: same dialog grammar as video, with a ladder instead of scores -->
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
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
								disabled={isFullyReadonly}
								placeholder="My Music Profile"
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
								disabled={isFullyReadonly}
								maxlength={maxDescriptionLength}
								placeholder="Describe what this profile is for..."></textarea>
							{#if !isFullyReadonly}
								<div class="label py-1">
									<span class="label-text-alt text-xs {descriptionTooLong ? 'text-error' : ''}">
										{description.length}/{maxDescriptionLength}
									</span>
								</div>
							{/if}
						</div>

						{#if isNewProfile}
							<div class="form-control">
								<label class="label py-1" for="copy-from">
									<span class="label-text">{m.profiles_copyFrom_label()}</span>
								</label>
								<select
									id="copy-from"
									class="select-bordered select select-sm"
									value={copyFromId}
									onchange={(event) => {
										copyFromId = event.currentTarget.value;
										applyCopyFrom();
									}}
								>
									<option value="">{m.profiles_copyFrom_scratch()}</option>
									{#if builtInProfiles.length > 0}
										<optgroup label={m.profiles_copyFrom_builtInLabel()}>
											{#each builtInProfiles as builtIn (builtIn.id)}
												<option value={builtIn.id}>{builtIn.name}</option>
											{/each}
										</optgroup>
									{/if}
									{#if customProfiles.length > 0}
										<optgroup label={m.profiles_copyFrom_customLabel()}>
											{#each customProfiles as custom (custom.id)}
												<option value={custom.id}>{custom.name}</option>
											{/each}
										</optgroup>
									{/if}
								</select>
								<div class="label py-1">
									<span class="label-text-alt text-xs">
										{copyFromId ? m.music_copyFromHelp() : m.music_copyFromHelpZero()}
									</span>
								</div>
							</div>
						{/if}

						<div class="flex flex-wrap gap-x-4 gap-y-1 pt-2">
							<label class="label cursor-pointer gap-2">
								<input
									type="checkbox"
									class="checkbox checkbox-sm checkbox-primary"
									bind:checked={allowFallback}
									disabled={isFullyReadonly}
								/>
								<span class="label-text">{m.music_allowFallback()}</span>
							</label>
							<label class="label cursor-pointer gap-2">
								<input
									type="checkbox"
									class="checkbox checkbox-sm checkbox-primary"
									bind:checked={isDefault}
									disabled={isFullyReadonly}
								/>
								<span class="label-text">{m.profiles_setAsDefault()}</span>
							</label>
						</div>
					</div>

					<div class="space-y-4">
						<SectionHeader title={m.profiles_section_sizeLimits()} />

						<div class="grid grid-cols-2 gap-2 sm:gap-3">
							<div class="form-control">
								<label class="label py-1" for="music-min-size">
									<span class="label-text">{m.music_profileSizeFloor()}</span>
								</label>
								<input
									id="music-min-size"
									type="text"
									inputmode="numeric"
									class="input-bordered input input-sm"
									value={musicMinSizeMbInput}
									oninput={(event) => {
										musicMinSizeMbInput = sanitizeDecimalInput(event.currentTarget.value, 0);
									}}
									disabled={isFullyReadonly}
									placeholder="No floor"
								/>
							</div>
							<div class="form-control">
								<label class="label py-1" for="music-max-size">
									<span class="label-text">{m.music_profileSizeCeiling()}</span>
								</label>
								<input
									id="music-max-size"
									type="text"
									inputmode="numeric"
									class="input-bordered input input-sm"
									value={musicMaxSizeMbInput}
									oninput={(event) => {
										musicMaxSizeMbInput = sanitizeDecimalInput(event.currentTarget.value, 0);
									}}
									disabled={isFullyReadonly}
									placeholder="No ceiling"
								/>
							</div>
						</div>

						<div class="rounded-lg bg-base-200 p-3 text-xs text-base-content/70">
							<Info class="mr-1 inline h-3 w-3" />
							{m.music_profileSizeHint()}
						</div>
					</div>
				</div>

				<div class="mt-4 space-y-3">
					<SectionHeader title={m.music_profileTiers()} />
					<div class="space-y-2">
						{#each musicTiers as tier, index (index)}
							<div class="flex flex-wrap items-end gap-2 rounded-lg bg-base-200 p-2">
								<label class="form-control w-28">
									<span class="mb-1 text-xs text-base-content/60">{m.music_tierKind()}</span>
									<select
										class="select-bordered select w-full select-xs"
										bind:value={tier.kind}
										disabled={isFullyReadonly}
									>
										<option value="lossless">{m.music_tierLossless()}</option>
										<option value="lossy">{m.music_tierLossy()}</option>
										<option value="streaming">{m.music_tierStreaming()}</option>
									</select>
								</label>
								<label class="form-control min-w-32 flex-1">
									<span class="mb-1 text-xs text-base-content/60">{m.music_tierLabel()}</span>
									<input
										class="input-bordered input w-full input-xs"
										bind:value={tier.label}
										disabled={isFullyReadonly}
									/>
								</label>
								{#if tier.kind !== 'streaming'}
									<label class="form-control w-40">
										<span class="mb-1 text-xs text-base-content/60">{m.music_tierFormats()}</span>
										<input
											class="input-bordered input w-full input-xs"
											bind:value={tier.formats}
											placeholder="flac, mp3"
											disabled={isFullyReadonly}
										/>
									</label>
								{/if}
								{#if tier.kind === 'lossy'}
									<label class="form-control w-24">
										<span class="mb-1 text-xs text-base-content/60">{m.music_tierMinBitrate()}</span
										>
										<input
											class="input-bordered input w-full input-xs"
											bind:value={tier.minBitrateKbps}
											inputmode="numeric"
											placeholder="256"
											disabled={isFullyReadonly}
										/>
									</label>
								{/if}
								{#if tier.kind === 'lossless'}
									<label class="form-control w-24">
										<span class="mb-1 text-xs text-base-content/60"
											>{m.music_tierMinBitDepth()}</span
										>
										<input
											class="input-bordered input w-full input-xs"
											bind:value={tier.minBitDepth}
											inputmode="numeric"
											placeholder="24"
											disabled={isFullyReadonly}
										/>
									</label>
								{/if}
								<div class="flex items-center gap-0.5">
									<button
										type="button"
										class="btn btn-square btn-ghost btn-xs"
										disabled={index === 0 || isFullyReadonly}
										onclick={() => moveTier(index, -1)}
										aria-label="Up"
									>
										<ArrowUp class="h-3.5 w-3.5" />
									</button>
									<button
										type="button"
										class="btn btn-square btn-ghost btn-xs"
										disabled={index === musicTiers.length - 1 || isFullyReadonly}
										onclick={() => moveTier(index, 1)}
										aria-label="Down"
									>
										<ArrowDown class="h-3.5 w-3.5" />
									</button>
									<button
										type="button"
										class="btn btn-square btn-ghost text-error btn-xs"
										disabled={musicTiers.length === 1 || isFullyReadonly}
										onclick={() => removeTier(index)}
										aria-label={m.common_delete()}
									>
										<Trash2 class="h-3.5 w-3.5" />
									</button>
								</div>
							</div>
						{/each}
					</div>
					<button
						type="button"
						class="btn gap-1 btn-ghost btn-xs"
						onclick={addTier}
						disabled={isFullyReadonly}
					>
						<Plus class="h-3.5 w-3.5" />
						{m.music_addTier()}
					</button>
				</div>
			{:else}
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
								<select
									id="copy-from"
									class="select-bordered select select-sm"
									bind:value={copyFromId}
								>
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
									disabled={isFullyReadonly}
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
									disabled={isFullyReadonly}
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
									disabled={isFullyReadonly}
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
									<div class="pointer-events-none absolute top-1/2 left-3.5 z-1 -translate-y-1/2">
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
									<div
										class="max-h-40 overflow-y-auto rounded-lg border border-base-300 bg-base-100"
									>
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
					formatScores={groupedFormatScores}
					{requiredFormats}
					readonly={isFullyReadonly}
					onScoreChange={handleScoreChange}
				/>
			</div>
		{:else if activeTab === 'indexers'}
			<div class="space-y-4 py-2">
				<div>
					<h4 class="text-sm font-medium">{m.profiles_section_indexers()}</h4>
					<p class="mt-0.5 text-xs text-base-content/60">{m.profiles_indexers_desc()}</p>
				</div>

				<div class="flex flex-wrap gap-2">
					<button
						type="button"
						class="btn btn-sm {!restrictIndexers ? 'btn-primary' : 'btn-outline'}"
						disabled={isFullyReadonly}
						onclick={() => setIndexerMode(false)}
					>
						{m.profiles_indexers_all()}
					</button>
					<button
						type="button"
						class="btn btn-sm {restrictIndexers ? 'btn-primary' : 'btn-outline'}"
						disabled={isFullyReadonly || indexers.length === 0}
						onclick={() => setIndexerMode(true)}
					>
						{m.profiles_indexers_selected()}
					</button>
				</div>

				{#if restrictIndexers}
					{#if indexers.length === 0}
						<div class="rounded-lg bg-base-200 p-3 text-xs text-base-content/70">
							<Info class="mr-1 inline h-3 w-3" />
							{m.profiles_indexers_noneConfigured()}
						</div>
					{:else}
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs text-base-content/60">
								{m.profiles_indexers_selectedCount({
									selected: selectedConfiguredCount,
									total: indexers.length
								})}
							</span>
							{#if !isFullyReadonly}
								<div class="flex gap-1">
									<button
										type="button"
										class="btn h-7 min-h-0 btn-ghost px-2 btn-xs"
										onclick={selectAllIndexers}
									>
										{m.profiles_indexers_selectAll()}
									</button>
									<button
										type="button"
										class="btn h-7 min-h-0 btn-ghost px-2 btn-xs"
										onclick={clearAllIndexers}
									>
										{m.profiles_indexers_clear()}
									</button>
								</div>
							{/if}
						</div>

						<div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
							{#each indexers as indexer (indexer.id)}
								<label
									class="flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors {selectedIndexerSet.has(
										indexer.id
									)
										? 'border-primary/40 bg-primary/5'
										: 'border-base-300 hover:bg-base-200'}"
								>
									<input
										type="checkbox"
										class="checkbox checkbox-sm checkbox-primary"
										checked={selectedIndexerSet.has(indexer.id)}
										disabled={isFullyReadonly}
										onchange={() => toggleIndexer(indexer.id)}
									/>
									<span class="min-w-0 flex-1 truncate text-sm">{indexer.name}</span>
									<span class="badge shrink-0 badge-ghost badge-xs"
										>{protocolLabel(indexer.protocol)}</span
									>
									{#if !indexer.enabled}
										<span class="badge shrink-0 badge-xs badge-warning">
											{m.profiles_indexers_disabled()}
										</span>
									{/if}
								</label>
							{/each}
						</div>

						{#if indexerSelectionInvalid}
							<div class="text-xs text-error">{m.profiles_indexers_noneSelected()}</div>
						{/if}

						{#if missingIndexerIds.length > 0}
							<div class="flex items-start gap-1 text-xs text-warning">
								<Info class="mt-0.5 h-3 w-3 flex-none" />
								<span>
									{m.profiles_indexers_missing({ names: missingIndexerIds.join(', ') })}
								</span>
							</div>
						{/if}
					{/if}
				{/if}
			</div>
		{/if}
	</div>

	<!-- Footer -->
	<div class="modal-action mt-6 border-t border-base-300 pt-4">
		{#if !isMusic && profile?.isBuiltIn && mode !== 'view' && onReset}
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
				disabled={saving ||
					!name ||
					descriptionTooLong ||
					indexerSelectionInvalid ||
					(isMusic && !musicTiersValid)}
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
