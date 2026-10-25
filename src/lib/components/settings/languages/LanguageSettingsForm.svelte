<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { SettingsSection } from '#lib/components/ui/settings/index.js';
	import { FormSelect, FormCheckbox } from '#lib/components/ui/form/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { getResponseErrorMessage } from '#lib/utils/http.js';
	import { resolve } from '$app/paths';
	import { updateLanguageSettings, ApiError } from '#lib/api/index.js';
	import { ArrowRight } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { ALL_LANGUAGE_OPTIONS, getLanguageName } from '#lib/shared/languages.js';
	import type { LanguageSettingsUpdateInput } from '#lib/validation/schemas.js';

	interface LanguageOption {
		code: string;
		name: string;
	}

	/**
	 * Client-safe mirror of the language-settings singleton fields this form
	 * edits. (defaultProfileId is managed from the profile cards instead.)
	 */
	interface LanguageSettingsValues {
		metadataLocale: string;
		region: string;
		discoverOriginalFilter: string | null;
		unknownSubtitlePolicy: 'und' | 'assume-language';
		assumedLanguage: string | null;
		autoSyncSubtitles: boolean;
		preferOriginalTitle: boolean;
	}

	interface Props {
		/** The saved language-settings singleton from the loader. */
		settings: LanguageSettingsValues;
		/** Region options (TMDB countries; empty when TMDB is unconfigured). */
		countries: LanguageOption[];
		/** True while there are unsaved edits (consumed by the page header). */
		dirty?: boolean;
		/** True while a save request is in flight. */
		busy?: boolean;
		/** Briefly true after a successful save (drives the header feedback). */
		saved?: boolean;
	}

	/* eslint-disable no-useless-assignment, @typescript-eslint/no-unused-vars -- write-only bindable outputs consumed by the page header */
	let {
		settings,
		countries,
		dirty = $bindable(),
		busy = $bindable(),
		saved = $bindable()
	}: Props = $props();
	/* eslint-enable no-useless-assignment, @typescript-eslint/no-unused-vars */

	// All language dropdowns share the client-safe registry; nullable settings
	// use '' as the "none" sentinel in their selects.
	const languageOptions: readonly LanguageOption[] = ALL_LANGUAGE_OPTIONS;

	// Draft state, seeded from the loaded singleton by the sync effect below.
	let metadataLocale = $state('en-US');
	let region = $state('US');
	let discoverFilter = $state('');
	let preferOriginalTitle = $state(false);
	let unknownPolicy = $state<'und' | 'assume-language'>('und');
	let assumedLanguage = $state('');
	let autoSyncSubtitles = $state(true);

	/** The values the drafts are compared against; trails `settings` until saved. */
	let savedSnapshot = $state<LanguageSettingsValues>({
		metadataLocale: 'en-US',
		region: 'US',
		discoverOriginalFilter: null,
		unknownSubtitlePolicy: 'und',
		assumedLanguage: null,
		autoSyncSubtitles: true,
		preferOriginalTitle: false
	});

	const dirtyState = $derived(
		metadataLocale !== savedSnapshot.metadataLocale ||
			region !== savedSnapshot.region ||
			(discoverFilter || null) !== savedSnapshot.discoverOriginalFilter ||
			preferOriginalTitle !== savedSnapshot.preferOriginalTitle ||
			unknownPolicy !== savedSnapshot.unknownSubtitlePolicy ||
			(assumedLanguage || null) !== (savedSnapshot.assumedLanguage ?? null) || // Switching back to the 'und' policy clears a stored assumed language.
			(unknownPolicy === 'und' && !!savedSnapshot.assumedLanguage) ||
			autoSyncSubtitles !== savedSnapshot.autoSyncSubtitles
	);

	$effect(() => {
		dirty = dirtyState;
	});

	// Re-sync the drafts when the loader data changes (navigation, profile CRUD
	// invalidations) — but never clobber unsaved edits, and never clobber the
	// drafts right after our own save: dirtyState flipping back to false then
	// must not re-apply the (stale) loader prop over the saved response.
	let lastSyncedSettings: LanguageSettingsValues | null = null;
	$effect(() => {
		if (dirtyState) return;
		if (settings === lastSyncedSettings) return;
		lastSyncedSettings = settings;
		savedSnapshot = { ...settings };
		metadataLocale = settings.metadataLocale;
		region = settings.region;
		discoverFilter = settings.discoverOriginalFilter ?? '';
		preferOriginalTitle = settings.preferOriginalTitle;
		unknownPolicy = settings.unknownSubtitlePolicy;
		assumedLanguage = settings.assumedLanguage ?? '';
		autoSyncSubtitles = settings.autoSyncSubtitles;
	});

	/** Make sure the current value stays selectable even when absent from the catalogue. */
	function withCurrent(
		options: readonly LanguageOption[],
		current: string
	): readonly LanguageOption[] {
		if (!current || options.some((option) => option.code === current)) return options;
		return [{ code: current, name: getLanguageName(current) }, ...options];
	}

	let metadataLocaleOptions = $derived(
		withCurrent(languageOptions, savedSnapshot.metadataLocale).map((option) => ({
			value: option.code,
			label: option.name
		}))
	);
	let regionOptions = $derived(
		withCurrent(countries, savedSnapshot.region).map((option) => ({
			value: option.code,
			label: option.name
		}))
	);
	let assumedLanguageOptions = $derived(
		withCurrent(languageOptions, savedSnapshot.assumedLanguage ?? '').map((option) => ({
			value: option.code,
			label: option.name
		}))
	);

	// The discover filter works on base language tags (e.g. 'pt', not 'pt-BR').
	let discoverFilterOptions = $derived.by(() => {
		const seen = new SvelteSet<string>();
		const options: LanguageOption[] = [];
		for (const lang of languageOptions) {
			const base = lang.code.split('-')[0];
			if (seen.has(base)) continue;
			seen.add(base);
			options.push({ code: base, name: lang.name });
		}
		return [
			{ value: '', label: m.settings_languages_noOriginalFilter() },
			...withCurrent(options, savedSnapshot.discoverOriginalFilter ?? '').map((option) => ({
				value: option.code,
				label: option.name
			}))
		];
	});

	/**
	 * Build a partial patch carrying exactly the fields the user changed.
	 * The language-settings endpoint only persists keys that are sent.
	 */
	function buildPatch(): LanguageSettingsUpdateInput {
		const patch: LanguageSettingsUpdateInput = {};

		if (metadataLocale !== savedSnapshot.metadataLocale) patch.metadataLocale = metadataLocale;
		if (region !== savedSnapshot.region) patch.region = region;
		if ((discoverFilter || null) !== savedSnapshot.discoverOriginalFilter) {
			patch.discoverOriginalFilter = discoverFilter || null;
		}
		if (preferOriginalTitle !== savedSnapshot.preferOriginalTitle) {
			patch.preferOriginalTitle = preferOriginalTitle;
		}
		if (unknownPolicy !== savedSnapshot.unknownSubtitlePolicy) {
			patch.unknownSubtitlePolicy = unknownPolicy;
		}
		if ((assumedLanguage || null) !== (savedSnapshot.assumedLanguage ?? null)) {
			patch.assumedLanguage = assumedLanguage || null;
		}
		// The assumed-language select is hidden for the 'und' policy; clear the
		// stored language so it cannot linger unused.
		if (
			unknownPolicy === 'und' &&
			patch.assumedLanguage === undefined &&
			savedSnapshot.assumedLanguage
		) {
			patch.assumedLanguage = null;
		}
		if (autoSyncSubtitles !== savedSnapshot.autoSyncSubtitles) {
			patch.autoSyncSubtitles = autoSyncSubtitles;
		}

		return patch;
	}

	/** Persist the changed fields; resolves to true on success. */
	export async function save(): Promise<boolean> {
		busy = true;
		try {
			const updated = await updateLanguageSettings(buildPatch());
			// Compare future edits against what the server actually stored, and
			// treat the current loader prop as already reflected in the drafts.
			lastSyncedSettings = settings;
			savedSnapshot = { ...updated, assumedLanguage: updated.assumedLanguage ?? null };
			metadataLocale = updated.metadataLocale;
			region = updated.region;
			discoverFilter = updated.discoverOriginalFilter ?? '';
			preferOriginalTitle = updated.preferOriginalTitle;
			unknownPolicy = updated.unknownSubtitlePolicy;
			assumedLanguage = updated.assumedLanguage ?? '';
			autoSyncSubtitles = updated.autoSyncSubtitles;
			toasts.success(m.settings_languages_saved());
			saved = true;
			window.setTimeout(() => (saved = false), 2000);
			return true;
		} catch (error) {
			toasts.error(
				error instanceof ApiError
					? getResponseErrorMessage(error.response, m.settings_languages_saveFailed())
					: error instanceof Error
						? error.message
						: m.settings_languages_saveFailed()
			);
			return false;
		} finally {
			busy = false;
		}
	}
