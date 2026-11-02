<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Key, Copy, Eye, EyeOff, RefreshCw, Server, Check, AlertCircle } from '@lucide/svelte';
	import type { LayoutData } from '../$types';
	import { untrack } from 'svelte';
	import { copyToClipboard as copyTextToClipboard } from '#lib/utils/clipboard.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import { formatDisplayDate } from '#lib/utils/format.js';
	import { SettingsPage, SettingsSection } from '#lib/components/ui/settings/index.js';
	import {
		createApiKeys,
		regenerateApiKey,
		updateExternalUrl,
		updateArrCompatEnabled
	} from '#lib/api/settings.js';

	let { data }: { data: LayoutData } = $props();

	// =====================
	// API Keys State
	// =====================
	let showMainKey = $state(false);
	let showStreamingKey = $state(false);
	let copiedMain = $state(false);
	let copiedStreaming = $state(false);

	async function copyToClipboard(text: string, type: 'main' | 'streaming') {
		const copied = await copyTextToClipboard(text);
		if (!copied) {
			toasts.error(m.settings_system_failedToCopyApiKey());
			return;
		}

		if (type === 'main') {
			copiedMain = true;
			setTimeout(() => (copiedMain = false), 2000);
		} else {
			copiedStreaming = true;
			setTimeout(() => (copiedStreaming = false), 2000);
		}
	}

	function maskKey(key: string): string {
		if (!key) return '';
		const prefix = key.split('_')[0];
		return `${prefix}_${'\u2022'.repeat(32)}`;
	}

	let regeneratingMain = $state(false);
	let regeneratingStreaming = $state(false);
	let confirmRegenerateOpen = $state(false);
	let regenerateTarget = $state<'main' | 'streaming'>('main');
	let generatingKeys = $state(false);

	async function generateApiKeys() {
		generatingKeys = true;

		try {
			const result = await createApiKeys();

			if (result.success) {
				await refreshAll();
				toasts.success(m.settings_system_apiKeysGenerated());
			}
		} catch (err) {
			toasts.error(
				err instanceof Error ? err.message : m.settings_system_failedToGenerateApiKeys()
			);
		} finally {
			generatingKeys = false;
		}
	}

	function promptRegenerate(type: 'main' | 'streaming') {
		regenerateTarget = type;
		confirmRegenerateOpen = true;
	}

	async function regenerateKey(type: 'main' | 'streaming') {
		confirmRegenerateOpen = false;
		const keyId = type === 'main' ? data.mainApiKey?.id : data.streamingApiKey?.id;
		const label =
			type === 'main' ? m.settings_system_mainLabel() : m.settings_system_mediaStreamingLabel();

		if (!keyId) {
			toasts.error(m.settings_system_noKeyToRegenerate({ label }));
			return;
		}

		if (type === 'main') regeneratingMain = true;
		else regeneratingStreaming = true;

		try {
			const result = await regenerateApiKey(keyId);

			if (result.success && result.data?.key) {
				await refreshAll();
				if (type === 'main') showMainKey = true;
				else showStreamingKey = true;
				toasts.success(m.settings_system_keyRegenerated({ label }));
			}
		} catch (err) {
			toasts.error(
				err instanceof Error ? err.message : m.settings_system_failedToRegenerateKey({ label })
			);
		} finally {
			if (type === 'main') regeneratingMain = false;
			else regeneratingStreaming = false;
		}
	}

	// =====================
	// External URL State
	// =====================
	// Seeded directly from `data` (not via $effect) so SSR and the first
	// client paint already show the real value - $effect doesn't run during
	// SSR, so a `$state('')` + effect-only sync would render the empty
	// default first and only flip to the real value after hydration.
	// untrack() marks this as a deliberate one-time read: this is local,
	// user-editable draft state, not a mirror of `data` - it shouldn't
	// reactively overwrite what the user typed if `data` updates later.
	let externalUrl = $state(untrack(() => data.externalUrl || ''));
	let isSavingUrl = $state(false);
	let saveUrlSuccess = $state(false);
	let saveUrlError = $state('');

	async function saveExternalUrl() {
		isSavingUrl = true;
		saveUrlSuccess = false;
		saveUrlError = '';

		try {
			if (externalUrl && !isValidUrl(externalUrl)) {
				saveUrlError = m.settings_system_invalidUrlFormat();
				return;
			}

			await updateExternalUrl(externalUrl || '');

			saveUrlSuccess = true;
			setTimeout(() => (saveUrlSuccess = false), 3000);
		} catch (err) {
			saveUrlError =
				err instanceof Error ? err.message : m.settings_system_failedToSaveExternalUrl();
		} finally {
			isSavingUrl = false;
		}
	}

	function isValidUrl(url: string): boolean {
		try {
			new URL(url);
			return url.startsWith('http://') || url.startsWith('https://');
		} catch {
			return false;
		}
	}

	// Arr-compat toggle: unsupported, non-priority. The arr projects are good
	// at what they are, but Cinephage is its own thing, and its own behavior
	// takes precedence over arr expectations when the two conflict.

	// =====================
	// Radarr/Sonarr Compatibility
	// =====================
	// Prefer the (unsaved, live) External URL field above so this updates as
	// the user types; fall back to the URL this settings page was loaded
	// from, if an external URL is not set.
	const arrCompatBaseUrl = $derived((externalUrl || page.url.origin).replace(/\/+$/, ''));
	const radarrConnectionUrl = $derived(`${arrCompatBaseUrl}/api/radarr`);
	const sonarrConnectionUrl = $derived(`${arrCompatBaseUrl}/api/sonarr`);
	let copiedRadarrUrl = $state(false);
	let copiedSonarrUrl = $state(false);
	// Seeded directly from `data` (not via $effect) - see externalUrl above
	// for why: $effect doesn't run during SSR, so this would otherwise
	// render "disabled" on first paint and flash to the real value once
	// hydration runs the effect on the client. untrack() marks the one-time
	// read as deliberate - toggleArrCompatEnabled owns updates from here on.
	let arrCompatEnabled = $state(untrack(() => data.arrCompatEnabled ?? false));
	let savingArrCompatEnabled = $state(false);

	async function toggleArrCompatEnabled(event: Event) {
		const next = (event.currentTarget as HTMLInputElement).checked;
		savingArrCompatEnabled = true;

		try {
			await updateArrCompatEnabled(next);
			arrCompatEnabled = next;
			toasts.success(
				next ? m.settings_system_arrCompatEnabled() : m.settings_system_arrCompatDisabled()
			);
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			savingArrCompatEnabled = false;
		}
	}

	async function copyArrUrl(url: string, type: 'radarr' | 'sonarr') {
		const copied = await copyTextToClipboard(url);
		if (!copied) {
			toasts.error(m.settings_system_failedToCopyApiKey());
			return;
		}

		if (type === 'radarr') {
			copiedRadarrUrl = true;
			setTimeout(() => (copiedRadarrUrl = false), 2000);
		} else {
			copiedSonarrUrl = true;
			setTimeout(() => (copiedSonarrUrl = false), 2000);
		}
	}
