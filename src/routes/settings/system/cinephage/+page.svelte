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
		getGithubRelease,
		registerCinephageInstall,
		revokeCinephageInstall
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

	// ---- Install key (per-install gateway identity) ----
	let keyEmail = $state(untrack(() => data.config.installKey?.registrationEmail ?? ''));
	let registering = $state(false);
	let revoking = $state(false);
	let revealedKey = $state<{ key: string; rotated: boolean } | null>(null);
	let manualKey = $state('');
	let keyCopied = $state(false);

	async function handleRegisterKey() {
		registering = true;
		revealedKey = null;
		keyCopied = false;
		try {
			const res = await registerCinephageInstall({ email: keyEmail });
			if (res.success && res.key) {
				revealedKey = { key: res.key, rotated: res.rotated ?? false };
				toasts.add({
					message: res.rotated
						? 'Install key rotated — previous key no longer works'
						: 'Install registered',
					type: 'success'
				});
				await refreshAll();
			} else {
				toasts.add({
					message: res.error || m.settings_cinephage_installKey_rateLimited(),
					type: 'error'
				});
			}
		} catch {
			toasts.add({ message: 'Registration failed', type: 'error' });
		} finally {
			registering = false;
		}
	}

	async function handleRevokeKey() {
		revoking = true;
		try {
			const res = await revokeCinephageInstall();
			if (res.success) {
				toasts.add({ message: 'Install key revoked', type: 'success' });
				revealedKey = null;
				await refreshAll();
			} else {
				toasts.add({ message: res.error || 'Revoke failed', type: 'error' });
			}
		} catch {
			toasts.add({ message: 'Revoke failed', type: 'error' });
		} finally {
			revoking = false;
		}
	}

	async function handleSaveManualKey() {
		if (!manualKey.trim()) return;
		try {
			await updateCinephageConfig({ apiKey: manualKey.trim() });
			manualKey = '';
			toasts.add({ message: 'Install key saved', type: 'success' });
			await refreshAll();
		} catch {
			toasts.add({ message: 'Failed to save install key', type: 'error' });
		}
	}

	async function copyRevealedKey() {
		if (!revealedKey) return;
		try {
			await navigator.clipboard.writeText(revealedKey.key);
			keyCopied = true;
		} catch {
			/* clipboard unavailable; the key remains selectable on screen */
		}
	}

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

		<!-- Install key card -->
		<div class="card bg-base-200">
			<div class="card-body">
				<div class="flex items-center justify-between">
					<div>
						<h2 class="card-title">{m.settings_cinephage_installKey_heading()}</h2>
						<p class="text-sm text-base-content/60">
							{m.settings_cinephage_installKey_description()}
						</p>
					</div>
					{#if config.installKey?.registered}
						<div class="badge gap-1 badge-success">
							{m.settings_cinephage_installKey_registeredAs()}
							{#if config.installKey.keyPrefix}
								<span class="font-mono">{config.installKey.keyPrefix}…</span>
							{/if}
						</div>
					{:else}
						<div class="badge badge-ghost">
							{m.settings_cinephage_installKey_notRegistered()}
						</div>
					{/if}
				</div>

				<div class="mt-3 flex flex-wrap items-end gap-3">
					<label class="form-control w-full max-w-xs">
						<span class="label-text text-sm">{m.settings_cinephage_installKey_email()}</span>
						<input
							type="email"
							class="input-bordered input w-full input-sm"
							placeholder="admin@example.com"
							bind:value={keyEmail}
						/>
						<span class="label-text-alt text-base-content/50">
							{m.settings_cinephage_installKey_emailHint()}
						</span>
					</label>
					<button
						class="btn btn-primary btn-sm"
						onclick={handleRegisterKey}
						disabled={registering || !keyEmail.includes('@')}
					>
						{#if registering}
							<Loader2 class="h-3 w-3 animate-spin" />
						{/if}
						{config.installKey?.registered
							? m.settings_cinephage_installKey_rotate()
							: m.settings_cinephage_installKey_register()}
					</button>
					{#if config.installKey?.registered}
						<button
							class="btn btn-outline btn-error btn-sm"
							onclick={handleRevokeKey}
							disabled={revoking}
						>
							{m.settings_cinephage_installKey_revoke()}
						</button>
					{/if}
				</div>

				{#if config.installKey?.installId}
					<p class="mt-2 text-xs text-base-content/50">
						{m.settings_cinephage_installKey_installId()}:
						<span class="font-mono">{config.installKey.installId}</span>
					</p>
				{/if}

				{#if revealedKey}
					<div class="mt-3 rounded-lg bg-warning/10 p-3">
						<p class="text-xs text-warning">{m.settings_cinephage_installKey_shownOnce()}</p>
						<div class="mt-2 flex items-center gap-2">
							<code class="flex-1 overflow-x-auto rounded bg-base-300 px-2 py-1 font-mono text-sm">
								{revealedKey.key}
							</code>
							<button class="btn btn-sm" onclick={copyRevealedKey}>
								{keyCopied ? '✓' : m.settings_cinephage_installKey_copy()}
							</button>
						</div>
					</div>
				{/if}

				<details class="mt-3">
					<summary class="cursor-pointer text-sm font-medium">
						{m.settings_cinephage_installKey_manual()}
					</summary>
					<div class="mt-3 space-y-2">
						<p class="text-xs text-base-content/50">
							{m.settings_cinephage_installKey_manualHint()}
						</p>
						<div class="flex flex-wrap items-end gap-3">
							<label class="form-control w-full max-w-xs">
								<input
									type="password"
									class="input-bordered input w-full font-mono input-sm"
									placeholder="ck_…"
									bind:value={manualKey}
									autocomplete="off"
								/>
							</label>
							<button class="btn btn-outline btn-sm" onclick={handleSaveManualKey}>
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
