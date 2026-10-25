<script lang="ts">
	import { untrack } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { Sparkles, Loader2 } from '@lucide/svelte';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { ensureVersionPrefix } from '#lib/version.js';
	import {
		updateCinephageConfig,
		updateCinephageModule,
		testCinephageConnection,
		getGithubRelease
	} from '#lib/api/index.js';

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

	let testing = $state(false);
	let testResult = $state<{ success: boolean; error?: string } | null>(null);
	let advancedOpen = $state(false);
	let fetchingRelease = $state(false);

	async function handleToggleSubsystem() {
		try {
			await updateCinephageConfig({ enabled: !config.enabled });
			await refreshAll();
		} catch {
			toasts.add({ message: 'Failed to toggle Cinephage Network', type: 'error' });
		}
	}

	async function handleToggleAutoUpdate() {
		try {
			await updateCinephageConfig({ autoUpdate: !config.autoUpdate });
			await refreshAll();
		} catch {
			toasts.add({ message: 'Failed to toggle auto update', type: 'error' });
		}
	}

	async function handleTestConnection() {
		testing = true;
		testResult = null;
		try {
			const res = await testCinephageConnection();
			testResult = { success: res.success, error: res.error };
		} catch {
			testResult = { success: false, error: 'Request failed' };
		} finally {
			testing = false;
		}
	}

	async function handleToggleModule(moduleId: string, current: boolean) {
		try {
			await updateCinephageModule({ moduleId, enabled: !current });
			await refreshAll();
		} catch {
			toasts.add({ message: 'Failed to toggle module', type: 'error' });
		}
	}

	async function handleSaveModuleSettings(moduleId: string, settings: Record<string, unknown>) {
		try {
			await updateCinephageModule({ moduleId, settings });
			await refreshAll();
			toasts.add({ message: 'Settings saved', type: 'success' });
		} catch {
			toasts.add({ message: 'Failed to save settings', type: 'error' });
		}
	}

	async function handleSaveOverrides() {
		try {
			await updateCinephageConfig({
				versionOverride: config.versionOverride || null,
				commitOverride: config.commitOverride || null
			});
			await refreshAll();
			toasts.add({ message: 'Overrides saved', type: 'success' });
		} catch {
			toasts.add({ message: 'Failed to save overrides', type: 'error' });
		}
	}

	async function handleFetchRelease() {
		fetchingRelease = true;
		try {
			const res = await getGithubRelease();
			if (res.success && res.version && res.commit) {
				config.versionOverride = res.version;
				config.commitOverride = res.commit;
				await updateCinephageConfig({
					versionOverride: res.version,
					commitOverride: res.commit
				});
				toasts.add({ message: `Filled version ${res.version} (${res.commit})`, type: 'success' });
			} else {
				toasts.add({ message: res.error || 'Failed to fetch release', type: 'error' });
			}
		} catch {
			toasts.add({ message: 'Failed to fetch latest release', type: 'error' });
		} finally {
			fetchingRelease = false;
		}
	}
</script>

