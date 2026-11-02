<script lang="ts">
	import { ChevronDown, Settings } from '@lucide/svelte';
	import type { IndexerDefinition } from '#lib/types/indexer.js';
	import * as m from '#lib/paraglide/messages.js';
	import { SectionHeader, ToggleSetting } from '#lib/components/ui/modal/index.js';

	interface Props {
		definition: IndexerDefinition;
		name: string;
		priority: number;
		enabled: boolean;
		settings: Record<string, string>;
		enableAutomaticSearch: boolean;
		enableInteractiveSearch: boolean;
		onNameChange: (value: string) => void;
		onPriorityChange: (value: number) => void;
		onEnabledChange: (value: boolean) => void;
		onSettingsChange: (key: string, value: string) => void;
		onAutomaticSearchChange: (value: boolean) => void;
		onInteractiveSearchChange: (value: boolean) => void;
	}

	let {
		definition,
		name,
		priority,
		enabled,
		settings,
		enableAutomaticSearch,
		enableInteractiveSearch,
		onNameChange,
		onPriorityChange,
		onEnabledChange,
		onSettingsChange,
		onAutomaticSearchChange,
		onInteractiveSearchChange
	}: Props = $props();

	const textSettings = $derived(
		definition.settings?.filter((s) => s.type === 'text' || s.type === 'password') ?? []
	);

	const checkboxSettings = $derived(
		definition.settings?.filter((s) => s.type === 'checkbox') ?? []
	);

	const MAX_NAME_LENGTH = 20;
	const nameTooLong = $derived(name.length > MAX_NAME_LENGTH);

	// Collapsible configuration state
	let configOpen = $state(true);

	// Build configuration summary
	const configSummary = $derived.by(() => {
		const totalFields = textSettings.length + checkboxSettings.length;
		if (totalFields === 0) return 'No configuration required';

		const configuredText = textSettings.filter((s) => {
			const val = settings[s.name];
			return val && val.trim() !== '';
		}).length;

		const configuredCheckboxes = checkboxSettings.filter((s) => {
			const val = settings[s.name];
			return val === 'true' || (val === undefined && s.default === 'true');
		}).length;

		const totalConfigured = configuredText + configuredCheckboxes;

		if (totalConfigured === 0) return 'Not configured';
		if (totalConfigured === totalFields) return 'Fully configured';
		return `${totalConfigured}/${totalFields} fields configured`;
	});
</script>

