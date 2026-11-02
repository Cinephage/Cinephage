<script lang="ts">
	import { Database, Globe, Loader2, Check, AlertCircle } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { onMount } from 'svelte';
	import { getSmartListPresets, testExternalList } from '#lib/api/smartlists.js';

	// Types
	interface PresetSetting {
		name: string;
		label: string;
		type: 'number' | 'string' | 'boolean' | 'select';
		min?: number;
		max?: number;
		default?: number | string | boolean;
		options?: Array<{ value: string | number; label: string }>;
		helpText?: string;
	}

	interface ExternalListPreset {
		id: string;
		provider: string;
		providerName: string;
		name: string;
		description: string;
		icon: string;
		url: string;
		isDefault: boolean;
		settings: PresetSetting[];
	}

	// Props
	interface Props {
		sourceType: 'tmdb-discover' | 'external-json';
		presetId?: string;
		presetProvider?: string;
		presetSettings?: Record<string, unknown>;
		customUrl?: string;
		customHeaders?: Record<string, string>;
		mediaType: 'movie' | 'tv';
		onChange?: (data: {
			sourceType: 'tmdb-discover' | 'external-json';
			presetId?: string;
			presetProvider?: string;
			presetSettings?: Record<string, unknown>;
			customUrl?: string;
			customHeaders?: Record<string, string>;
		}) => void;
	}

	let {
		sourceType = $bindable('tmdb-discover'),
		presetId = $bindable(),
		presetProvider = $bindable(),
		presetSettings = $bindable({}),
		customUrl = $bindable(),
		customHeaders = $bindable({}),
		mediaType,
		onChange
	}: Props = $props();

	// State
	let presets = $state<ExternalListPreset[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let selectedPreset = $state<ExternalListPreset | null>(null);
	let headersText = $state('{}');
	let testing = $state(false);
	let testResult = $state<{ success: boolean; message: string; itemCount?: number } | null>(null);

	// List source options - will be populated from fetched presets
	let listSourceOptions = $state<Array<{ value: string; label: string; icon: typeof Database }>>([
		{ value: 'tmdb-discover', label: m.smartlists_source_tmdbDiscover(), icon: Database }
	]);

	// Update options when presets are loaded
	$effect(() => {
		if (presets.length > 0) {
			const presetOptions = presets.map((preset) => ({
				value: preset.id,
				label: `${preset.providerName} - ${preset.name}`,
				icon: Globe
			}));
			listSourceOptions = [
				{ value: 'tmdb-discover', label: m.smartlists_source_tmdbDiscover(), icon: Database },
				...presetOptions,
				{ value: 'custom', label: m.smartlists_source_customUrl(), icon: Globe }
			];
		}
	});

	// Fetch presets on mount
	onMount(async () => {
		try {
			presets = (await getSmartListPresets()) as unknown as ExternalListPreset[];

			// Initialize selected preset if presetId is provided
			if (presetId && presetId !== 'custom') {
				selectedPreset = presets.find((p) => p.id === presetId) || null;
				if (selectedPreset) {
					presetProvider = selectedPreset.provider;
					// Initialize preset settings with defaults
					const defaults: Record<string, unknown> = {};
					for (const setting of selectedPreset.settings) {
						defaults[setting.name] = setting.default;
					}
					presetSettings = { ...defaults, ...presetSettings };
					// Emit change to notify parent
					emitChange();
				}
			}

			// Initialize headers text
			if (customHeaders && Object.keys(customHeaders).length > 0) {
				headersText = JSON.stringify(customHeaders, null, 2);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : m.smartlists_error_loadPresets();
		} finally {
			loading = false;
		}
	});

	// Handle source selection change
	function handleSourceChange(value: string) {
		testResult = null;

		if (value === 'tmdb-discover') {
			sourceType = 'tmdb-discover';
			presetId = undefined;
			presetProvider = undefined;
			selectedPreset = null;
			customUrl = undefined;
			customHeaders = {};
			headersText = '{}';
		} else if (value === 'custom') {
			sourceType = 'external-json';
			presetId = undefined;
			presetProvider = undefined;
			selectedPreset = null;
		} else {
			// It's a preset
			sourceType = 'external-json';
			presetId = value;
			selectedPreset = presets.find((p) => p.id === value) || null;
			presetProvider = selectedPreset?.provider;

			// Initialize preset settings with defaults
			if (selectedPreset) {
				const defaults: Record<string, unknown> = {};
				for (const setting of selectedPreset.settings) {
					defaults[setting.name] = setting.default;
				}
				presetSettings = { ...defaults, ...presetSettings };
			}
		}

		emitChange();
	}

	// Handle preset setting change
	function handleSettingChange(name: string, value: unknown) {
		presetSettings = { ...presetSettings, [name]: value };
		emitChange();
	}

	// Handle custom URL change
	function handleCustomUrlChange(value: string) {
		customUrl = value || undefined;
		emitChange();
	}

	// Handle headers change
	function handleHeadersChange(value: string) {
		headersText = value;
		try {
			const parsed = JSON.parse(value);
			customHeaders = parsed;
			emitChange();
		} catch {
			// Invalid JSON, don't update
		}
	}

	// Emit change event
	function emitChange() {
		onChange?.({
			sourceType,
			presetId,
			presetProvider,
			presetSettings,
			customUrl,
			customHeaders
		});
	}

	// Test connection
	async function testConnection() {
		const hasPreset = !!presetId && presetId !== 'custom';
		const url = selectedPreset?.url || customUrl;
		if (!hasPreset && !url) {
			testResult = { success: false, message: m.smartlists_error_enterUrl() };
			return;
		}

		testing = true;
		testResult = null;

		try {
			const data = (await testExternalList({
				url,
				headers: customHeaders,
				mediaType,
				presetId,
				config: presetSettings
			})) as unknown as { totalCount: number };

			testResult = {
				success: true,
				message: m.smartlists_test_success({ count: data.totalCount }),
				itemCount: data.totalCount
			};
		} catch (e) {
			testResult = {
				success: false,
				message: e instanceof Error ? e.message : m.smartlists_error_generic()
			};
		} finally {
			testing = false;
		}
	}

	// Get current selection value for dropdown
	function getCurrentSelection(): string {
		if (sourceType === 'tmdb-discover') return 'tmdb-discover';
		if (presetId) return presetId;
		return 'custom';
	}
</script>

<div class="space-y-4">
	<!-- List Source Dropdown -->
	<div class="form-control">
		<label class="label py-1" for="listSource">
			<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase">
				{m.smartlists_label_listSource()}
			</span>
		</label>
		{#if loading}
			<div class="h-10 w-full skeleton"></div>
		{:else if error}
			<div class="alert-sm alert py-2 alert-error">
				<AlertCircle class="h-4 w-4" />
				<span class="text-sm">{error}</span>
			</div>
		{:else}
			<select
				id="listSource"
				class="select-bordered select w-full"
				value={getCurrentSelection()}
				onchange={(e) => handleSourceChange(e.currentTarget.value)}
			>
				{#each listSourceOptions as option (option.value)}
					<option value={option.value}>{option.label}</option>
				{/each}
			</select>
		{/if}
	</div>

	<!-- Preset Settings -->
	{#if selectedPreset && selectedPreset.settings.length > 0}
		<div class="space-y-3 rounded-lg border border-base-300 bg-base-100 p-4">
			<div class="flex items-center gap-2">
				<Globe class="h-4 w-4 text-primary" />
				<span class="font-medium">{selectedPreset.name} {m.smartlists_label_settings()}</span>
			</div>
			<p class="text-xs text-base-content/60">{selectedPreset.description}</p>

			{#each selectedPreset.settings as setting (setting.name)}
				<div class="form-control">
					<label class="label py-1" for={setting.name}>
						<span class="label-text text-xs font-medium">
							{setting.label}
						</span>
					</label>

					{#if setting.type === 'number'}
						<input
							type="range"
							id={setting.name}
							min={setting.min}
							max={setting.max}
							value={presetSettings[setting.name] ?? setting.default}
							oninput={(e) => handleSettingChange(setting.name, parseFloat(e.currentTarget.value))}
							class="range range-primary range-sm"
						/>
						<div class="mt-1 flex justify-between text-xs text-base-content/60">
							<span>{setting.min}</span>
							<span class="font-medium">{presetSettings[setting.name] ?? setting.default}</span>
							<span>{setting.max}</span>
						</div>
					{:else if setting.type === 'boolean'}
						<input
							type="checkbox"
							id={setting.name}
							checked={!!(presetSettings[setting.name] ?? setting.default)}
							onchange={(e) => handleSettingChange(setting.name, e.currentTarget.checked)}
							class="checkbox checkbox-sm checkbox-primary"
						/>
					{:else if setting.type === 'select' && setting.options}
						<select
							id={setting.name}
							class="select-bordered select w-full select-sm"
							value={presetSettings[setting.name] ?? setting.default}
							onchange={(e) => handleSettingChange(setting.name, e.currentTarget.value)}
						>
							{#each setting.options as opt (opt.value)}
								<option value={opt.value}>{opt.label}</option>
							{/each}
						</select>
					{:else}
						<input
							type="text"
							id={setting.name}
							value={presetSettings[setting.name] ?? setting.default}
							oninput={(e) => handleSettingChange(setting.name, e.currentTarget.value)}
							class="input-bordered input w-full input-sm"
						/>
					{/if}

					{#if setting.helpText}
						<p class="mt-1 text-xs text-base-content/60">{setting.helpText}</p>
					{/if}
				</div>
			{/each}

			<!-- Info notice about mixed content -->
			<div class="mt-4 rounded-lg border border-info/30 bg-info/10 p-3">
				<div class="flex items-start gap-2">
					<AlertCircle class="mt-0.5 h-4 w-4 text-info" />
					<div class="text-xs text-base-content/80">
						<p class="font-medium">{m.smartlists_info_mixedContentTitle()}</p>
						<p class="mt-1">
							{m.smartlists_info_mixedContentDescription()}
						</p>
					</div>
				</div>
			</div>

			<!-- Test Connection Button for Presets -->
			<div class="flex items-center gap-3 pt-2">
				<button class="btn btn-outline btn-sm" onclick={testConnection} disabled={testing}>
					{#if testing}
						<Loader2 class="h-4 w-4 animate-spin" />
						{m.common_testing()}
					{:else}
						<Globe class="h-4 w-4" />
						{m.action_testConnection()}
					{/if}
				</button>

				{#if testResult}
					<div
						class="flex items-center gap-2 text-sm {testResult.success
							? 'text-success'
							: 'text-error'}"
					>
						{#if testResult.success}
							<Check class="h-4 w-4" />
						{:else}
							<AlertCircle class="h-4 w-4" />
						{/if}
						<span>{testResult.message}</span>
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Custom URL Configuration -->
	{#if sourceType === 'external-json' && !presetId}
		<div class="space-y-4 rounded-lg border border-base-300 bg-base-100 p-4">
			<div class="flex items-center gap-2">
				<Globe class="h-4 w-4 text-primary" />
				<span class="font-medium">{m.smartlists_customUrlConfig_title()}</span>
			</div>

			<!-- URL Input -->
			<div class="form-control">
				<label class="label py-1" for="customUrl">
					<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase">
						{m.smartlists_label_jsonUrl()}
					</span>
				</label>
				<input
					type="url"
					id="customUrl"
					value={customUrl || ''}
					oninput={(e) => handleCustomUrlChange(e.currentTarget.value)}
					placeholder="https://example.com/movies.json"
					class="input-bordered input w-full input-sm"
				/>
				<p class="mt-1 text-xs text-base-content/60">
					{m.smartlists_customUrlConfig_urlDescription()}
				</p>
			</div>

			<!-- Headers (optional) -->
			<div class="form-control">
				<label class="label py-1" for="customHeaders">
					<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase">
						{m.smartlists_label_customHeaders()}
					</span>
				</label>
				<textarea
					id="customHeaders"
					value={headersText}
					oninput={(e) => handleHeadersChange(e.currentTarget.value)}
					placeholder={`{\n  "Authorization": "Bearer token"\n}`}
					class="textarea-bordered textarea h-24 font-mono text-xs"></textarea>
				<p class="mt-1 text-xs text-base-content/60">
					{m.smartlists_customUrlConfig_headersDescription()}
				</p>
			</div>

			<!-- Test Connection Button -->
			<div class="flex items-center gap-3">
				<button
					class="btn btn-outline btn-sm"
					onclick={testConnection}
					disabled={testing || !customUrl}
				>
					{#if testing}
						<Loader2 class="h-4 w-4 animate-spin" />
						{m.common_testing()}
					{:else}
						<Globe class="h-4 w-4" />
						{m.action_testConnection()}
					{/if}
				</button>

				{#if testResult}
					<div
						class="flex items-center gap-2 text-sm {testResult.success
							? 'text-success'
							: 'text-error'}"
					>
						{#if testResult.success}
							<Check class="h-4 w-4" />
						{:else}
							<AlertCircle class="h-4 w-4" />
						{/if}
						<span>{testResult.message}</span>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
