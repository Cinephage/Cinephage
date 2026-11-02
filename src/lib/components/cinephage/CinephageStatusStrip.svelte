<script lang="ts">
	import { Loader2 } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { ensureVersionPrefix } from '#lib/version.js';
	import { updateCinephageConfig, testCinephageConnection, ApiError } from '#lib/api/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import type { CinephageConfigView, CinephageIdentityView } from './types.js';

	interface Props {
		config: CinephageConfigView;
		identity: CinephageIdentityView;
		/** Called after a successful master-toggle mutation so the page can reload server data. */
		onChanged: () => Promise<void> | void;
	}

	let { config, identity, onChanged }: Props = $props();

	// ---- Live gateway status (test-result driven, not identity-derived) ----
	type ConnectionStatus = 'untested' | 'testing' | 'success' | 'failed';
	let connectionStatus = $state<ConnectionStatus>('untested');
	let connectionError = $state<string | null>(null);

	const statusDotClass = $derived(
		connectionStatus === 'testing'
			? 'bg-warning animate-pulse'
			: connectionStatus === 'success'
				? 'bg-success'
				: connectionStatus === 'failed'
					? 'bg-error'
					: 'bg-base-content/30'
	);

	const statusLabel = $derived(
		connectionStatus === 'testing'
			? m.settings_cinephage_statusChecking()
			: connectionStatus === 'success'
				? m.settings_cinephage_statusConnected()
				: connectionStatus === 'failed'
					? m.settings_cinephage_statusDisconnected()
					: m.settings_cinephage_statusUntested()
	);

	// Auto health-check once on mount; skip while the subsystem is disabled.
	let autoTestRan = false;
	$effect(() => {
		if (autoTestRan || !config.enabled) return;
		autoTestRan = true;
		void runConnectionTest();
	});

	async function runConnectionTest() {
		connectionStatus = 'testing';
		connectionError = null;
		try {
			const res = await testCinephageConnection();
			if (res.success) {
				connectionStatus = 'success';
			} else {
				connectionStatus = 'failed';
				connectionError = res.error || m.settings_cinephage_requestFailed();
			}
		} catch (err) {
			connectionStatus = 'failed';
			connectionError =
				err instanceof ApiError ? err.message : m.settings_cinephage_requestFailed();
		}
	}

	async function handleToggleSubsystem() {
		const next = !config.enabled;
		try {
			await updateCinephageConfig({ enabled: next });
			await onChanged();
			if (next) void runConnectionTest();
		} catch (err) {
			toasts.add({
				message: err instanceof ApiError ? err.message : m.settings_cinephage_toggleFailed(),
				type: 'error'
			});
		}
	}
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-base-content/70">
	<button
		class="flex items-center gap-2 rounded font-medium"
		onclick={runConnectionTest}
		disabled={connectionStatus === 'testing'}
		title={m.settings_cinephage_testConnection()}
	>
		<span class="inline-block h-2 w-2 rounded-full {statusDotClass}"></span>
		<span class="flex items-center gap-1">
			{#if connectionStatus === 'testing'}
				<Loader2 class="h-3 w-3 animate-spin" />
			{/if}
			{statusLabel}
		</span>
	</button>
	<span class="text-base-content/30">·</span>
	<span class="font-mono text-xs">
		{ensureVersionPrefix(identity.version)}
		{#if identity.commit}
			({identity.commit})
		{:else}
			({m.settings_cinephage_identityUnknown()})
		{/if}
	</span>
	<input
		type="checkbox"
		class="toggle ml-auto toggle-xs"
		checked={config.enabled}
		aria-label={m.settings_cinephage_masterToggle()}
		onchange={handleToggleSubsystem}
	/>
</div>

{#if connectionStatus === 'failed' && connectionError}
	<p class="mt-1 text-xs whitespace-pre-wrap text-error">{connectionError}</p>
{/if}
