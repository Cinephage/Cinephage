<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		Shield,
		Globe,
		CheckCircle,
		XCircle,
		Activity,
		Clock,
		Trash2,
		Play,
		RefreshCw,
		AlertCircle
	} from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { formatDisplayDate } from '#lib/utils/format.js';
	import { SettingsPage, SettingsSection } from '#lib/components/ui/settings/index.js';
	import {
		getCaptchaSolverHealth,
		getCaptchaSolverSettings,
		updateCaptchaSolverSettings,
		testCaptchaSolver,
		clearCaptchaSolverCache
	} from '#lib/api/monitoring.js';
	import type { CaptchaSolverSettingsUpdate } from '#lib/validation/schemas.js';

	// =====================
	// Captcha Solver State
	// =====================
	interface SolverHealth {
		available: boolean;
		status: 'ready' | 'busy' | 'error' | 'disabled' | 'initializing';
		browserAvailable: boolean;
		error?: string;
		stats: {
			totalAttempts: number;
			successCount: number;
			failureCount: number;
			cacheHits: number;
			avgSolveTimeMs: number;
			cacheSize: number;
			fetchAttempts: number;
			fetchSuccessCount: number;
			fetchFailureCount: number;
			avgFetchTimeMs: number;
			lastSolveAt?: string;
			lastFetchAt?: string;
			lastError?: string;
		};
	}

	interface SolverSettings {
		enabled: boolean;
		timeoutSeconds: number;
		cacheTtlSeconds: number;
		headless: boolean;
		proxyUrl: string;
		proxyUsername: string;
		proxyPassword: string;
	}

	let captchaLoading = $state(true);
	let captchaSaving = $state(false);
	let captchaTesting = $state(false);
	let captchaClearing = $state(false);
	let health = $state<SolverHealth | null>(null);
	let captchaSettings = $state<SolverSettings>({
		enabled: false,
		timeoutSeconds: 60,
		cacheTtlSeconds: 3600,
		headless: true,
		proxyUrl: '',
		proxyUsername: '',
		proxyPassword: ''
	});
	let testUrl = $state('');
	let testResult = $state<{ success: boolean; message: string } | null>(null);
	let captchaSaveError = $state<string | null>(null);
	let captchaSaveSuccess = $state(false);

	async function loadCaptchaData() {
		captchaLoading = true;
		try {
			const [healthRes, settingsRes] = await Promise.all([
				getCaptchaSolverHealth(),
				getCaptchaSolverSettings()
			]);

			health = (healthRes as Record<string, unknown>).health as SolverHealth | null;
			captchaSettings = (settingsRes as Record<string, unknown>).settings as SolverSettings;
		} catch (error) {
			toasts.error(m.settings_integrations_captcha_failedToLoad(), {
				description:
					error instanceof Error ? error.message : m.settings_integrations_captcha_failedToLoad()
			});
		} finally {
			captchaLoading = false;
		}
	}

	// Load captcha data on mount
	$effect(() => {
		loadCaptchaData();
	});

	// Poll while initializing
	$effect(() => {
		if (health?.status !== 'initializing') return;

		const pollInterval = setInterval(async () => {
			try {
				const res = await getCaptchaSolverHealth();
				health = (res as Record<string, unknown>).health as SolverHealth | null;
			} catch {
				// Ignore errors during polling
			}
		}, 2000);

		return () => clearInterval(pollInterval);
	});

	async function saveCaptchaSettings() {
		captchaSaving = true;
		captchaSaveError = null;
		captchaSaveSuccess = false;

		try {
			const result = await updateCaptchaSolverSettings(
				captchaSettings as CaptchaSolverSettingsUpdate
			);

			captchaSettings = result.settings;
			captchaSaveSuccess = true;
			await loadCaptchaData();

			setTimeout(() => {
				captchaSaveSuccess = false;
			}, 3000);
		} catch (error) {
			captchaSaveError =
				error instanceof Error
					? error.message
					: m.settings_integrations_captcha_failedToSaveSettings();
		} finally {
			captchaSaving = false;
		}
	}

	async function testSolver() {
		if (!testUrl) return;
		captchaTesting = true;
		testResult = null;

		try {
			const result = await testCaptchaSolver({ url: testUrl });

			if (result.success) {
				if (result.hasChallenge) {
					testResult = {
						success: true,
						message: m.settings_integrations_captcha_solvedChallengeIn({
							challengeType: String(result.challengeType ?? ''),
							solveTimeMs: String(result.solveTimeMs ?? '')
						})
					};
				} else {
					testResult = {
						success: true,
						message: result.message || m.settings_integrations_captcha_noChallengeDetected()
					};
				}
			} else {
				testResult = {
					success: false,
					message: result.error || m.settings_integrations_captcha_testFailed()
				};
			}

			await loadCaptchaData();
		} catch (error) {
			testResult = {
				success: false,
				message:
					error instanceof Error ? error.message : m.settings_integrations_captcha_testFailed()
			};
		} finally {
			captchaTesting = false;
		}
	}

	async function clearCache() {
		captchaClearing = true;
		try {
			await clearCaptchaSolverCache();
			await loadCaptchaData();
		} catch (error) {
			toasts.error(m.settings_integrations_captcha_failedToClearCache(), {
				description:
					error instanceof Error
						? error.message
						: m.settings_integrations_captcha_failedToClearCache()
			});
		} finally {
			captchaClearing = false;
		}
	}

	function formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function getSuccessRate(): string {
		if (!health?.stats.totalAttempts) return '0%';
		const rate = (health.stats.successCount / health.stats.totalAttempts) * 100;
		return `${rate.toFixed(1)}%`;
	}

	function getFetchSuccessRate(): string {
		if (!health?.stats.fetchAttempts) return '0%';
		const rate = (health.stats.fetchSuccessCount / health.stats.fetchAttempts) * 100;
		return `${rate.toFixed(1)}%`;
	}