</script>

<!-- Metadata localization -->
<SettingsSection
	title={m.settings_languages_metadataSection()}
	description={m.settings_languages_metadataHint()}
>
	<div class="grid gap-6 md:grid-cols-2">
		<FormSelect
			label={m.settings_languages_metadataLocale()}
			id="metadataLocale"
			bind:value={metadataLocale}
			options={metadataLocaleOptions}
			helpText={m.settings_languages_metadataLocaleHint()}
		/>
		<FormSelect
			label={m.settings_languages_region()}
			id="region"
			bind:value={region}
			options={regionOptions}
			helpText={m.settings_languages_regionHint()}
		/>
		<FormSelect
			label={m.settings_languages_discoverOriginalFilter()}
			id="discoverOriginalFilter"
			bind:value={discoverFilter}
			options={discoverFilterOptions}
			helpText={m.settings_languages_discoverOriginalFilterHint()}
		/>
		<div class="flex items-center">
			<FormCheckbox
				label={m.settings_languages_preferOriginalTitle()}
				description={m.settings_languages_preferOriginalTitleHint()}
				bind:checked={preferOriginalTitle}
				size="md"
			/>
		</div>
	</div>
</SettingsSection>

<!-- Subtitle handling -->
<SettingsSection
	title={m.settings_languages_audioSubtitlesSection()}
	description={m.settings_languages_audioSubtitlesHint()}
