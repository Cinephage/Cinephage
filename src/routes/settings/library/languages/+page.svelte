<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import { Info, RefreshCw, Save, CheckCircle } from '@lucide/svelte';
	import LanguageSettingsForm from '#lib/components/settings/languages/LanguageSettingsForm.svelte';
	import LanguageProfilesManager from '#lib/components/settings/languages/LanguageProfilesManager.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let settingsForm: LanguageSettingsForm;
	let dirty = $state(false);
	let busy = $state(false);
	let saved = $state(false);
</script>

<svelte:head>
	<title>{m.settings_languages_pageTitle()}</title>
</svelte:head>

<SettingsPage title={m.nav_languages()} subtitle={m.settings_languages_subtitle()}>
	{#snippet actions()}
		<button
			class="btn gap-2 btn-primary btn-sm"
			onclick={() => settingsForm?.save()}
			disabled={!dirty || busy}
		>
			{#if busy}
				<RefreshCw class="h-4 w-4 animate-spin" />
				{m.common_saving()}
			{:else if saved}
				<CheckCircle class="h-4 w-4" />
				{m.settings_languages_savedShort()}
			{:else}
				<Save class="h-4 w-4" />
				{m.settings_languages_saveButton()}
			{/if}
		</button>
	{/snippet}

	{#if dirty}
		<div class="alert alert-warning">
			<div class="flex items-start gap-3">
				<Info class="mt-0.5 h-5 w-5 shrink-0" />
				<div>
					<p class="font-medium">{m.settings_languages_unsavedChanges()}</p>
					<p class="text-sm opacity-90">{m.settings_languages_unsavedChangesDesc()}</p>
				</div>
			</div>
		</div>
	{/if}

	<LanguageProfilesManager
		profiles={data.profiles}
		defaultProfileId={data.settings.defaultProfileId}
	/>

	<LanguageSettingsForm
		bind:this={settingsForm}
		bind:dirty
		bind:busy
		bind:saved
		settings={data.settings}
		countries={data.countries}
	/>
</SettingsPage>
