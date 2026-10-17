<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';

	// TMDB's image base URL is static and hasn't changed in 10+ years
	const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/';

	let {
		path,
		size = 'w500',
		alt,
		fit = 'cover',
		class: className = ''
	}: {
		path: string | null;
		size?: string;
		alt: string;
		fit?: 'cover' | 'contain';
		class?: string;
	} = $props();

	// Use native lazy loading - much more efficient than JS IntersectionObserver
	// The browser handles this with a single optimized observer internally
	const src = $derived(path ? `${TMDB_IMAGE_BASE}${size}${path}` : '');

	let loaded = $state(false);
	let errored = $state(false);
	let imgEl: HTMLImageElement | undefined = $state();

	// Svelte's onload/onerror props render as literal inline HTML attributes
	// during SSR (to catch an already-cached image's event before hydration
	// attaches the real listener) - blocked outright by a strict CSP without
	// 'unsafe-hashes'. Attaching imperatively in an effect never touches SSR
	// output, so it's CSP-safe regardless of policy.
	$effect(() => {
		const el = imgEl;
		if (!el) return;

		const handleLoad = () => (loaded = true);
		const handleError = () => (errored = true);
		el.addEventListener('load', handleLoad);
		el.addEventListener('error', handleError);
		return () => {
			el.removeEventListener('load', handleLoad);
			el.removeEventListener('error', handleError);
		};
	});

	$effect(() => {
		// Reset per-src so a swapped `path` (same component instance) gets a
		// fresh loading/error cycle instead of freezing on the first image's state.
		void src;
		loaded = false;
		errored = false;
	});
</script>

<div class="relative {className}">
	{#if src && !errored}
		<img
			bind:this={imgEl}
			{src}
			{alt}
			loading="lazy"
			decoding="async"
			class="h-full w-full {fit === 'contain'
				? 'object-contain'
				: 'object-cover'} transition-opacity duration-200 {loaded ? 'opacity-100' : 'opacity-0'}"
		/>
		{#if !loaded}
			<div class="absolute inset-0 animate-pulse bg-base-300"></div>
		{/if}
	{:else}
		<!-- No image available, or it failed to load -->
		<div class="flex h-full w-full items-center justify-center bg-base-300 text-base-content/30">
			<span class="text-xs">{m.tmdb_noImage()}</span>
		</div>
	{/if}
</div>
