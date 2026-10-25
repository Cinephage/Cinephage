<script lang="ts">
	import { ChevronDown, ChevronUp } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { FormInput, FormSelect } from '#lib/components/ui/form/index.js';
	import type { NamingConfigShape } from '#lib/naming/setup-presets.js';

	interface Props {
		config: NamingConfigShape;
		open?: boolean;
	}

	let { config, open = $bindable(true) }: Props = $props();
</script>

<div class="card overflow-hidden bg-base-200">
	<button
		type="button"
		class="card-body w-full p-4 text-left"
		onclick={() => (open = !open)}
		aria-expanded={open}
		aria-controls="advanced-options-panel"
	>
		<div class="flex items-center justify-between">
			<h2 class="card-title text-base">{m.settings_naming_advancedOptions()}</h2>
			{#if open}
				<ChevronUp class="h-5 w-5" />
			{:else}
				<ChevronDown class="h-5 w-5" />
			{/if}
		</div>
	</button>
	{#if open}
		<div id="advanced-options-panel" class="card-body border-t border-base-300 pt-4">
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
				<div class="rounded-xl border border-base-300 bg-base-100 p-3 sm:col-span-2 lg:col-span-3">
					<p class="text-xs font-semibold tracking-wide text-base-content/50 uppercase">
						{m.settings_naming_presetAwareOptions()}
					</p>
					<p class="mt-1 text-sm text-base-content/65">
						{m.settings_naming_presetAwareOptionsDesc()}
					</p>
				</div>

				<FormInput
					id="replaceSpacesWith"
					label={m.settings_naming_replaceSpacesWith()}
					bind:value={config.replaceSpacesWith}
					placeholder={m.settings_naming_replaceSpacesPlaceholder()}
					helpText={m.settings_naming_replaceSpacesHelp()}
				/>

				<FormSelect
					id="multiEpisodeStyle"
					label={m.settings_naming_multiEpisodeStyle()}
					bind:value={config.multiEpisodeStyle}
					options={[
						{ value: 'range', label: m.settings_naming_multiEpRange() },
						{ value: 'extend', label: m.settings_naming_multiEpExtend() },
						{ value: 'duplicate', label: m.settings_naming_multiEpDuplicate() },
						{ value: 'repeat', label: m.settings_naming_multiEpRepeat() },
						{ value: 'scene', label: m.settings_naming_multiEpScene() }
					]}
					helpText={m.settings_naming_multiEpisodeStyleHelp()}
				/>

				<FormSelect
					id="colonReplacement"
					label={m.settings_naming_colonReplacement()}
					bind:value={config.colonReplacement}
					options={[
						{ value: 'smart', label: m.settings_naming_colonSmart() },
						{ value: 'delete', label: m.settings_naming_colonDelete() },
						{ value: 'dash', label: m.settings_naming_colonDash() },
						{ value: 'spaceDash', label: m.settings_naming_colonSpaceDash() },
						{ value: 'spaceDashSpace', label: m.settings_naming_colonSpaceDashSpace() }
					]}
					helpText={m.settings_naming_colonReplacementHelp()}
				/>

				<FormSelect
					id="mediaServerIdFormat"
					label={m.settings_naming_mediaServerIdFormat()}
					bind:value={config.mediaServerIdFormat}
					options={[
						{ value: 'plex', label: m.settings_naming_plexBraces() },
						{ value: 'jellyfin', label: m.settings_naming_jellyfinBrackets() }
					]}
					helpText={m.settings_naming_mediaServerIdFormatHelp()}
				/>

				<div class="space-y-3 sm:col-span-2 lg:col-span-3">
					<label
						class="label cursor-pointer justify-start gap-3 rounded-lg border border-base-300 px-3 py-2 transition-colors hover:bg-base-300/50"
					>
						<input
							type="checkbox"
							class="checkbox checkbox-sm checkbox-primary"
							bind:checked={config.useSpecialsFolder}
						/>
						<div class="flex flex-col gap-0.5">
							<span class="label-text">{m.settings_naming_useSpecialsFolder()}</span>
							<span class="text-xs text-base-content/55"
								>{m.settings_naming_useSpecialsFolderHelp()}</span
							>
						</div>
					</label>

					<label
						class="label cursor-pointer justify-start gap-3 rounded-lg border border-base-300 px-3 py-2 transition-colors hover:bg-base-300/50"
					>
						<input
							type="checkbox"
							class="checkbox checkbox-sm checkbox-primary"
							bind:checked={config.includeQuality}
						/>
						<span class="label-text">{m.settings_naming_includeQuality()}</span>
					</label>

					<label
						class="label cursor-pointer justify-start gap-3 rounded-lg border border-base-300 px-3 py-2 transition-colors hover:bg-base-300/50"
					>
						<input
							type="checkbox"
							class="checkbox checkbox-sm checkbox-primary"
							bind:checked={config.includeMediaInfo}
						/>
						<span class="label-text">{m.settings_naming_includeMediaInfo()}</span>
					</label>

					<label
						class="label cursor-pointer justify-start gap-3 rounded-lg border border-base-300 px-3 py-2 transition-colors hover:bg-base-300/50"
					>
						<input
							type="checkbox"
							class="checkbox checkbox-sm checkbox-primary"
							bind:checked={config.includeReleaseGroup}
						/>
						<span class="label-text">{m.settings_naming_includeReleaseGroup()}</span>
					</label>
				</div>
			</div>
		</div>
	{/if}
</div>