</script>

<svelte:head>
	<title>{m.settings_integrations_captcha_pageTitle()}</title>
</svelte:head>

<SettingsPage title={m.nav_captchaSolver()} subtitle={m.settings_integrations_captcha_subtitle()}>
	{#if captchaLoading}
		<div class="flex items-center justify-center py-12">
			<RefreshCw class="h-6 w-6 animate-spin text-primary" />
		</div>
	{:else}
		<!-- Status Banner -->
		<div>
			{#if health?.status === 'initializing'}
				<div class="alert flex items-center gap-2 alert-info">
					<RefreshCw class="h-5 w-5 animate-spin" />
					<div>
						<span class="font-medium">{m.settings_integrations_captcha_statusInitializing()}</span>
						<p class="text-sm">{m.settings_integrations_captcha_statusInitializingDesc()}</p>
					</div>
				</div>
			{:else if health?.available}
				<div class="alert flex items-center gap-2 alert-success">
					<CheckCircle class="h-5 w-5" />
					<span>{m.settings_integrations_captcha_statusReady()}</span>
					{#if health.status === 'busy'}
						<span class="badge badge-warning">{m.settings_integrations_captcha_statusBusy()}</span>
					{/if}
				</div>
			{:else if captchaSettings.enabled && !health?.browserAvailable}
				<div class="alert flex items-center gap-2 alert-error">
					<XCircle class="h-5 w-5" />
					<div>
						<span class="font-medium">{m.settings_integrations_captcha_browserNotAvailable()}</span>
						<p class="text-sm">
							{health?.error || m.settings_integrations_captcha_browserNotAvailableDesc()}
						</p>
					</div>
				</div>
			{:else}
				<div class="alert flex items-center gap-2 alert-warning">
					<AlertCircle class="h-5 w-5" />
					<span>{m.settings_integrations_captcha_statusDisabled()}</span>
				</div>
			{/if}
		</div>

		<!-- Captcha Settings -->
		<SettingsSection
			title={m.nav_settings()}
			description={m.settings_integrations_captcha_subtitle()}
		>
			{#if captchaSaveError}
				<div class="alert alert-error">
					<XCircle class="h-4 w-4" />
					<span>{captchaSaveError}</span>
				</div>
			{/if}

			{#if captchaSaveSuccess}
				<div class="alert alert-success">
					<CheckCircle class="h-4 w-4" />
					<span>{m.settings_integrations_captcha_settingsSaved()}</span>
				</div>
			{/if}

			<div class="space-y-6">
				<!-- Enable Toggle -->
				<div class="form-control">
					<label
						class="label w-full cursor-pointer items-start justify-start gap-3 py-0 whitespace-normal"
					>
						<input
							type="checkbox"
							bind:checked={captchaSettings.enabled}
							class="toggle mt-0.5 shrink-0 toggle-primary"
						/>
						<div class="min-w-0">
							<span class="label-text block font-medium whitespace-normal">
								{m.settings_integrations_captcha_enableLabel()}
							</span>
							<p
								class="text-sm leading-relaxed wrap-break-word whitespace-normal text-base-content/60"
							>
								{m.settings_integrations_captcha_enableDesc()}
							</p>
						</div>
					</label>
				</div>

				<div class="divider text-sm">{m.settings_integrations_captcha_timing()}</div>

				<div class="grid gap-4 sm:grid-cols-2">
					<!-- Timeout -->
					<div class="form-control w-full min-w-0">
						<label class="label flex-wrap items-start gap-2 whitespace-normal" for="timeout">
							<span class="label-text">{m.settings_integrations_captcha_solveTimeout()}</span>
						</label>
						<select
							id="timeout"
							bind:value={captchaSettings.timeoutSeconds}
							class="select-bordered select w-full max-w-full min-w-0 select-sm"
							disabled={!captchaSettings.enabled}
						>
							<option value={30}>{m.settings_integrations_captcha_seconds30()}</option>
							<option value={60}>{m.settings_integrations_captcha_seconds60Default()}</option>
							<option value={90}>{m.settings_integrations_captcha_seconds90()}</option>
							<option value={120}>{m.settings_integrations_captcha_minutes2()}</option>
							<option value={180}>{m.settings_integrations_captcha_minutes3()}</option>
						</select>
						<div class="label whitespace-normal">
							<span class="label-text-alt wrap-break-word text-base-content/50">
								{m.settings_integrations_captcha_solveTimeoutHelp()}
							</span>
						</div>
					</div>

					<!-- Cache TTL -->
					<div class="form-control w-full min-w-0">
						<label class="label flex-wrap items-start gap-2 whitespace-normal" for="cacheTtl">
							<span class="label-text">{m.settings_integrations_captcha_cacheDuration()}</span>
						</label>
						<select
							id="cacheTtl"
							bind:value={captchaSettings.cacheTtlSeconds}
							class="select-bordered select w-full max-w-full min-w-0 select-sm"
							disabled={!captchaSettings.enabled}
						>
							<option value={1800}>{m.settings_integrations_captcha_minutes30()}</option>
							<option value={3600}>{m.settings_integrations_captcha_hour1Default()}</option>
							<option value={7200}>{m.settings_integrations_captcha_hours2()}</option>
							<option value={14400}>{m.settings_integrations_captcha_hours4()}</option>
							<option value={28800}>{m.settings_integrations_captcha_hours8()}</option>
							<option value={86400}>{m.settings_integrations_captcha_hours24()}</option>
						</select>
						<div class="label whitespace-normal">
							<span class="label-text-alt wrap-break-word text-base-content/50">
								{m.settings_integrations_captcha_cacheDurationHelp()}
							</span>
						</div>
					</div>
				</div>

				<div class="divider text-sm">
					<Globe class="h-4 w-4" />
					{m.settings_integrations_captcha_proxyOptional()}
				</div>

				<!-- Proxy URL -->
				<div class="form-control w-full min-w-0">
					<label class="label flex-wrap items-start gap-2 whitespace-normal" for="proxyUrl">
						<span class="label-text">{m.settings_integrations_captcha_proxyUrl()}</span>
					</label>
					<input
						id="proxyUrl"
						type="text"
						bind:value={captchaSettings.proxyUrl}
						placeholder={m.settings_integrations_captcha_proxyPlaceholder()}
						class="input-bordered input w-full min-w-0 input-sm"
						disabled={!captchaSettings.enabled}
					/>
					<div class="label whitespace-normal">
						<span class="label-text-alt wrap-break-word text-base-content/50">
							{m.settings_integrations_captcha_proxyUrlHelp()}
						</span>
					</div>
				</div>

				<!-- Proxy Auth -->
				{#if captchaSettings.proxyUrl}
					<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<div class="form-control min-w-0">
							<label
								class="label flex-wrap items-start gap-2 whitespace-normal"
								for="proxyUsername"
							>
								<span class="label-text">{m.settings_integrations_captcha_proxyUsername()}</span>
							</label>
							<input
								id="proxyUsername"
								type="text"
								bind:value={captchaSettings.proxyUsername}
								placeholder={m.settings_integrations_captcha_optional()}
								class="input-bordered input w-full min-w-0 input-sm"
								disabled={!captchaSettings.enabled}
							/>
						</div>
						<div class="form-control min-w-0">
							<label
								class="label flex-wrap items-start gap-2 whitespace-normal"
								for="proxyPassword"
							>
								<span class="label-text">{m.settings_integrations_captcha_proxyPassword()}</span>
							</label>
							<input
								id="proxyPassword"
								type="password"
								bind:value={captchaSettings.proxyPassword}
								placeholder={m.settings_integrations_captcha_optional()}
								class="input-bordered input w-full min-w-0 input-sm"
								disabled={!captchaSettings.enabled}
							/>
						</div>
					</div>
				{/if}
			</div>

			<div class="flex justify-end">
				<button
					class="btn w-full gap-2 btn-primary btn-sm sm:w-auto"
					onclick={saveCaptchaSettings}
					disabled={captchaSaving}
				>
					{#if captchaSaving}
						<RefreshCw class="h-4 w-4 animate-spin" />
						{m.common_saving()}
					{:else}
						<CheckCircle class="h-4 w-4" />
						{m.settings_integrations_captcha_saveSettings()}
					{/if}
				</button>
			</div>
		</SettingsSection>

		<!-- Test Solver -->
		<SettingsSection
			title={m.settings_integrations_captcha_testSolver()}
			description={m.settings_integrations_captcha_testSolverDesc()}
		>
			<div class="flex flex-col gap-2 sm:flex-row">
				<input
					type="url"
					bind:value={testUrl}
					placeholder={m.settings_integrations_captcha_testUrlPlaceholder()}
					class="input-bordered input w-full min-w-0 input-sm sm:flex-1"
					disabled={captchaTesting || !captchaSettings.enabled}
				/>
				<button
					class="btn w-full gap-2 btn-primary btn-sm sm:w-auto"
					onclick={testSolver}
					disabled={captchaTesting || !testUrl || !captchaSettings.enabled}
				>
					{#if captchaTesting}
						<RefreshCw class="h-4 w-4 animate-spin" />
						{m.common_testing()}
					{:else}
						<Play class="h-4 w-4" />
						{m.action_test()}
					{/if}
				</button>
			</div>

			{#if testResult}
				<div class="alert {testResult.success ? 'alert-success' : 'alert-error'}">
					{#if testResult.success}
						<CheckCircle class="h-4 w-4" />
					{:else}
						<XCircle class="h-4 w-4" />
					{/if}
					<span>{testResult.message}</span>
				</div>
			{/if}
		</SettingsSection>

		<!-- Statistics -->
		{#if health?.stats}
			<SettingsSection title={m.settings_integrations_captcha_statistics()}>
				<div class="stats w-full stats-vertical bg-base-100 shadow lg:stats-horizontal">
					<div class="stat">
						<div class="stat-figure text-primary">
							<Activity class="h-6 w-6" />
						</div>
						<div class="stat-title">{m.settings_integrations_captcha_solveSuccessRate()}</div>
						<div class="stat-value text-primary">{getSuccessRate()}</div>
						<div class="stat-desc">
							{m.settings_integrations_captcha_solvesAttempted({
								count: health.stats.totalAttempts
							})}
						</div>
					</div>

					<div class="stat">
						<div class="stat-figure text-secondary">
							<Clock class="h-6 w-6" />
						</div>
						<div class="stat-title">{m.settings_integrations_captcha_avgSolveTime()}</div>
						<div class="stat-value text-secondary">
							{formatDuration(health.stats.avgSolveTimeMs)}
						</div>
					</div>

					<div class="stat">
						<div class="stat-figure text-secondary">
							<Globe class="h-6 w-6" />
						</div>
						<div class="stat-title">{m.settings_integrations_captcha_fetchSuccessRate()}</div>
						<div class="stat-value text-secondary">{getFetchSuccessRate()}</div>
						<div class="stat-desc">
							{m.settings_integrations_captcha_fetchesAttempted({
								count: health.stats.fetchAttempts
							})}
						</div>
					</div>

					<div class="stat">
						<div class="stat-figure text-accent">
							<Shield class="h-6 w-6" />
						</div>
						<div class="stat-title">{m.settings_integrations_captcha_cacheHits()}</div>
						<div class="stat-value text-accent">{health.stats.cacheHits}</div>
						<div class="stat-desc">
							{m.settings_integrations_captcha_domainsCached({ count: health.stats.cacheSize })}
						</div>
					</div>
				</div>

				<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div class="text-sm text-base-content/70">
						{#if health.stats.lastSolveAt}
							{m.settings_integrations_captcha_lastSolve()}
							{formatDisplayDate(health.stats.lastSolveAt, {
								month: 'short',
								day: 'numeric',
								hour: 'numeric',
								minute: '2-digit'
							})}
						{:else if health.stats.lastFetchAt}
							{m.settings_integrations_captcha_lastFetch()}
							{formatDisplayDate(health.stats.lastFetchAt, {
								month: 'short',
								day: 'numeric',
								hour: 'numeric',
								minute: '2-digit'
							})}
						{:else}
							{m.settings_integrations_captcha_noActivity()}
						{/if}
					</div>
					<button
						class="btn gap-2 btn-outline btn-sm"
						onclick={clearCache}
						disabled={captchaClearing || health.stats.cacheSize === 0}
					>
						{#if captchaClearing}
							<RefreshCw class="h-4 w-4 animate-spin" />
						{:else}
							<Trash2 class="h-4 w-4" />
						{/if}
						{m.settings_integrations_captcha_clearCache()}
					</button>
				</div>

				{#if health.stats.lastError}
					<div class="alert alert-error">
						<span class="text-sm"
							>{m.settings_integrations_captcha_lastError()} {health.stats.lastError}</span
						>
					</div>
				{/if}
			</SettingsSection>
		{/if}
	{/if}
</SettingsPage>
