<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Loader2 } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { SettingsPage, SettingsSection } from '#lib/components/ui/settings/index.js';
	import { ToggleSetting } from '#lib/components/ui/modal/index.js';
	import {
		getRequestSettings,
		saveRequestSettings,
		type RequestSettings
	} from '#lib/api/requests.js';

	let loading = $state(true);
	let saving = $state(false);
	let settings = $state<RequestSettings | null>(null);

	$effect(() => {
		void load();
	});

	async function load() {
		loading = true;
		try {
			const response = await getRequestSettings();
			settings = response.settings;
		} catch {
			toasts.error(m.requests_errorLoad());
		} finally {
			loading = false;
		}
	}

	async function save() {
		if (!settings) return;
		saving = true;
		try {
			const response = await saveRequestSettings(settings);
			settings = response.settings;
			toasts.success(m.requestsSettings_saved());
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : m.requests_errorGeneric());
		} finally {
			saving = false;
		}
	}

	function quotaValue(value: number | null): string {
		return value === null ? '' : String(value);
	}

	function quotaInput(value: string): number | null {
		const parsed = Number(value);
		return value === '' || !Number.isFinite(parsed) ? null : Math.max(0, Math.floor(parsed));
	}
</script>

<svelte:head>
	<title>{m.requestsSettings_title()}</title>
</svelte:head>

<SettingsPage title={m.requestsSettings_title()} subtitle={m.requestsSettings_subtitle()}>
	{#snippet actions()}
		<button
			type="button"
			class="btn gap-1.5 btn-primary btn-sm"
			disabled={saving || loading}
			onclick={save}
		>
			{#if saving}
				<Loader2 class="h-4 w-4 animate-spin" />
			{/if}
			{m.action_save()}
		</button>
	{/snippet}

	{#if loading || !settings}
		<div class="flex items-center justify-center py-16">
			<Loader2 class="h-6 w-6 animate-spin text-base-content/40" />
		</div>
	{:else}
		<SettingsSection title={m.requestsSettings_enabled()}>
			<ToggleSetting
				checked={settings.requestsEnabled}
				label={m.requestsSettings_enabled()}
				description={m.requestsSettings_enabledHint()}
				onchange={() => {
					settings!.requestsEnabled = !settings!.requestsEnabled;
				}}
			/>
		</SettingsSection>

		<SettingsSection
			title={m.requestsSettings_autoApprove()}
			description={m.requestsSettings_autoApproveHint()}
		>
			<div class="space-y-3">
				<ToggleSetting
					checked={settings.autoApprove.movie}
					label={m.requestsSettings_autoApproveMovies()}
					onchange={() => {
						settings!.autoApprove.movie = !settings!.autoApprove.movie;
					}}
				/>
				<ToggleSetting
					checked={settings.autoApprove.series}
					label={m.requestsSettings_autoApproveSeries()}
					onchange={() => {
						settings!.autoApprove.series = !settings!.autoApprove.series;
					}}
				/>
			</div>
		</SettingsSection>

		<SettingsSection title={m.requestsSettings_defaultQuotas()}>
			<div class="grid gap-5 sm:grid-cols-2">
				<div>
					<p class="mb-2 text-sm font-medium">{m.requestsSettings_movieQuota()}</p>
					<div class="flex items-center gap-2">
						<input
							type="number"
							min="0"
							class="input-bordered input w-24 input-sm"
							placeholder="∞"
							aria-label={m.requestsSettings_quotaLimit()}
							value={quotaValue(settings.defaultQuotas.movie.limit)}
							oninput={(e) =>
								(settings!.defaultQuotas.movie.limit = quotaInput(e.currentTarget.value))}
						/>
						<span class="text-xs text-base-content/45">{m.requestsSettings_quotaPer()}</span>
						<input
							type="number"
							min="1"
							class="input-bordered input w-20 input-sm"
							placeholder="days"
							aria-label={m.requestsSettings_quotaDays()}
							value={quotaValue(settings.defaultQuotas.movie.days)}
							oninput={(e) =>
								(settings!.defaultQuotas.movie.days = quotaInput(e.currentTarget.value))}
						/>
					</div>
					<p class="mt-1.5 text-xs text-base-content/45">
						{m.requestsSettings_quotaUnlimitedValue()}
					</p>
				</div>
				<div>
					<p class="mb-2 text-sm font-medium">{m.requestsSettings_tvQuota()}</p>
					<div class="flex items-center gap-2">
						<input
							type="number"
							min="0"
							class="input-bordered input w-24 input-sm"
							placeholder="∞"
							aria-label={m.requestsSettings_quotaLimit()}
							value={quotaValue(settings.defaultQuotas.tv.limit)}
							oninput={(e) =>
								(settings!.defaultQuotas.tv.limit = quotaInput(e.currentTarget.value))}
						/>
						<span class="text-xs text-base-content/45">{m.requestsSettings_quotaPer()}</span>
						<input
							type="number"
							min="1"
							class="input-bordered input w-20 input-sm"
							placeholder="days"
							aria-label={m.requestsSettings_quotaDays()}
							value={quotaValue(settings.defaultQuotas.tv.days)}
							oninput={(e) => (settings!.defaultQuotas.tv.days = quotaInput(e.currentTarget.value))}
						/>
					</div>
					<div class="mt-2 flex items-center gap-2">
						<select class="select-bordered select select-xs" bind:value={settings.tvQuotaUnit}>
							<option value="episodes">{m.requestsSettings_tvUnitEpisodes()}</option>
							<option value="seasons">{m.requestsSettings_tvUnitSeasons()}</option>
						</select>
						<span class="text-xs text-base-content/45">{m.requestsSettings_tvUnit()}</span>
					</div>
				</div>
			</div>
		</SettingsSection>

		<SettingsSection title={m.requestsSettings_lifetime()}>
			<div class="grid gap-5 sm:grid-cols-2">
				<div>
					<p class="mb-2 text-sm font-medium">{m.requestsSettings_ttl()}</p>
					<div class="flex items-center gap-2">
						<input
							type="number"
							min="0"
							class="input-bordered input w-20 input-sm"
							bind:value={settings.pendingTtlDays}
						/>
						<span class="text-xs text-base-content/45">{m.requestsSettings_quotaDays()}</span>
					</div>
					<p class="mt-1.5 text-xs text-base-content/45">{m.requestsSettings_ttlHint()}</p>
				</div>
				<div>
					<p class="mb-2 text-sm font-medium">{m.requestsSettings_cooldown()}</p>
					<div class="flex items-center gap-2">
						<input
							type="number"
							min="0"
							class="input-bordered input w-20 input-sm"
							bind:value={settings.reRequestCooldownDays}
						/>
						<span class="text-xs text-base-content/45">{m.requestsSettings_quotaDays()}</span>
					</div>
					<p class="mt-1.5 text-xs text-base-content/45">{m.requestsSettings_cooldownHint()}</p>
				</div>
			</div>
		</SettingsSection>
	{/if}
</SettingsPage>