<div class="space-y-4">
	<!-- Connection Section -->
	<SectionHeader title="Connection" />

	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
		<!-- Name -->
		<div class="form-control">
			<label class="label py-1" for="streaming-name">
				<span class="label-text">Name</span>
				<span class="label-text-alt text-xs {nameTooLong ? 'text-error' : 'text-base-content/60'}">
					{name.length}/{MAX_NAME_LENGTH}
				</span>
			</label>
			<input
				id="streaming-name"
				type="text"
				class="input-bordered input input-sm"
				value={name}
				oninput={(e) => onNameChange(e.currentTarget.value)}
				maxlength={MAX_NAME_LENGTH}
				placeholder={definition.name ?? 'Streaming Indexer'}
			/>
			{#if nameTooLong}
				<p class="label py-0">
					<span class="label-text-alt text-xs text-error">Max {MAX_NAME_LENGTH} characters.</span>
				</p>
			{/if}
		</div>

		<!-- Priority -->
		<div class="form-control">
			<label class="label py-1" for="streaming-priority">
				<span class="label-text">Priority</span>
				<span class="label-text-alt text-xs">1-100, lower = higher</span>
			</label>
			<input
				id="streaming-priority"
				type="number"
				class="input-bordered input input-sm"
				value={priority}
				oninput={(e) => onPriorityChange(parseInt(e.currentTarget.value) || 25)}
				min="1"
				max="100"
			/>
		</div>
	</div>

	<div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
		<!-- Enabled -->
		<div class="form-control">
			<label class="label py-1" for="streaming-enabled">
				<span class="label-text">Status</span>
			</label>
			<label class="flex cursor-pointer items-center gap-2 py-2">
				<input
					id="streaming-enabled"
					type="checkbox"
					class="checkbox shrink-0 checkbox-sm checkbox-primary"
					checked={enabled}
					onchange={(e) => onEnabledChange(e.currentTarget.checked)}
				/>
				<span class="text-sm">{enabled ? 'Enabled' : 'Disabled'}</span>
			</label>
		</div>

		<!-- Search Settings -->
		<ToggleSetting
			checked={enableAutomaticSearch}
			label={m.indexer_label_automaticSearch()}
			description={m.indexer_desc_automaticSearch()}
			onchange={() => onAutomaticSearchChange(!enableAutomaticSearch)}
		/>
		<ToggleSetting
			checked={enableInteractiveSearch}
			label={m.indexer_label_interactiveSearch()}
			description={m.indexer_desc_interactiveSearch()}
			onchange={() => onInteractiveSearchChange(!enableInteractiveSearch)}
		/>
	</div>

	<!-- Configuration Section (collapsible, only when has settings) -->
	{#if textSettings.length > 0 || checkboxSettings.length > 0}
		<div class="collapse rounded-lg bg-base-200" class:collapse-open={configOpen}>
			<button
				type="button"
				class="collapse-title flex min-h-0 items-center justify-between px-4 py-3 text-sm font-medium"
				onclick={() => (configOpen = !configOpen)}
			>
				<div class="flex min-w-0 items-center gap-2">
					<Settings class="h-4 w-4 shrink-0 text-base-content/70" />
					<span>Configuration</span>
					{#if !configOpen}
						<span class="ml-2 text-xs font-normal text-base-content/50">
							{configSummary}
						</span>
					{/if}
				</div>
				<ChevronDown
					class="ml-2 h-4 w-4 shrink-0 transition-transform {configOpen ? 'rotate-180' : ''}"
				/>
			</button>
			<div class="collapse-content px-4 pb-4">
				<div class="space-y-4">
					<!-- Text inputs - 2 column grid -->
					{#if textSettings.length > 0}
						<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
							{#each textSettings as setting (setting.name)}
								<div class="form-control">
									<label class="label py-1" for={`streaming-${setting.name}`}>
										<span class="label-text">{setting.label}</span>
									</label>
									<input
										type={setting.type === 'password' ? 'password' : 'text'}
										id={`streaming-${setting.name}`}
										class="input-bordered input input-sm"
										placeholder={setting.placeholder ?? setting.default ?? ''}
										value={settings[setting.name] ?? ''}
										oninput={(e) => onSettingsChange(setting.name, e.currentTarget.value)}
									/>
									{#if setting.helpText}
										<p class="label py-0">
											<span class="label-text-alt text-xs text-base-content/60"
												>{setting.helpText}</span
											>
										</p>
									{/if}
								</div>
							{/each}
						</div>
					{/if}

					<!-- Checkboxes - 3 column grid -->
					{#if checkboxSettings.length > 0}
						<div class="border-t border-base-300 pt-4">
							<p class="mb-3 text-sm font-medium">Streaming Providers</p>
							<div class="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
								{#each checkboxSettings as setting (setting.name)}
									<label
										class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-base-300"
									>
										<input
											type="checkbox"
											class="checkbox checkbox-sm checkbox-primary"
											checked={settings[setting.name] === 'true' ||
												(settings[setting.name] === undefined && setting.default === 'true')}
											onchange={(e) =>
												onSettingsChange(setting.name, e.currentTarget.checked ? 'true' : 'false')}
										/>
										<div class="min-w-0">
											<span class="text-sm font-medium">{setting.label}</span>
											{#if setting.helpText}
												<p class="truncate text-xs text-base-content/50" title={setting.helpText}>
													{setting.helpText}
												</p>
											{/if}
										</div>
									</label>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	<!-- Streaming Info -->
	<div class="rounded-lg bg-info/10 p-4">
		<p class="text-sm text-base-content/70">
			Streaming provides instant playback via .strm files. No torrent client required.
		</p>
	</div>
</div>
