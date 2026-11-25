<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import Skeleton from '#lib/components/ui/Skeleton.svelte';

	/** Placeholder rows shown while the discover data streams in; sized like
	 *  SectionRow's cards so the page does not jump when the content lands. */
	let { rows = 3 }: { rows?: number } = $props();
	const cards = 8;
</script>

<div class="space-y-12" role="status" aria-label={m.common_loading()}>
	{#each { length: rows }, rowIndex (rowIndex)}
		<div class="space-y-4">
			<div class="flex items-center gap-2 px-1">
				<span class="h-6 w-1 rounded-full bg-primary/40"></span>
				<Skeleton class="h-7 w-48" />
			</div>
			<div class="flex gap-3 overflow-hidden px-1 pb-4 sm:gap-4">
				{#each { length: cards }, cardIndex (cardIndex)}
					<Skeleton class="aspect-2/3 w-32 flex-none rounded-lg sm:w-36 md:w-40 lg:w-44" />
				{/each}
			</div>
		</div>
	{/each}
</div>
