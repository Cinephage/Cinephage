<script lang="ts">
	import { Captions, CaptionsOff } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { SubtitleRequirementProgress } from '#lib/utils/subtitle-status-display.js';

	interface Props {
		progress: SubtitleRequirementProgress;
		size?: 'xs' | 'sm' | 'md';
		/** Show the "Cutoff met" marker when the profile's cutoff satisfied the item early. */
		showCutoff?: boolean;
		class?: string;
	}

	let { progress, size = 'sm', showCutoff = false, class: className = '' }: Props = $props();

	const textSize = $derived(size === 'xs' ? 'text-[10px]' : size === 'md' ? 'text-sm' : 'text-xs');
	const iconSize = $derived(size === 'xs' ? 10 : size === 'md' ? 14 : 12);
	const stateColor = $derived(
		progress.state === 'satisfied' ? 'text-base-content/60' : 'text-warning'
	);
</script>

<!-- role="status": the count updates in place when subtitles are downloaded,
     deleted or upgraded, so announce the change politely. Visible "X of Y"
     text (plus sr-only context) keeps the badge screen-reader readable —
     never icon-only. -->
<span
	class="inline-flex items-center gap-1 whitespace-nowrap {textSize} {stateColor} {className}"
	role="status"
	title={m.library_badges_subtitleRequirementsTooltip({
		satisfied: progress.satisfiedCount,
		total: progress.totalCount
	})}
>
	<span class="sr-only">{m.library_badges_subtitleRequirementsSrLabel()}</span>
	{#if progress.satisfiedCount === 0}
		<CaptionsOff size={iconSize} aria-hidden="true" />
	{:else}
		<Captions size={iconSize} aria-hidden="true" />
	{/if}
	<span>
		{m.library_badges_subtitleRequirementsCount({
			satisfied: progress.satisfiedCount,
			total: progress.totalCount
		})}
	</span>
	{#if showCutoff && progress.satisfiedViaCutoff}
		<span class="badge badge-outline badge-xs badge-warning">
			{m.library_badges_cutoffMet()}
		</span>
	{/if}
</span>