>
	<div class="grid gap-6 md:grid-cols-2">
		<FormSelect
			label={m.settings_languages_unknownPolicy()}
			id="unknownPolicy"
			bind:value={unknownPolicy}
			options={[
				{ value: 'und', label: m.settings_languages_unknownPolicyUnd() },
				{ value: 'assume-language', label: m.settings_languages_unknownPolicyAssume() }
			]}
			helpText={m.settings_languages_unknownPolicyHint()}
		/>
		{#if unknownPolicy === 'assume-language'}
			<FormSelect
				label={m.settings_languages_assumedLanguage()}
				id="assumedLanguage"
				bind:value={assumedLanguage}
				options={assumedLanguageOptions}
				helpText={m.settings_languages_assumedLanguageHint()}
			/>
		{/if}
		<FormCheckbox
			label={m.settings_languages_autoSync()}
			description={m.settings_languages_autoSyncHint()}
			bind:checked={autoSyncSubtitles}
			size="md"
		/>
	</div>

	<a
		class="inline-flex items-center gap-2 text-sm font-medium text-primary transition-opacity hover:opacity-80"
		href={resolve('settings/integrations/subtitle-providers')}
	>
		{m.settings_languages_linkSubtitleProviders()}
		<ArrowRight class="h-4 w-4 shrink-0" />
	</a>
</SettingsSection>
