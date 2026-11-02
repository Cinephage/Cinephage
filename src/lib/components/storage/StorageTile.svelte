<script lang="ts">
	import type { Component } from 'svelte';

	interface MiniSegment {
		value: number;
		colorClass: string;
	}

	interface Props {
		icon: Component<{ class?: string }>;
		iconClass?: string;
		label: string;
		value: string;
		context?: string;
		href?: string;
		miniSegments?: MiniSegment[];
		statusDot?: 'success' | 'warning' | 'error';
	}

	let {
		icon: Icon,
		iconClass = 'bg-base-content/10 text-base-content',
		label,
		value,
		context,
		href,
		miniSegments,
		statusDot
	}: Props = $props();

	const dotColor = $derived(
		statusDot === 'success'
			? 'bg-success'
			: statusDot === 'warning'
				? 'bg-warning'
				: statusDot === 'error'
					? 'bg-error'
					: ''
	);

	const totalSegments = $derived(
		miniSegments ? miniSegments.reduce((sum, s) => sum + s.value, 0) : 0
	);
</script>

<div class="card relative bg-base-200 transition-colors hover:bg-base-300/70">
	{#if href}
		<a {href} class="absolute inset-0 z-0" aria-label={label}></a>
	{/if}
	<div class="card-body gap-1.5 p-3 sm:p-4">
		<div class="flex items-center justify-between">
			<div class="flex items-center gap-2">
				<div class={`rounded-lg p-1.5 ${iconClass}`}>
					<Icon class="h-4 w-4" />
				</div>
				<span class="text-xs font-medium tracking-wide text-base-content/50 uppercase">{label}</span
				>
			</div>
			{#if statusDot}
				<span class={`inline-block h-2.5 w-2.5 rounded-full ${dotColor}`} aria-label={statusDot}
				></span>
			{/if}
		</div>
		<div class="text-xl font-bold text-base-content">{value}</div>
		{#if context}
			<div class="text-xs text-base-content/50">{context}</div>
		{/if}
		{#if miniSegments && totalSegments > 0}
			<div class="mt-1 flex h-1.5 overflow-hidden rounded-full bg-base-300/60">
				{#each miniSegments as seg (seg.colorClass)}
					<div
						class={`h-full ${seg.colorClass}`}
						style="width: {(seg.value / totalSegments) * 100}%"
					></div>
				{/each}
			</div>
		{/if}
	</div>
</div>
