<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { ChevronRight, CheckCircle, AlertCircle } from '@lucide/svelte';
	import type { LayoutData } from '../$types';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { refreshAll, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ModalWrapper, ModalHeader, ModalFooter } from '#lib/components/ui/modal/index.js';
	import { SettingsPage, SettingsSection } from '#lib/components/ui/settings/index.js';
	import { updateMetadataProviderSettings, updateTmdbSettings } from '#lib/api/settings.js';

	let { data }: { data: LayoutData } = $props();

	// =====================
	// TMDB Config State
	// =====================
	let tmdbModalOpen = $state(false);
	let tmdbApiKey = $state('');
	let tmdbSaving = $state(false);
	let tmdbError = $state<string | null>(null);

	// =====================
	// Anime Enrichment State
	// =====================
	let enrichmentModalOpen = $state(false);
	let enrichmentSaving = $state(false);
	let enrichmentError = $state<string | null>(null);
	let animeEnrichmentEnabled = $state(false);

	function openTmdbModal() {
		tmdbApiKey = '';
		tmdbError = null;
		tmdbModalOpen = true;
	}

	function closeTmdbModal() {
		tmdbError = null;
		tmdbModalOpen = false;

		const url = new URL(page.url.href);
		if (url.searchParams.get('open') === 'tmdb') {
			url.searchParams.delete('open');
			goto(url.toString(), { replace: true, reset: false });
		}
	}

	function openEnrichmentModal() {
		enrichmentError = null;
		animeEnrichmentEnabled = data.metadataProviders?.animeEnrichmentEnabled ?? true;
		enrichmentModalOpen = true;
	}

	function closeEnrichmentModal() {
		enrichmentError = null;
		enrichmentModalOpen = false;
	}

	async function handleTmdbSave() {
		tmdbSaving = true;
		tmdbError = null;

		try {
			await updateTmdbSettings(tmdbApiKey);

			await refreshAll();
			toasts.success(m.settings_integrations_tmdbKeySaved());
			closeTmdbModal();
		} catch (error) {
			tmdbError =
				error instanceof Error ? error.message : m.settings_integrations_tmdbFailedToSave();
		} finally {
			tmdbSaving = false;
		}
	}

	async function handleEnrichmentSave() {
		enrichmentSaving = true;
		enrichmentError = null;
		try {
			await updateMetadataProviderSettings({ animeEnrichmentEnabled });
			await refreshAll();
			toasts.success('Anime enrichment settings saved');
			closeEnrichmentModal();
		} catch (error) {
			enrichmentError =
				error instanceof Error ? error.message : m.settings_integrations_tmdbFailedToSave();
		} finally {
			enrichmentSaving = false;
		}
	}

	// Open modal if navigated with ?open=tmdb
	$effect(() => {
		const shouldOpenTmdbModal = page.url.searchParams.get('open') === 'tmdb';
		if (shouldOpenTmdbModal && !tmdbModalOpen) {
			openTmdbModal();
		}
	});
</script>

<svelte:head>
	<title>{m.settings_system_metadataProviders_pageTitle()}</title>
</svelte:head>

<SettingsPage
	title={m.nav_metadataProviders()}
	subtitle={m.settings_system_metadataProviders_subtitle()}
