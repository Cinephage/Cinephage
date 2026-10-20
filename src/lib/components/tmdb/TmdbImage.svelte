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

	// Reset per-src so a swapped `path` (same component instance) gets a
	// fresh loading/error cycle instead of freezing on the first image's
	// state. Declared BEFORE the listener-attaching effect below: on mount,
	// $effects run once each in declaration order, and this one must settle
	// `loaded`/`errored` back to their initial values first - otherwise it
	// would unconditionally stomp the `el.complete` result the other effect
	// just computed, re-hiding an image that had already finished loading
	// from cache before this component even mounted (e.g. a page reload,
	// where the browser's disk cache resolves the <img> before hydration
	// attaches any listener).
	$effect(() => {
		void src;
		loaded = false;
		errored = false;
	});

	// Svelte's onload/onerror props render as literal inline HTML attributes
	// during SSR (to catch an already-cached image's event before hydration
	// attaches the real listener) - blocked outright by a strict CSP without
	// 'unsafe-hashes'. Attaching imperatively in an effect never touches SSR
	// output, so it's CSP-safe regardless of policy.
	$effect(() => {
		const el = imgEl;
		if (!el) return;

		// The browser may have already resolved this exact URL from cache by
		// the time this effect runs (e.g. a page reload, where the disk cache
		// resolves the image before hydration attaches any listener) - its
		// load/error event can fire before the listeners below are attached,
		// leaving `loaded` stuck false and the image frozen behind the
		// placeholder forever. `complete` reflects that outcome synchronously
		// regardless of event timing.
		if (el.complete) {
			if (el.naturalWidth === 0) {
				errored = true;
			} else {
				loaded = true;
			}
		}

		const handleLoad = () => (loaded = true);
		const handleError = () => (errored = true);
		el.addEventListener('load', handleLoad);
		el.addEventListener('error', handleError);
		return () => {
			el.removeEventListener('load', handleLoad);
			el.removeEventListener('error', handleError);
		};
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
