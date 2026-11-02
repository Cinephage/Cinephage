<script lang="ts">
	import { ChevronDown } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { CinephageModuleView } from './types.js';

	interface Props {
		module: CinephageModuleView;
		/** Master switch is off — all controls disabled */
		disabled?: boolean;
		onToggle: (moduleId: string, current: boolean) => void;
		onSaveSettings: (moduleId: string, settings: Record<string, unknown>) => void;
	}

	let { module, disabled = false, onToggle, onSaveSettings }: Props = $props();
</script>

<div class="rounded-xl border border-base-300 bg-base-100 px-4 py-3">
	<div class="flex items-center gap-3">
		<div class="min-w-0 flex-1">
			<p class="text-sm font-medium">{module.name}</p>
			<p class="truncate text-xs text-base-content/50">{module.description}</p>
		</div>
		<input
			type="checkbox"
			class="toggle toggle-primary toggle-sm"
			checked={module.enabled}
			{disabled}
			aria-label={m.settings_cinephage_moduleEnabled()}
			onchange={() => onToggle(module.moduleId, module.enabled)}
		/>
	</div>

	{#if module.enabled && disabled}
		<p class="mt-1 text-xs text-base-content/50">
			{m.settings_cinephage_moduleDisabledBySubsystem()}
		</p>
	{/if}

	{#if module.moduleId === 'library-streaming'}
		<details class="group mt-1">
			<summary
				class="flex w-fit cursor-pointer list-none items-center gap-1 text-xs font-medium text-base-content/50 select-none"
			>
				<ChevronDown class="h-3 w-3 transition-transform group-open:rotate-180" />
				{m.settings_cinephage_moduleSettings()}
			</summary>
			<div class="mt-2 space-y-2">
				<label class="flex cursor-pointer items-center gap-2 text-sm">
					<input
						type="checkbox"
						class="checkbox checkbox-sm checkbox-primary"
						checked={Boolean(module.settings.useHttps)}
						{disabled}
						onchange={(e) =>
							onSaveSettings(module.moduleId, {
								useHttps: (e.target as HTMLInputElement).checked,
								externalHost: (module.settings.externalHost as string) || ''
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
						{disabled}
						value={(module.settings.externalHost as string) || ''}
						onchange={(e) =>
							onSaveSettings(module.moduleId, {
								useHttps: Boolean(module.settings.useHttps),
								externalHost: (e.target as HTMLInputElement).value
							})}
					/>
					<span class="label-text-alt text-xs text-base-content/50">
						{m.settings_cinephage_externalHostHint()}
					</span>
				</label>
			</div>
		</details>
	{/if}

	{#if module.lastError}
		<p class="mt-1 text-xs text-error">{module.lastError}</p>
	{/if}
</div>