</script>

<svelte:head>
	<title>{m.settings_system_general_pageTitle()}</title>
</svelte:head>

<SettingsPage title={m.nav_general()} subtitle={m.settings_system_general_subtitle()}>
	<!-- API Authentication Section -->
	<SettingsSection
		title={m.settings_system_apiAuth()}
		description={m.settings_system_apiAuthDescription()}
	>
		{#if !data.mainApiKey && !data.streamingApiKey}
			<div class="alert alert-info">
				<AlertCircle class="h-5 w-5" />
				<div class="flex flex-col gap-2">
					<span>{m.settings_system_noApiKeys()}</span>
					<button
						class="btn w-fit btn-primary btn-sm"
						onclick={generateApiKeys}
						disabled={generatingKeys}
					>
						{#if generatingKeys}
							<RefreshCw class="h-4 w-4 animate-spin" />
							{m.settings_system_generating()}
						{:else}
							<Key class="h-4 w-4" />
							{m.settings_system_generateApiKeys()}
						{/if}
					</button>
				</div>
			</div>
		{/if}

		<!-- Main API Key -->
		<div class="rounded-lg bg-base-100 p-4">
			<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<div class="flex items-center gap-2">
					<Key class="h-5 w-5" />
					<h3 class="text-base font-semibold">{m.settings_system_mainApiKey()}</h3>
				</div>
				<span class="badge badge-primary">{m.settings_system_fullAccess()}</span>
			</div>

			<div class="mt-4">
				<label class="label" for="system-main-api-key">
					<span class="label-text">{m.settings_system_apiKeyLabel()}</span>
				</label>
				<div class="join w-full">
					<input
						id="system-main-api-key"
						type="text"
						class="input-bordered input join-item w-full font-mono"
						value={showMainKey ? data.mainApiKey?.key : maskKey(data.mainApiKey?.key || '')}
						readonly
					/>
					<button
						class="btn join-item btn-ghost"
						onclick={() => (showMainKey = !showMainKey)}
						title={showMainKey ? m.settings_system_hideKey() : m.settings_system_showKey()}
					>
						{#if showMainKey}
							<EyeOff class="h-4 w-4" />
						{:else}
							<Eye class="h-4 w-4" />
						{/if}
					</button>
					<button
						class="btn join-item btn-ghost"
						onclick={() => data.mainApiKey?.key && copyToClipboard(data.mainApiKey.key, 'main')}
						title={m.settings_system_copyToClipboard()}
						disabled={!data.mainApiKey?.key}
					>
						{#if copiedMain}
							<Check class="h-4 w-4 text-success" />
						{:else}
							<Copy class="h-4 w-4" />
						{/if}
					</button>
				</div>
			</div>

			<div
				class="mt-3 flex flex-col gap-3 text-sm text-base-content/70 sm:flex-row sm:items-center sm:justify-between"
			>
				<span
					>{m.settings_system_created()}: {data.mainApiKey?.createdAt
						? formatDisplayDate(String(data.mainApiKey.createdAt))
						: m.common_na()}</span
				>
				<button
					class="btn gap-2 btn-sm btn-warning"
					onclick={() => promptRegenerate('main')}
					disabled={regeneratingMain || regeneratingStreaming}
				>
					{#if regeneratingMain}
						<RefreshCw class="h-4 w-4 animate-spin" />
						{m.settings_system_regenerating()}
					{:else}
						<RefreshCw class="h-4 w-4" />
						{m.settings_system_regenerate()}
					{/if}
				</button>
			</div>
		</div>

		<!-- Media Streaming API Key -->
		<div class="rounded-lg bg-base-100 p-4">
			<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<div class="flex items-center gap-2">
					<Server class="h-5 w-5" />
					<h3 class="text-base font-semibold">{m.settings_system_mediaStreamingApiKey()}</h3>
				</div>
				<span class="badge badge-secondary">{m.settings_system_liveTvStreaming()}</span>
			</div>

			<p class="mt-2 text-sm text-base-content/70">
				{m.settings_system_mediaStreamingDescription()}
			</p>

			<div class="mt-4">
				<label class="label" for="system-streaming-api-key">
					<span class="label-text">{m.settings_system_apiKeyLabel()}</span>
				</label>
				<div class="join w-full">
					<input
						id="system-streaming-api-key"
						type="text"
						class="input-bordered input join-item w-full font-mono"
						value={showStreamingKey
							? data.streamingApiKey?.key
							: maskKey(data.streamingApiKey?.key || '')}
						readonly
					/>
					<button
						class="btn join-item btn-ghost"
						onclick={() => (showStreamingKey = !showStreamingKey)}
						title={showStreamingKey ? m.settings_system_hideKey() : m.settings_system_showKey()}
					>
						{#if showStreamingKey}
							<EyeOff class="h-4 w-4" />
						{:else}
							<Eye class="h-4 w-4" />
						{/if}
					</button>
					<button
						class="btn join-item btn-ghost"
						onclick={() =>
							data.streamingApiKey?.key && copyToClipboard(data.streamingApiKey.key, 'streaming')}
						title={m.settings_system_copyToClipboard()}
						disabled={!data.streamingApiKey?.key}
					>
						{#if copiedStreaming}
							<Check class="h-4 w-4 text-success" />
						{:else}
							<Copy class="h-4 w-4" />
						{/if}
					</button>
				</div>
			</div>

			<div class="mt-2 text-sm text-base-content/70">
				<div class="mb-2 font-semibold">{m.settings_system_permissions()}:</div>
				<ul class="flex flex-wrap gap-2">
					<li>
						<span class="badge badge-sm badge-success">{m.settings_system_permM3u()}</span>
					</li>
					<li>
						<span class="badge badge-sm badge-success">{m.settings_system_permEpg()}</span>
					</li>
					<li>
						<span class="badge badge-sm badge-success">{m.settings_system_permLiveTvStreams()}</span
						>
					</li>
					<li>
						<span class="badge badge-sm badge-success"
							>{m.settings_system_permStreamingContent()}</span
						>
					</li>
					<li>
						<span class="badge badge-sm badge-error">{m.settings_system_permNoLibrary()}</span>
					</li>
					<li>
						<span class="badge badge-sm badge-error">{m.settings_system_permNoSettings()}</span>
					</li>
				</ul>
			</div>

			<div
				class="mt-3 flex flex-col gap-3 text-sm text-base-content/70 sm:flex-row sm:items-center sm:justify-between"
			>
				<span
					>{m.settings_system_created()}: {data.streamingApiKey?.createdAt
						? formatDisplayDate(String(data.streamingApiKey.createdAt))
						: m.common_na()}</span
				>
				<button
					class="btn gap-2 btn-sm btn-warning"
					onclick={() => promptRegenerate('streaming')}
					disabled={regeneratingMain || regeneratingStreaming}
				>
					{#if regeneratingStreaming}
						<RefreshCw class="h-4 w-4 animate-spin" />
						{m.settings_system_regenerating()}
					{:else}
						<RefreshCw class="h-4 w-4" />
						{m.settings_system_regenerate()}
					{/if}
				</button>
			</div>
		</div>
	</SettingsSection>

	<!-- External URL Section -->
	<SettingsSection
		title={m.settings_system_externalUrl()}
		description={m.settings_system_externalUrlDescription()}
	>
		<div class="rounded-lg bg-base-100 p-4">
			<p class="text-sm text-base-content/70">
				{m.settings_system_publicUrlHint()}
			</p>

			<div class="mt-4">
				<label class="label" for="externalUrl">
					<span class="label-text">{m.settings_system_externalUrl()}</span>
				</label>
				<input
					id="externalUrl"
					type="url"
					class="input-bordered input w-full"
					placeholder={m.settings_system_externalUrlPlaceholder()}
					bind:value={externalUrl}
				/>
				{#if saveUrlError}
					<div class="mt-2 flex items-center gap-2 text-sm text-error">
						<AlertCircle class="h-4 w-4" />
						<span>{saveUrlError}</span>
					</div>
				{/if}
				{#if saveUrlSuccess}
					<div class="mt-2 flex items-center gap-2 text-sm text-success">
						<Check class="h-4 w-4" />
						<span>{m.settings_system_externalUrlSaved()}</span>
					</div>
				{/if}
			</div>

			<div class="mt-4 text-sm text-base-content/70">
				<div class="mb-2 font-semibold">{m.settings_system_examples()}:</div>
				<ul class="list-inside list-disc space-y-1">
					<li>{m.settings_system_exampleReverseProxy()}</li>
					<li>{m.settings_system_exampleSubpath()}</li>
					<li>{m.settings_system_exampleEmpty()}</li>
				</ul>
			</div>

			<div class="mt-4 flex justify-end">
				<button
					class="btn w-full gap-2 btn-primary btn-sm sm:w-auto"
					onclick={saveExternalUrl}
					disabled={isSavingUrl}
				>
					{#if isSavingUrl}
						<RefreshCw class="h-4 w-4 animate-spin" />
						{m.common_saving()}
					{:else}
						<Check class="h-4 w-4" />
						{m.settings_system_saveExternalUrl()}
					{/if}
				</button>
			</div>
		</div>
	</SettingsSection>

	<!-- Radarr/Sonarr Compatibility Section -->
	<SettingsSection
		title={m.settings_system_arrCompat()}
		titleBadge={m.common_wip()}
		description={m.settings_system_arrCompatDescription()}
	>
		{#snippet actions()}
			<input
				type="checkbox"
				class="toggle toggle-primary"
				checked={arrCompatEnabled}
				disabled={savingArrCompatEnabled}
				onchange={toggleArrCompatEnabled}
				aria-label={m.settings_system_arrCompat()}
			/>
		{/snippet}

		<div class="rounded-lg bg-base-100 p-4">
			<p class="text-sm text-base-content/70">
				{m.settings_system_arrCompatHint()}
			</p>

			{#if !arrCompatEnabled}
				<div class="mt-3 flex items-center gap-2 text-sm text-warning">
					<AlertCircle class="h-4 w-4" />
					<span>{m.settings_system_arrCompatDisabledHint()}</span>
				</div>
			{/if}

			<div class="mt-4">
				<label class="label" for="radarr-compat-url">
					<span class="label-text">{m.settings_system_radarrUrl()}</span>
				</label>
				<div class="join w-full">
					<input
						id="radarr-compat-url"
						type="text"
						class="input-bordered input join-item w-full font-mono"
						value={radarrConnectionUrl}
						readonly
					/>
					<button
						class="btn join-item btn-ghost"
						onclick={() => copyArrUrl(radarrConnectionUrl, 'radarr')}
						title={m.settings_system_copyToClipboard()}
					>
						{#if copiedRadarrUrl}
							<Check class="h-4 w-4 text-success" />
						{:else}
							<Copy class="h-4 w-4" />
						{/if}
					</button>
				</div>
			</div>

			<div class="mt-4">
				<label class="label" for="sonarr-compat-url">
					<span class="label-text">{m.settings_system_sonarrUrl()}</span>
				</label>
				<div class="join w-full">
					<input
						id="sonarr-compat-url"
						type="text"
						class="input-bordered input join-item w-full font-mono"
						value={sonarrConnectionUrl}
						readonly
					/>
					<button
						class="btn join-item btn-ghost"
						onclick={() => copyArrUrl(sonarrConnectionUrl, 'sonarr')}
						title={m.settings_system_copyToClipboard()}
					>
						{#if copiedSonarrUrl}
							<Check class="h-4 w-4 text-success" />
						{:else}
							<Copy class="h-4 w-4" />
						{/if}
					</button>
				</div>
			</div>
		</div>
	</SettingsSection>
</SettingsPage>

<!-- Regenerate API Key Confirmation -->
<ConfirmationModal
	open={confirmRegenerateOpen}
	title={m.settings_system_regenerateApiKeyTitle()}
	message={m.settings_system_regenerateApiKeyMessage()}
	confirmLabel={m.settings_system_regenerate()}
	confirmVariant="warning"
	loading={regeneratingMain || regeneratingStreaming}
	onConfirm={() => regenerateKey(regenerateTarget)}
	onCancel={() => (confirmRegenerateOpen = false)}
/>
