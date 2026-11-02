<script lang="ts">
	import { untrack } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import {
		CinephageAdvancedCard,
		CinephageInstallKeyCard,
		CinephageModuleRow,
		CinephageStatusStrip
	} from '#lib/components/cinephage/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { updateCinephageModule, ApiError } from '#lib/api/index.js';

	let { data } = $props();

	// untrack prevents Svelte from treating data.x reads as reactive dependencies
	// inside $state() initializers. The $effect below re-syncs on data changes.
	let config = $state(untrack(() => data.config));
	let modules = $state(untrack(() => data.modules));
	let identity = $state(untrack(() => data.identity));

	$effect(() => {
		config = data.config;
		modules = data.modules;
		identity = data.identity;
	});

	async function refresh() {
		await refreshAll();
	}

	async function handleToggleModule(moduleId: string, current: boolean) {
		try {
			await updateCinephageModule({ moduleId, enabled: !current });
			await refresh();
		} catch (err) {
			toasts.add({
				message: err instanceof ApiError ? err.message : m.settings_cinephage_moduleToggleFailed(),
				type: 'error'
			});
		}
	}

	async function handleSaveModuleSettings(moduleId: string, settings: Record<string, unknown>) {
		try {
			await updateCinephageModule({ moduleId, settings });
			await refresh();
			toasts.add({ message: m.settings_cinephage_moduleSettingsSaved(), type: 'success' });
		} catch (err) {
			toasts.add({
				message:
					err instanceof ApiError ? err.message : m.settings_cinephage_moduleSettingsSaveFailed(),
				type: 'error'
			});
		}
	}
</script>

<SettingsPage title={m.settings_cinephage_heading()} subtitle={m.settings_cinephage_description()}>
	<div class="mx-auto max-w-2xl space-y-6">
		<!-- Tier 1: the install key is what this page is -->
		<CinephageInstallKeyCard installKey={config.installKey} onChanged={refresh} />

		<!-- Tier 2: live status + modules -->
		<CinephageStatusStrip {config} {identity} onChanged={refresh} />

		<section class="space-y-2">
			<h3 class="text-sm font-semibold text-base-content/70">{m.settings_cinephage_modules()}</h3>
			{#if !config.enabled}
				<p class="text-xs text-base-content/50">{m.settings_cinephage_subsystemDisabled()}</p>
			{/if}
			<div class="space-y-2">
				{#each modules as mod (mod.moduleId)}
					<CinephageModuleRow
						module={mod}
						disabled={!config.enabled}
						onToggle={handleToggleModule}
						onSaveSettings={handleSaveModuleSettings}
					/>
				{/each}
			</div>
		</section>

		<!-- Tier 3: the retiring machinery, collapsed -->
		<CinephageAdvancedCard {config} onChanged={refresh} />
	</div>
</SettingsPage>
