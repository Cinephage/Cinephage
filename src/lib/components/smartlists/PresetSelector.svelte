<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Sparkles } from '@lucide/svelte';

	interface FilterPreset {
		id: string;
		name: string;
		description: string;
		appliesTo: ('movie' | 'tv')[];
	}

	interface Props {
		presets: FilterPreset[];
		mediaType: 'movie' | 'tv';
		selectedPresetId: string;
		onApplyPreset: (presetId: string) => void;
		onClearPreset: () => void;
	}

	let { presets, mediaType, selectedPresetId, onApplyPreset, onClearPreset }: Props = $props();

	let filtered = $derived(presets.filter((p) => p.appliesTo.includes(mediaType)));
</script>

{#if filtered.length > 0}
	<div class="rounded-lg border border-base-300 bg-base-100 p-4">
		<div class="mb-3 flex items-center gap-2">
			<Sparkles class="h-4 w-4 text-primary" />
			<span class="font-medium">{m.smartlists_filter_quickPresets()}</span>
		</div>
		<div class="flex flex-wrap gap-2">
			{#each filtered as preset (preset.id)}
				<button
					class="btn btn-sm {selectedPresetId === preset.id ? 'btn-primary' : 'btn-outline'}"
					onclick={() => onApplyPreset(preset.id)}
					title={preset.description}
				>
					{preset.name}
				</button>
			{/each}
		</div>
		{#if selectedPresetId}
			<button class="btn mt-2 btn-ghost btn-xs" onclick={onClearPreset}>
				{m.smartlists_filter_clearPreset()}
			</button>
		{/if}
	</div>
{/if}