>
	<SettingsSection
		title={m.settings_integrations_tmdbTitle()}
		description={m.settings_integrations_tmdbDescription()}
	>
		<div class="flex items-center gap-3">
			{#if data.tmdb.hasApiKey}
				<div class="badge gap-1 badge-success">
					<CheckCircle class="h-3 w-3" />
					{m.settings_integrations_configured()}
				</div>
			{:else}
				<div class="badge gap-1 badge-warning">
					<AlertCircle class="h-3 w-3" />
					{m.settings_integrations_notConfigured()}
				</div>
			{/if}
			<button onclick={openTmdbModal} class="btn gap-1 btn-primary btn-sm">
				{data.tmdb.hasApiKey ? m.action_update() : m.action_configure()}
				<ChevronRight class="h-4 w-4" />
			</button>
		</div>

		{#if !data.tmdb.hasApiKey}
			<div class="alert alert-info">
				<AlertCircle class="h-5 w-5" />
				<div>
					<p class="text-sm">
						{m.settings_integrations_tmdbApiKeyDescription()}
						<a
							href="https://www.themoviedb.org/settings/api"
							target="_blank"
							class="link link-primary"
						>
							themoviedb.org
						</a>.
					</p>
				</div>
			</div>
		{/if}
	</SettingsSection>

	<SettingsSection
		title="Anime Metadata Enrichment"
		description="When enabled, AniList and MyAnimeList (via Jikan) automatically enrich anime titles with alternate titles and adult classification. No account or API key required."
	>
		<div class="flex items-center gap-3">
			{#if data.metadataProviders?.animeEnrichmentEnabled}
				<div class="badge gap-1 badge-success">
					<CheckCircle class="h-3 w-3" />
					Enabled
				</div>
			{:else}
				<div class="badge gap-1 badge-warning">
					<AlertCircle class="h-3 w-3" />
					Disabled
				</div>
			{/if}
			<button onclick={openEnrichmentModal} class="btn gap-1 btn-primary btn-sm">
				Configure
				<ChevronRight class="h-4 w-4" />
			</button>
		</div>
		<p class="text-sm text-base-content/70">
			Enrichment data is supplementary only - TMDB remains the canonical source for title, overview,
			and display metadata.
		</p>
	</SettingsSection>
</SettingsPage>

<!-- TMDB API Key Modal -->
<ModalWrapper open={tmdbModalOpen} onClose={closeTmdbModal} maxWidth="md">
	<ModalHeader title={m.settings_integrations_tmdbApiKeyTitle()} onClose={closeTmdbModal} />
	<form
		onsubmit={async (event) => {
			event.preventDefault();
			await handleTmdbSave();
		}}
	>
		<div class="space-y-4 p-4">
			<p class="text-sm text-base-content/70">
				{m.settings_integrations_tmdbApiKeyDescription()}
				<a href="https://www.themoviedb.org/settings/api" target="_blank" class="link link-primary">
					themoviedb.org
				</a>.
			</p>
			<div class="form-control w-full">
				<label class="label" for="tmdbApiKey">
					<span class="label-text">{m.settings_integrations_apiKeyLabel()}</span>
				</label>
				<input
					type="text"
					id="tmdbApiKey"
					name="apiKey"
					bind:value={tmdbApiKey}
					placeholder={data.tmdb.hasApiKey
						? m.settings_integrations_apiKeyPlaceholderExisting()
						: m.settings_integrations_apiKeyPlaceholderNew()}
					class="input-bordered input w-full"
				/>
			</div>
			{#if tmdbError}
				<div class="alert alert-error">
					<span>{tmdbError}</span>
				</div>
			{/if}
		</div>
		<ModalFooter onCancel={closeTmdbModal} onSave={handleTmdbSave} saving={tmdbSaving} />
	</form>
</ModalWrapper>

<!-- Anime Enrichment Toggle Modal -->
<ModalWrapper open={enrichmentModalOpen} onClose={closeEnrichmentModal} maxWidth="md">
	<ModalHeader title="Anime Metadata Enrichment" onClose={closeEnrichmentModal} />
	<form
		onsubmit={async (event) => {
			event.preventDefault();
			await handleEnrichmentSave();
		}}
	>
		<div class="space-y-4 p-4">
			<p class="text-sm text-base-content/70">
				When enabled, Cinephage automatically queries AniList and MyAnimeList (via Jikan) for anime
				titles during metadata refresh. This supplies alternate and romaji titles for better indexer
				search coverage, and the adult classification used for XXX category searches.
			</p>
			<label class="label cursor-pointer justify-start gap-3">
				<input
					type="checkbox"
					class="checkbox checkbox-primary"
					bind:checked={animeEnrichmentEnabled}
				/>
				<span class="label-text">Enable anime metadata enrichment</span>
			</label>
			{#if enrichmentError}
				<div class="alert alert-error"><span>{enrichmentError}</span></div>
			{/if}
		</div>
		<ModalFooter
			onCancel={closeEnrichmentModal}
			onSave={handleEnrichmentSave}
			saving={enrichmentSaving}
		/>
	</form>
</ModalWrapper>