<SettingsPage title={m.settings_cinephage_heading()} subtitle={m.settings_cinephage_description()}>
	<div class="space-y-8">
		<!-- Subsystem master card -->
		<div class="card bg-base-200">
			<div class="card-body">
				<div class="flex items-center justify-between">
					<div>
						<h2 class="card-title">{m.settings_cinephage_heading()}</h2>
						<p class="text-sm text-base-content/60">
							{identity.isConfigured
								? m.settings_cinephage_statusConnected()
								: m.settings_cinephage_statusDisconnected()}
						</p>
					</div>
					<div class="flex items-center gap-3">
						<button
							class="btn btn-outline btn-sm"
							onclick={handleTestConnection}
							disabled={testing}
						>
							{testing
								? m.settings_cinephage_statusChecking()
								: m.settings_cinephage_testConnection()}
						</button>
						<input
							type="checkbox"
							class="toggle toggle-primary"
							checked={config.enabled}
							onchange={handleToggleSubsystem}
						/>
					</div>
				</div>

				{#if testResult}
					<div
						class="mt-3 rounded-lg p-3 text-sm {testResult.success
							? 'bg-success/10 text-success'
							: 'bg-error/10 text-error'}"
					>
						{testResult.success ? 'Connection successful' : testResult.error}
					</div>
				{/if}

				<div class="mt-4 flex items-center gap-4">
					<span class="text-sm text-base-content/60">
						{m.settings_cinephage_detectedIdentity()}:
						<span class="font-mono text-base-content/80">
							{ensureVersionPrefix(identity.version)}
							{#if identity.commit}
								({identity.commit})
							{:else}
								(unknown)
							{/if}
						</span>
					</span>
					<button
						class="btn gap-1 btn-outline btn-sm"
						onclick={handleFetchRelease}
						disabled={fetchingRelease}
					>
						{#if fetchingRelease}
							<Loader2 class="h-3 w-3 animate-spin" />
						{:else}
							<Sparkles class="h-3 w-3" />
						{/if}
						{fetchingRelease ? 'Fetching...' : 'Fetch latest release'}
					</button>
				</div>

				<div class="mt-3 flex flex-wrap items-center gap-4">
					<span class="text-sm text-base-content/60">
						{m.settings_cinephage_latestRelease()}:
						{#if config.latestVersion}
							<span class="font-mono text-base-content/80">
								{ensureVersionPrefix(config.latestVersion)}
								{#if config.latestCommit}({config.latestCommit}){/if}
							</span>
						{:else}
							<span class="text-base-content/50">—</span>
						{/if}
					</span>
					<label class="flex cursor-pointer items-center gap-2 text-sm">
						<input
							type="checkbox"
							class="toggle toggle-primary toggle-sm"
							checked={config.autoUpdate}
							onchange={handleToggleAutoUpdate}
						/>
						{m.settings_cinephage_autoUpdate()}
					</label>
				</div>

				<!-- Manual overrides -->
				<details class="mt-3" bind:open={advancedOpen}>
					<summary class="cursor-pointer text-sm font-medium">
						{m.settings_cinephage_advanced()}
					</summary>
					<div class="mt-3 space-y-3">
						<p class="text-xs text-base-content/50">
							{m.settings_cinephage_overrideHint()}
						</p>
						<div class="flex flex-wrap items-end gap-3">
							<label class="form-control max-w-xs">
								<span class="label-text text-sm">{m.settings_cinephage_versionOverride()}</span>
								<input
									type="text"
									class="input-bordered input w-full input-sm"
									placeholder="Auto-detect"
									bind:value={config.versionOverride}
								/>
							</label>
							<label class="form-control max-w-xs">
								<span class="label-text text-sm">{m.settings_cinephage_commitOverride()}</span>
								<input
									type="text"
									class="input-bordered input w-full input-sm"
									placeholder="Auto-detect"
									bind:value={config.commitOverride}
								/>
							</label>
							<button class="btn btn-outline btn-sm" onclick={handleSaveOverrides}>
								{m.settings_cinephage_saveSettings()}
							</button>
						</div>
					</div>
				</details>
			</div>
		</div>

		<!-- Module cards -->
		<h3 class="text-lg font-semibold">{m.settings_cinephage_modules()}</h3>

		{#if !config.enabled}
			<p class="text-sm text-base-content/60">
				{m.settings_cinephage_subsystemDisabled()}
			</p>
		{/if}

		<div class="grid gap-4 sm:grid-cols-2">
			{#each modules as mod (mod.moduleId)}
				<div class="card bg-base-200">
					<div class="card-body">
						<div class="flex items-center justify-between">
							<div>
								<h4 class="font-medium">{mod.name}</h4>
								<p class="text-sm text-base-content/60">{mod.description}</p>
							</div>
							<input
								type="checkbox"
								class="toggle toggle-primary toggle-sm"
								checked={mod.enabled}
								disabled={!config.enabled}
								onchange={() => handleToggleModule(mod.moduleId, mod.enabled)}
							/>
						</div>

						{#if mod.moduleId === 'library-streaming'}
							<div class="mt-3 space-y-2">
								<label class="flex cursor-pointer items-center gap-2 text-sm">
									<input
										type="checkbox"
										class="checkbox checkbox-sm checkbox-primary"
										checked={Boolean(mod.settings.useHttps)}
										disabled={!config.enabled}
										onchange={(e) =>
											handleSaveModuleSettings(mod.moduleId, {
												useHttps: (e.target as HTMLInputElement).checked,
												externalHost: (mod.settings.externalHost as string) || ''
											})}
									/>
									{m.settings_cinephage_useHttps()}
								</label>
								<label class="form-control">
									<span class="label-text text-sm">{m.settings_cinephage_externalHost()}</span>
									<input
										type="text"
										class="input-bordered input input-sm"
										placeholder="192.168.1.100:3000"
										disabled={!config.enabled}
										value={(mod.settings.externalHost as string) || ''}
										onchange={(e) =>
											handleSaveModuleSettings(mod.moduleId, {
												useHttps: Boolean(mod.settings.useHttps),
												externalHost: (e.target as HTMLInputElement).value
											})}
									/>
									<span class="label-text-alt text-xs text-base-content/50">
										{m.settings_cinephage_externalHostHint()}
									</span>
								</label>
							</div>
						{/if}

						{#if mod.lastError}
							<div class="mt-2 text-xs text-error">{mod.lastError}</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	</div>
</SettingsPage>
