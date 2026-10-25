<script lang="ts">
	import type { DesiredQuality } from '#lib/types/library.js';

	interface Props {
		desiredQualities: DesiredQuality[];
		minResolution?: string | null;
		maxResolution?: string | null;
	}

	let { desiredQualities = $bindable(), minResolution, maxResolution }: Props = $props();

	const RESOLUTION_OPTIONS: { value: DesiredQuality; label: string; rank: number }[] = [
		{ value: '2160p', label: '2160p (4K)', rank: 4 },
		{ value: '1080p', label: '1080p (Full HD)', rank: 3 },
		{ value: '720p', label: '720p (HD)', rank: 2 },
		{ value: '480p', label: '480p (SD)', rank: 1 }
	];

	const allowedResolutions = $derived.by(() => {
		const minRank = minResolution
			? (RESOLUTION_OPTIONS.find((r) => r.value === minResolution)?.rank ?? 0)
			: 0;
		const maxRank = maxResolution
			? (RESOLUTION_OPTIONS.find((r) => r.value === maxResolution)?.rank ?? 99)
			: 99;
		return RESOLUTION_OPTIONS.filter((r) => r.rank >= minRank && r.rank <= maxRank).map(
			(r) => r.value
		);
	});
	const multiQualityActive = $derived(
		desiredQualities.filter((r) => allowedResolutions.includes(r)).length >= 2
	);
	const hasOutOfRangeSelection = $derived(
		desiredQualities.some((r) => !allowedResolutions.includes(r))
	);

	function toggleResolution(value: DesiredQuality) {
		if (desiredQualities.includes(value)) {
			desiredQualities = desiredQualities.filter((r) => r !== value);
		} else {
			desiredQualities = [...desiredQualities, value];
		}
	}
</script>

<div class="form-control">
	<div class="label">
		<span class="label-text font-medium">Desired Qualities</span>
	</div>
	<div class="flex flex-wrap gap-2">
		{#each RESOLUTION_OPTIONS as option (option.value)}
			{@const allowed = allowedResolutions.includes(option.value)}
			{@const selected = desiredQualities.includes(option.value)}
			<button
				type="button"
				class="btn border border-base-300 btn-sm {selected ? 'btn-primary' : 'btn-ghost'}"
				class:btn-disabled={!allowed}
				class:opacity-50={!allowed}
				aria-pressed={selected}
				disabled={!allowed}
				title={allowed ? '' : 'Outside the selected quality profile resolution range'}
				onclick={() => toggleResolution(option.value)}
			>
				{option.label}
			</button>
		{/each}
	</div>
	<div class="label">
		<span class="label-text-alt wrap-break-word whitespace-normal text-base-content/60">
			Select two or more resolutions to keep multiple quality versions of this movie. Fewer than two
			keeps the default single-best behavior.
		</span>
	</div>
	{#if hasOutOfRangeSelection}
		<p class="mt-1 text-xs text-warning">
			Some selected resolutions are outside the current quality profile's range and will be ignored
			until the profile allows them.
		</p>
	{/if}
	{#if multiQualityActive}
		<p class="mt-1 text-xs text-success">
			Multi-quality mode active: each resolution is downloaded and upgraded independently.
		</p>
	{/if}
</div>
