<script lang="ts">
	import { Disc3 } from '@lucide/svelte';
	import { imageError } from '#lib/actions/image-error.js';

	/**
	 * An album's cover, with the fallback every surface needs.
	 *
	 * `hasCover` is optimistic: it is true when a local file exists *or* when the
	 * album has a MusicBrainz release the Cover Art Archive might know. A
	 * stream-backed album whose release has no archived image therefore 404s, so
	 * the image is swapped for the disc icon instead of the browser's broken
	 * glyph. `use:imageError` is the action, not `onerror`, because the CSP here
	 * refuses inline handlers on server-rendered markup.
	 */
	interface Props {
		albumId: string;
		/** Optimistic: true also when only MusicBrainz might have art. */
		hasCover?: boolean;
		alt?: string;
		/** Size/colour of the fallback icon; the parent sizes the box. */
		iconClass?: string;
		lazy?: boolean;
	}

	let {
		albumId,
		hasCover = false,
		alt = '',
		iconClass = 'h-5 w-5 text-base-content/25',
		lazy = true
	}: Props = $props();

	let failed = $state(false);
	const showImage = $derived(hasCover && !failed);
</script>

{#if showImage}
	<img
		src={`/api/music/albums/${albumId}/cover`}
		{alt}
		class="h-full w-full object-cover"
		loading={lazy ? 'lazy' : 'eager'}
		use:imageError={() => (failed = true)}
	/>
{:else}
	<div class="flex h-full w-full items-center justify-center bg-base-300">
		<Disc3 class={iconClass} />
	</div>
{/if}
