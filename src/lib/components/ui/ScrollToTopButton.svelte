<script lang="ts">
	interface Props {
		/** Show the button once the page is scrolled further than this many pixels. */
		threshold?: number;
	}

	let { threshold = 300 }: Props = $props();

	let scrollY = $state(0);
</script>

<svelte:window
	onscroll={() => {
		scrollY = window.scrollY;
	}}
/>

{#if scrollY > threshold}
	<!-- Phones: tighter offset that respects the home-indicator inset. Pages using this
	     button keep enough bottom padding (pb-14) so the last row can scroll clear of it. -->
	<button
		class="btn fixed right-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50 gap-1.5 opacity-80 shadow-lg transition-opacity btn-neutral btn-sm hover:opacity-100 sm:right-6 sm:bottom-6"
		onclick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
		aria-label="Scroll to top"
	>
		<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
			><path d="M8 12V4M4 8l4-4 4 4" /></svg
		>
	</button>
{/if}
