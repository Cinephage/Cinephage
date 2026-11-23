<script lang="ts">
	let {
		hasMore,
		onLoadMore,
		loading = false
	}: { hasMore: boolean; onLoadMore: () => void; loading?: boolean } = $props();

	let target = $state<HTMLDivElement | null>(null);

	$effect(() => {
		if (!target || !hasMore) return;
		const node = target;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
			},
			{ rootMargin: '800px 0px' }
		);
		observer.observe(node);
		return () => observer.disconnect();
	});
</script>

{#if hasMore}
	<div bind:this={target} class="flex items-center justify-center py-8" aria-live="polite">
		<span class="loading loading-spinner loading-md text-base-content/40" aria-label="Loading more"></span>
	</div>
{/if}
