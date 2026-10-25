<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { Plus, X, ArrowUp, ArrowDown, Flag, Info } from '@lucide/svelte';
	import { getResponseErrorMessage } from '#lib/utils/http.js';
	import { ALL_LANGUAGE_OPTIONS } from '#lib/shared/languages.js';
	import { requirementKey } from '#lib/shared/language-profile.js';
	import type {
		LanguageProfileV2,
		SubtitleAccessibility,
		SubtitleRequirement,
		SubtitleVariant
	} from '#lib/shared/language-profile.js';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		ModalWrapper,
		ModalHeader,
		ModalFooter,
		SectionHeader
	} from '#lib/components/ui/modal/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { createLanguageProfile, updateLanguageProfile, ApiError } from '#lib/api/index.js';
	import { variantLabel, accessibilityLabel } from './labels';

	/** Server-load profile row: v2 shape plus timestamps. */
	export interface LanguageProfile extends LanguageProfileV2 {
		createdAt?: string;
		updatedAt?: string;
	}

	const LANGUAGES = ALL_LANGUAGE_OPTIONS;

	const VARIANT_OPTIONS: ReadonlyArray<SubtitleVariant> = ['regular', 'forced', 'both'];

	const ACCESSIBILITY_OPTIONS: ReadonlyArray<SubtitleAccessibility> = [
		'any',
		'prefer-hi',
		'require-hi',
		'exclude-hi'
	];

	/** Matches the server schema (60); the old UI capped at 20 for no reason. */
	const MAX_NAME_LENGTH = 60;

	interface Props {
		open: boolean;
		/** 'edit' updates `source`; 'add' creates a new profile from `source` (null or a duplicate donor). */
		mode: 'add' | 'edit';
		source?: LanguageProfile | null;
		onClose: () => void;
	}

	let { open, mode, source = null, onClose }: Props = $props();

	// Form state (v2 profile shape)
	let saving = $state(false);
	let modalError = $state<string | null>(null);
	let formName = $state('');
	let formAudioPreferOriginal = $state(true);
	let formAudioLanguages = $state<string[]>([]);
	let formAudioMode = $state<'prefer' | 'require'>('prefer');
	let formSubtitles = $state<SubtitleRequirement[]>([]);
	let formCutoffRank = $state<number | null>(null);
	let formMinimumScore = $state(70);
	let formUpgradesAllowed = $state(true);

	const nameTooLong = $derived(formName.trim().length > MAX_NAME_LENGTH);
	const nameMissing = $derived(formName.trim().length === 0);

	/** Indexes of subtitle requirements repeating an earlier tag|variant|accessibility tuple. */
	const duplicateRequirementIndexes = $derived.by(() => {
		const seen = new SvelteSet<string>();
		const duplicates = new SvelteSet<number>();
		formSubtitles.forEach((requirement, index) => {
			const key = requirementKey(requirement);
			if (seen.has(key)) duplicates.add(index);
			seen.add(key);
		});
		return duplicates;
	});

	const saveDisabled = $derived(
		nameMissing || nameTooLong || formSubtitles.length === 0 || duplicateRequirementIndexes.size > 0
	);

	// Seed the form whenever the modal opens.
	$effect(() => {
		if (!open) return;
		modalError = null;
		if (source) {
			formName =
				mode === 'add' ? `${source.name.trim()} (copy)`.slice(0, MAX_NAME_LENGTH) : source.name;
			formAudioPreferOriginal = source.audio?.preferOriginal ?? true;
			formAudioLanguages = [...(source.audio?.languages ?? [])];
			formAudioMode = source.audio?.mode ?? 'prefer';
			formSubtitles = (source.subtitles ?? []).map((requirement) => ({ ...requirement }));
			formCutoffRank = source.cutoffRank ?? null;
			formMinimumScore = source.minimumScore ?? 70;
			formUpgradesAllowed = source.upgradesAllowed ?? true;
		} else {
			formName = '';
			formAudioPreferOriginal = true;
			formAudioLanguages = [];
			formAudioMode = 'prefer';
			formSubtitles = [{ tag: 'en', variant: 'regular', accessibility: 'any' }];
			formCutoffRank = null;
			formMinimumScore = 70;
			formUpgradesAllowed = true;
		}
	});

	function makeRequirement(): SubtitleRequirement {
		return { tag: 'en', variant: 'regular', accessibility: 'any' };
	}

	// --- Subtitle requirement rows ---
	function addSubtitle() {
		formSubtitles = [...formSubtitles, makeRequirement()];
	}

	function removeSubtitle(index: number) {
		formSubtitles = formSubtitles.filter((_, i) => i !== index);
		if (formCutoffRank === null) return;
		if (formCutoffRank === index) {
			formCutoffRank = null;
		} else if (formCutoffRank > index) {
			formCutoffRank -= 1;
		}
	}

	function updateSubtitle(index: number, field: keyof SubtitleRequirement, value: string) {
		formSubtitles = formSubtitles.map((requirement, i) =>
			i === index ? { ...requirement, [field]: value } : requirement
		);
	}

	function moveSubtitle(index: number, direction: -1 | 1) {
		const target = index + direction;
		if (target < 0 || target >= formSubtitles.length) return;
		const next = [...formSubtitles];
		[next[index], next[target]] = [next[target], next[index]];
		formSubtitles = next;
		// Keep the cutoff pointing at the same requirement after reordering.
		if (formCutoffRank === index) formCutoffRank = target;
		else if (formCutoffRank === target) formCutoffRank = index;
	}

	/** Toggle the cutoff flag on a row; clicking the flagged row clears the cutoff. */
	function toggleCutoff(index: number) {
		formCutoffRank = formCutoffRank === index ? null : index;
	}

	// --- Preferred audio language list ---
	function addAudioLanguage() {
		formAudioLanguages = [...formAudioLanguages, 'en'];
	}

	function removeAudioLanguage(index: number) {
		formAudioLanguages = formAudioLanguages.filter((_, i) => i !== index);
	}

	function updateAudioLanguage(index: number, value: string) {
		formAudioLanguages = formAudioLanguages.map((code, i) => (i === index ? value : code));
	}

	function moveAudioLanguage(index: number, direction: -1 | 1) {
		const target = index + direction;
		if (target < 0 || target >= formAudioLanguages.length) return;
		const next = [...formAudioLanguages];
		[next[index], next[target]] = [next[target], next[index]];
		formAudioLanguages = next;
	}

	function scoreLabel(score: number): string {
		if (score >= 90) return m.settings_languages_scoreStrict();
		if (score >= 50) return m.settings_languages_scoreBalanced();
		return m.settings_languages_scoreLenient();
	}

	async function handleSave() {
		modalError = null;
		if (nameMissing || formSubtitles.length === 0) {
			modalError = m.settings_languages_profiles_nameAndLanguageRequired();
			return;
		}
		if (nameTooLong) {
			modalError = m.settings_languages_profiles_nameTooLong({ max: MAX_NAME_LENGTH });
			return;
		}

		saving = true;
		try {
			const payload = {
				name: formName.trim(),
				audio: {
					preferOriginal: formAudioPreferOriginal,
					languages: formAudioLanguages,
					mode: formAudioMode
				},
				subtitles: formSubtitles,
				cutoffRank: formCutoffRank,
				minimumScore: formMinimumScore,
				upgradesAllowed: formUpgradesAllowed
			};

			if (mode === 'edit' && source) {
				await updateLanguageProfile(source.id, payload);
			} else {
				await createLanguageProfile(payload);
			}

			await refreshAll();
			onClose();
		} catch (e) {
			modalError =
				e instanceof ApiError
					? getResponseErrorMessage(e.response, m.settings_languages_profileSaveFailed())
					: e instanceof Error
						? e.message
						: m.settings_languages_profileSaveFailed();
		} finally {
			saving = false;
		}
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="3xl" labelledBy="language-profile-modal-title">
	<ModalHeader
		title={mode === 'add'
			? m.settings_languages_profiles_addTitle()
			: m.settings_languages_profiles_editTitle()}
		{onClose}
	/>

	<div class="space-y-5">
		<!-- Profile -->
		<section class="space-y-4">
			<SectionHeader title={m.settings_languages_sectionProfile()} />
			<div class="form-control">
				<label class="label py-1" for="profileName">
					<span class="label-text">{m.settings_languages_profiles_profileName()}</span>
					<span
						class="label-text-alt font-mono {nameTooLong ? 'text-error' : 'text-base-content/50'}"
					>
						{formName.length}/{MAX_NAME_LENGTH}
					</span>
				</label>
				<input
					id="profileName"
					type="text"
					class="input-bordered input w-full input-sm {nameTooLong ? 'input-error' : ''}"
					bind:value={formName}
					placeholder={m.settings_languages_profiles_profileNamePlaceholder()}
				/>
				{#if nameTooLong}
					<div class="label py-1">
						<span class="label-text-alt text-xs text-error">
							{m.settings_languages_profiles_maxChars({ max: MAX_NAME_LENGTH })}
						</span>
					</div>
				{/if}
			</div>
		</section>

		<!-- Subtitle requirements (the core of the profile) -->
		<section class="space-y-4">
			<div class="flex items-end justify-between gap-2">
				<SectionHeader class="flex-1" title={m.settings_languages_sectionSubtitles()} />
				<button class="btn gap-1 btn-ghost btn-sm" onclick={addSubtitle}>
					<Plus class="h-3.5 w-3.5" />
					{m.settings_languages_profiles_addLanguage()}
				</button>
			</div>

			<ul class="flex flex-col gap-1.5">
				{#each formSubtitles as requirement, i (i)}
					{@const isCutoff = formCutoffRank === i}
					{@const isDuplicate = duplicateRequirementIndexes.has(i)}
					<li
						class="flex flex-wrap items-center gap-1.5 rounded-lg px-2.5 py-1.5
							{isCutoff
							? 'bg-primary/10 ring-1 ring-primary/40'
							: isDuplicate
								? 'bg-error/5 ring-1 ring-error/50'
								: 'bg-base-200/50'}"
					>
						<span class="w-4 shrink-0 text-center font-mono text-xs text-base-content/50">
							{i + 1}
						</span>
						<select
							class="select-bordered select w-36 min-w-0 flex-1 select-xs {isDuplicate
								? 'select-error'
								: ''}"
							value={requirement.tag}
							onchange={(e) => updateSubtitle(i, 'tag', e.currentTarget.value)}
							aria-label={m.settings_languages_profiles_subtitleLanguageSelect()}
						>
							{#each LANGUAGES as lang (lang.code)}
								<option value={lang.code}>{lang.name}</option>
							{/each}
						</select>
						<select
							class="select-bordered select w-28 select-xs"
							value={requirement.variant}
							onchange={(e) => updateSubtitle(i, 'variant', e.currentTarget.value)}
							aria-label={m.settings_languages_profiles_subtitleVariantSelect()}
						>
							{#each VARIANT_OPTIONS as option (option)}
								<option value={option}>{variantLabel(option)}</option>
							{/each}
						</select>
						<select
							class="select-bordered select w-28 select-xs"
							value={requirement.accessibility}
							onchange={(e) => updateSubtitle(i, 'accessibility', e.currentTarget.value)}
							aria-label={m.settings_languages_profiles_subtitleAccessibilitySelect()}
						>
							{#each ACCESSIBILITY_OPTIONS as option (option)}
								<option value={option}>{accessibilityLabel(option)}</option>
							{/each}
						</select>
						<!-- Control cluster wraps to its own line as one unit on narrow widths. -->
						<div class="ml-auto flex items-center gap-1">
							<button
								type="button"
								class="btn gap-1 btn-xs {isCutoff
									? 'border-primary/40 bg-primary/20 text-primary hover:bg-primary/30'
									: 'btn-ghost'}"
								aria-pressed={isCutoff}
								onclick={() => toggleCutoff(i)}
								aria-label={m.settings_languages_cutoffToggle()}
								title={m.settings_languages_cutoffToggle()}
							>
								<Flag class="h-3.5 w-3.5" />
								{#if isCutoff}
									<span class="text-xs">
										{m.settings_languages_profiles_cutoff()}
									</span>
								{/if}
							</button>
							<button
								type="button"
								class="btn btn-ghost btn-xs"
								onclick={() => moveSubtitle(i, -1)}
								disabled={i === 0}
								aria-label={m.settings_languages_profiles_moveRequirementUp()}
							>
								<ArrowUp class="h-3.5 w-3.5" />
							</button>
							<button
								type="button"
								class="btn btn-ghost btn-xs"
								onclick={() => moveSubtitle(i, 1)}
								disabled={i === formSubtitles.length - 1}
								aria-label={m.settings_languages_profiles_moveRequirementDown()}
							>
								<ArrowDown class="h-3.5 w-3.5" />
							</button>
							<button
								type="button"
								class="btn btn-ghost text-error btn-xs"
								onclick={() => removeSubtitle(i)}
								disabled={formSubtitles.length === 1}
								aria-label={m.settings_languages_profiles_removeLanguage()}
							>
								<X class="h-3.5 w-3.5" />
							</button>
						</div>
					</li>
				{/each}
			</ul>

			<p class="flex items-start gap-1.5 text-xs text-base-content/60">
				<Flag class="mt-0.5 h-3 w-3 shrink-0" />
				{m.settings_languages_cutoffHelp()}
			</p>
			{#if duplicateRequirementIndexes.size > 0}
				<p class="text-xs text-error">{m.settings_languages_duplicateRequirements()}</p>
			{/if}
		</section>

		<!-- Audio & matching -->
		<section class="space-y-4">
			<SectionHeader title={m.settings_languages_sectionAudioMatching()} />

			<label
				class="flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-base-200/50"
			>
				<span class="text-sm">{m.settings_languages_profiles_audioMode()}</span>
				<select
					class="select ml-auto w-44 select-xs"
					aria-label={m.settings_languages_profiles_audioMode()}
					bind:value={formAudioMode}
				>
					<option value="prefer">
						{m.settings_languages_profiles_audioModePrefer()}
					</option>
					<option value="require">
						{m.settings_languages_profiles_audioModeRequire()}
					</option>
				</select>
			</label>

			<div class="flex flex-col">
				<label
					class="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-base-200/50"
				>
					<input
						type="checkbox"
						class="checkbox checkbox-sm checkbox-primary"
						bind:checked={formAudioPreferOriginal}
					/>
					<span class="text-sm">
						{m.settings_languages_profiles_preferOriginalAudio()}
					</span>
				</label>
				<label
					class="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-base-200/50"
				>
					<input
						type="checkbox"
						class="checkbox checkbox-sm checkbox-primary"
						bind:checked={formUpgradesAllowed}
					/>
					<span class="text-sm">
						{m.settings_languages_profiles_allowUpgrades()}
					</span>
				</label>
			</div>

			<div class="space-y-1.5">
				<div class="flex items-center justify-between gap-2">
					<span class="text-xs font-medium text-base-content/60">
						{#if formAudioMode === 'require'}
							{m.settings_languages_profiles_requiredAudioLabel()}
						{:else}
							{m.settings_languages_fallbackAudioLabel()}
						{/if}
					</span>
					<button
						class="btn gap-1 btn-ghost text-base-content/70 btn-xs"
						onclick={addAudioLanguage}
					>
						<Plus class="h-3 w-3" />
						{#if formAudioMode === 'require'}
							{m.settings_languages_profiles_addRequiredLanguage()}
						{:else}
							{m.settings_languages_profiles_addFallbackLanguage()}
						{/if}
					</button>
				</div>
				<p class="text-xs text-base-content/50">
					{m.settings_languages_profiles_audioLanguagesHint()}
				</p>
				{#each formAudioLanguages as code, i (i)}
					<div class="flex flex-wrap items-center gap-1.5 rounded-lg bg-base-200/50 px-2.5 py-1.5">
						<span class="w-4 shrink-0 text-center font-mono text-xs text-base-content/50">
							{i + 1}
						</span>
						<select
							class="select-bordered select w-36 min-w-0 flex-1 select-xs"
							value={code}
							onchange={(e) => updateAudioLanguage(i, e.currentTarget.value)}
							aria-label={m.settings_languages_profiles_fallbackAudioLanguage()}
						>
							{#each LANGUAGES as lang (lang.code)}
								<option value={lang.code}>{lang.name}</option>
							{/each}
						</select>
						<div class="ml-auto flex items-center gap-1">
							<button
								type="button"
								class="btn btn-ghost btn-xs"
								onclick={() => moveAudioLanguage(i, -1)}
								disabled={i === 0}
								aria-label={m.settings_languages_profiles_moveAudioLanguageUp()}
							>
								<ArrowUp class="h-3.5 w-3.5" />
							</button>
							<button
								type="button"
								class="btn btn-ghost btn-xs"
								onclick={() => moveAudioLanguage(i, 1)}
								disabled={i === formAudioLanguages.length - 1}
								aria-label={m.settings_languages_profiles_moveAudioLanguageDown()}
							>
								<ArrowDown class="h-3.5 w-3.5" />
							</button>
							<button
								type="button"
								class="btn btn-ghost text-error btn-xs"
								onclick={() => removeAudioLanguage(i)}
								aria-label={m.settings_languages_profiles_removeAudioLanguage()}
							>
								<X class="h-3.5 w-3.5" />
							</button>
						</div>
					</div>
				{/each}
			</div>

			<div class="space-y-2">
				<div class="flex items-center justify-between gap-2">
					<span class="flex items-center gap-1.5 text-sm font-medium">
						{m.settings_languages_profiles_minimumScore()}
						<span
							class="tooltip tooltip-left"
							data-tip={m.settings_languages_profiles_minimumScoreHelp()}
						>
							<Info class="h-3 w-3 text-base-content/50" />
						</span>
					</span>
					<span class="flex items-center gap-1.5 text-xs text-base-content/60">
						<span class="font-mono text-sm text-base-content">{formMinimumScore ?? 70}/100</span>
						<span class="badge badge-ghost badge-xs">{scoreLabel(formMinimumScore ?? 70)}</span>
					</span>
				</div>
				<input
					id="minimumScore"
					type="range"
					class="range range-primary range-sm"
					bind:value={formMinimumScore}
					min="0"
					max="100"
					step="5"
				/>
			</div>
		</section>
	</div>

	{#if modalError}
		<div role="alert" class="mt-4 alert text-sm alert-error">
			<span>{modalError}</span>
		</div>
	{/if}

	<ModalFooter
		onCancel={onClose}
		onSave={handleSave}
		{saving}
		{saveDisabled}
		saveLabel={mode === 'add' ? m.action_create() : m.action_save()}
	/>
</ModalWrapper>
