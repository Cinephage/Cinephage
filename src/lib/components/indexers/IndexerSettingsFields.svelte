<script lang="ts">
	import type { DefinitionSetting } from '#lib/types/indexer.js';
	import { HelpCircle, Info, Cookie, Shield, User } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { isSensitiveDefinitionSetting } from '#lib/shared/sensitiveSettings.js';

	interface Props {
		settingsDefinitions: DefinitionSetting[];
		settings: Record<string, string>;
		hasSensitiveSettings?: Record<string, boolean>;
		onchange?: (settings: Record<string, string>) => void;
	}

	let {
		settingsDefinitions,
		settings = $bindable(),
		hasSensitiveSettings = {},
		onchange
	}: Props = $props();

	function updateSetting(name: string, value: string) {
		settings[name] = value;
		if (onchange) {
			onchange({ ...settings });
		}
	}

	// Check if a setting type is an info-only type (not editable)
	function isInfoType(type: string): boolean {
		return type.startsWith('info');
	}

	// Get icon for info type
	function getInfoIcon(type: string) {
		switch (type) {
			case 'info_cookie':
				return Cookie;
			case 'info_cloudflare':
				return Shield;
			case 'info_useragent':
				return User;
			default:
				return Info;
		}
	}

	function shouldPreserveSetting(setting: DefinitionSetting): boolean {
		return isSensitiveDefinitionSetting(setting) && Boolean(hasSensitiveSettings[setting.name]);
	}
</script>

{#if settingsDefinitions.length > 0}
	{#each settingsDefinitions as setting (setting.name)}
		{#if isInfoType(setting.type)}
			<!-- Info-only fields (not editable) - span full width in grid -->
			{@const InfoIcon = getInfoIcon(setting.type)}
			<div class="col-span-full rounded-lg bg-info/10 p-3">
				<div class="flex items-start gap-2">
					<InfoIcon class="mt-0.5 h-4 w-4 shrink-0 text-info" />
					<div class="min-w-0">
						<span class="text-sm font-medium text-base-content">{setting.label}</span>
						{#if setting.default}
							<p class="mt-1 text-sm text-base-content/70">{setting.default}</p>
						{/if}
					</div>
				</div>
			</div>
		{:else}
			<div class="form-control">
				{#if setting.type !== 'checkbox'}
					<label class="label py-1" for={setting.name}>
						<span class="label-text flex items-center gap-1">
							{setting.label}
							{#if setting.required && !shouldPreserveSetting(setting)}
								<span class="text-error">* </span>
							{/if}
							{#if shouldPreserveSetting(setting)}
								<span class="text-xs opacity-50">({m.auth_blankToKeep()})</span>
							{/if}
							{#if setting.helpText}
								<div class="tooltip tooltip-right" data-tip={setting.helpText}>
									<HelpCircle class="h-3.5 w-3.5 text-base-content/50" />
								</div>
							{/if}
						</span>
					</label>
				{/if}

				{#if setting.type === 'password'}
					<input
						type="password"
						id={setting.name}
						class="input-bordered input input-sm"
						placeholder={shouldPreserveSetting(setting)
							? '********'
							: String(setting.default ?? '')}
						value={settings[setting.name] ?? ''}
						oninput={(e) => updateSetting(setting.name, e.currentTarget.value)}
						required={setting.required && !shouldPreserveSetting(setting)}
					/>
				{:else if setting.type === 'checkbox'}
					<label class="flex cursor-pointer items-start gap-3 py-2">
						<input
							type="checkbox"
							class="checkbox mt-0.5 shrink-0 checkbox-sm checkbox-primary"
							checked={settings[setting.name] === 'true'}
							onchange={(e) =>
								updateSetting(setting.name, e.currentTarget.checked ? 'true' : 'false')}
						/>
						<span class="text-sm leading-tight">{setting.label}</span>
					</label>
				{:else if setting.type === 'select' && setting.options}
					<select
						id={setting.name}
						class="select-bordered select select-sm"
						value={settings[setting.name] ?? String(setting.default ?? '')}
						onchange={(e) => updateSetting(setting.name, e.currentTarget.value)}
					>
						{#each Object.entries(setting.options) as [value, label] (value)}
							<option {value}>{label}</option>
						{/each}
					</select>
				{:else if setting.type === 'number'}
					<input
						type="number"
						id={setting.name}
						class="input-bordered input input-sm"
						placeholder={shouldPreserveSetting(setting)
							? '********'
							: String(setting.default ?? '')}
						value={settings[setting.name] ?? ''}
						oninput={(e) => updateSetting(setting.name, e.currentTarget.value)}
						required={setting.required && !shouldPreserveSetting(setting)}
					/>
				{:else}
					<input
						type="text"
						id={setting.name}
						class="input-bordered input input-sm"
						placeholder={shouldPreserveSetting(setting)
							? '********'
							: String(setting.default ?? '')}
						value={settings[setting.name] ?? ''}
						oninput={(e) => updateSetting(setting.name, e.currentTarget.value)}
						required={setting.required && !shouldPreserveSetting(setting)}
					/>
				{/if}

				{#if setting.helpText && setting.type !== 'checkbox'}
					<div class="label py-0.5">
						<span class="label-text-alt text-base-content/60">{setting.helpText}</span>
					</div>
				{/if}
			</div>
		{/if}
	{/each}
{/if}
