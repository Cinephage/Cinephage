<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { HardDrive, Trash2, RefreshCw, Archive, Clock } from '@lucide/svelte';
	import { cleanupStreamingCache } from '#lib/api/settings.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { SettingsPage, SettingsSection } from '#lib/components/ui/settings/index.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let cleaning = $state(false);
	let cleanupResult = $state<{ cleaned: number; freedMB: number } | null>(null);

	async function handleCleanup() {
		cleaning = true;
		try {
			const result = await cleanupStreamingCache();

			cleanupResult = {
				cleaned: ((result as Record<string, unknown>).cleaned as number) ?? 0,
				freedMB: ((result as Record<string, unknown>).freedMB as number) ?? 0
			};
			toasts.success(m.settings_streaming_expiredCleaned());
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : m.settings_streaming_failedToClean());
		} finally {
			cleaning = false;
		}
	}
</script>

<svelte:head>
	<title>{m.nav_streaming()}</title>
</svelte:head>

<SettingsPage
	title={m.settings_streaming_heading()}
	subtitle={m.settings_streaming_extractionCacheDescription()}
>
	<!-- Extraction Cache Section -->
	<SettingsSection title={m.settings_streaming_extractionCache()}>
		<!-- Cache Stats -->
		<div class="stats w-full stats-vertical bg-base-100 shadow lg:stats-horizontal">
			<div class="stat">
				<div class="stat-figure text-primary">
					<Archive class="h-6 w-6" />
				</div>
				<div class="stat-title">{m.settings_streaming_cachedFiles()}</div>
				<div class="stat-value text-primary">{data.cacheStats.fileCount}</div>
			</div>

			<div class="stat">
				<div class="stat-figure text-secondary">
					<HardDrive class="h-6 w-6" />
				</div>
				<div class="stat-title">{m.settings_streaming_cacheSize()}</div>
				<div class="stat-value text-secondary">
					{data.cacheStats.totalSizeMB >= 1024
						? `${(data.cacheStats.totalSizeMB / 1024).toFixed(1)} GB`
						: `${data.cacheStats.totalSizeMB} MB`}
				</div>
			</div>

			<div class="stat">
				<div class="stat-figure text-warning">
					<Clock class="h-6 w-6" />
				</div>
				<div class="stat-title">{m.settings_streaming_expired()}</div>
				<div class="stat-value text-warning">{data.cacheStats.expiredCount}</div>
				<div class="stat-desc">{m.settings_streaming_pendingCleanup()}</div>
			</div>
		</div>

		<!-- Cleanup Action -->
		<div>
			{#if cleanupResult}
				<div class="mb-4 alert alert-success">
					<span>
						{m.settings_streaming_cleanedUpResult({
							count: String(cleanupResult.cleaned),
							size:
								cleanupResult.freedMB >= 1024
									? `${(cleanupResult.freedMB / 1024).toFixed(1)} GB`
									: `${cleanupResult.freedMB} MB`
						})}
					</span>
				</div>
			{/if}

			<button
				class="btn gap-2 btn-outline btn-sm btn-warning"
				onclick={handleCleanup}
				disabled={cleaning}
			>
				{#if cleaning}
					<RefreshCw class="h-4 w-4 animate-spin" />
					{m.settings_streaming_cleaning()}
				{:else}
					<Trash2 class="h-4 w-4" />
					{m.settings_streaming_cleanExpiredFiles()}
				{/if}
			</button>
		</div>
	</SettingsSection>

	<!-- Cache Settings -->
	<SettingsSection title={m.settings_streaming_cacheSettings()}>
		<div class="form-control w-full max-w-xs">
			<label class="label" for="retention">
				<span class="label-text">{m.settings_streaming_retentionPeriod()}</span>
			</label>
			<select id="retention" class="select-bordered select select-sm" disabled>
				<option value="24">{m.settings_streaming_hours24()}</option>
				<option value="48" selected>{m.settings_streaming_hours48Default()}</option>
				<option value="72">{m.settings_streaming_hours72()}</option>
				<option value="168">{m.settings_streaming_week1()}</option>
			</select>
			<div class="label">
				<span class="label-text-alt text-base-content/50">
					{m.settings_streaming_retentionHint()}
				</span>
			</div>
		</div>

		<div class="alert alert-info">
			<span>{m.settings_streaming_cacheDefaultsNotice()}</span>
		</div>
	</SettingsSection>

	<!-- How It Works -->
	<SettingsSection title={m.settings_streaming_howItWorks()}>
		<div class="prose-sm prose max-w-none">
			<ol class="space-y-2">
				<li>
					<strong>{m.settings_streaming_stepDetection()}:</strong>
					{m.settings_streaming_stepDetectionDesc()}
				</li>
				<li>
					<strong>{m.settings_streaming_stepDownload()}:</strong>
					{m.settings_streaming_stepDownloadDesc()}
				</li>
				<li>
					<strong>{m.settings_streaming_stepExtraction()}:</strong>
					{m.settings_streaming_stepExtractionDesc()}
				</li>
				<li>
					<strong>{m.settings_streaming_stepStreaming()}:</strong>
					{m.settings_streaming_stepStreamingDesc()}
				</li>
				<li>
					<strong>{m.settings_streaming_stepCleanup()}:</strong>
					{m.settings_streaming_stepCleanupDesc()}
				</li>
			</ol>
		</div>
	</SettingsSection>
</SettingsPage>
