<script lang="ts">
	import { Loader2, Sparkles, ChevronDown } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import * as m from '#lib/paraglide/messages.js';
	import { ensureVersionPrefix } from '#lib/version.js';
	import { updateCinephageConfig, getGithubRelease, ApiError } from '#lib/api/index.js';
	import type { CinephageConfigView } from './types.js';

	interface Props {
		config: CinephageConfigView;
		/** Called after any successful mutation so the page can reload server data. */
		onChanged: () => Promise<void> | void;
	}

	let { config, onChanged }: Props = $props();

	let fetchingRelease = $state(false);

	async function handleToggleAutoUpdate() {
		try {
			await updateCinephageConfig({ autoUpdate: !config.autoUpdate });
			await onChanged();
		} catch (err) {
			toasts.add({
				message:
					err instanceof ApiError ? err.message : m.settings_cinephage_autoUpdateToggleFailed(),
				type: 'error'
			});
		}
	}

	async function handleSaveOverrides() {
		try {
			await updateCinephageConfig({
				versionOverride: config.versionOverride || null,
				commitOverride: config.commitOverride || null
			});
			await onChanged();
			toasts.add({ message: m.settings_cinephage_overridesSaved(), type: 'success' });
		} catch (err) {
			toasts.add({
				message: err instanceof ApiError ? err.message : m.settings_cinephage_overridesSaveFailed(),
				type: 'error'
			});
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
				toasts.add({
					message: m.settings_cinephage_releaseFilled({ version: res.version, commit: res.commit }),
					type: 'success'
				});
			} else {
				toasts.add({
					message: res.error || m.settings_cinephage_releaseFetchFailed(),
					type: 'error'
				});
			}
		} catch (err) {
			toasts.add({
				message: err instanceof ApiError ? err.message : m.settings_cinephage_releaseFetchFailed(),
				type: 'error'
			});
		} finally {
			fetchingRelease = false;
		}
	}
</script>

<!-- The retiring connection machinery: still functional, deliberately quiet. -->
<details class="group rounded-xl border border-base-300 bg-base-200/40">
	<summary
		class="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm font-medium text-base-content/60 select-none"
	>
		{m.settings_cinephage_advanced()}
		<ChevronDown class="h-4 w-4 transition-transform group-open:rotate-180" />
	</summary>
	<div class="space-y-4 border-t border-base-300 px-4 py-4 text-sm">
		<p class="text-xs text-base-content/50">
			{m.settings_cinephage_identityTelemetryHint()}
		</p>

		<!-- Latest release + auto-update -->
		<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
			<span class="text-base-content/60">
				{m.settings_cinephage_latestRelease()}:
				{#if config.latestVersion}
					<span class="font-mono text-base-content/80">
						{ensureVersionPrefix(config.latestVersion)}
						{#if config.latestCommit}({config.latestCommit}){/if}
					</span>
				{:else}
					<span class="text-base-content/40">—</span>
				{/if}
			</span>
			<button class="btn btn-ghost btn-xs" onclick={handleFetchRelease} disabled={fetchingRelease}>
				{#if fetchingRelease}
					<Loader2 class="h-3 w-3 animate-spin" />
				{:else}
					<Sparkles class="h-3 w-3" />
				{/if}
				{fetchingRelease
					? m.settings_cinephage_fetching()
					: m.settings_cinephage_fetchLatestRelease()}
			</button>
			<label class="flex cursor-pointer items-center gap-2 text-xs">
				<input
					type="checkbox"
					class="toggle toggle-xs"
					checked={config.autoUpdate}
					onchange={handleToggleAutoUpdate}
				/>
				{m.settings_cinephage_autoUpdate()}
			</label>
		</div>

		<!-- Manual overrides -->
		<div class="space-y-2">
			<p class="text-xs text-base-content/50">{m.settings_cinephage_overrideHint()}</p>
			<div class="flex flex-wrap items-end gap-3">
				<label class="form-control max-w-xs">
					<span class="label-text text-xs">{m.settings_cinephage_versionOverride()}</span>
					<input
						type="text"
						class="input-bordered input w-full input-sm"
						placeholder={m.settings_cinephage_autoDetect()}
						bind:value={config.versionOverride}
					/>
				</label>
				<label class="form-control max-w-xs">
					<span class="label-text text-xs">{m.settings_cinephage_commitOverride()}</span>
					<input
						type="text"
						class="input-bordered input w-full input-sm"
						placeholder={m.settings_cinephage_autoDetect()}
						bind:value={config.commitOverride}
					/>
				</label>
				<button class="btn btn-outline btn-sm" onclick={handleSaveOverrides}>
					{m.settings_cinephage_saveSettings()}
				</button>
			</div>
		</div>
	</div>
</details>
