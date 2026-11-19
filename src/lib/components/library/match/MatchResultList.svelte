<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Clapperboard, Tv, ChevronRight, Loader2 } from '@lucide/svelte';
	import TmdbImage from '#lib/components/tmdb/TmdbImage.svelte';
	import type { TmdbMatchResult } from './match-search.svelte.js';

	interface Props {
		results: readonly TmdbMatchResult[];
		mediaType: 'movie' | 'tv';
		/** The row currently being matched; its chevron becomes a spinner. */
		busyId?: number | null;
		disabled?: boolean;
		/** `null` for dialogs whose rows are a plain pick with no next step. */
		trailing?: 'chevron' | null;
		onpick: (result: TmdbMatchResult) => void;
	}

	let {
		results,
		mediaType,
		busyId = null,
		disabled = false,
		trailing = 'chevron',
		onpick
	}: Props = $props();
</script>

<div class="space-y-1">
	{#each results as result (result.id)}
		{@const busy = busyId === result.id}
		<button
			class="group flex w-full cursor-pointer items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-base-300 disabled:opacity-60"
			onclick={() => onpick(result)}
			{disabled}
		>
			<div class="h-16 w-12 shrink-0 overflow-hidden rounded bg-base-300">
				{#if result.poster_path}
					<TmdbImage
						path={result.poster_path}
						alt={result.title ?? result.name ?? 'Poster'}
						size="w92"
						class="h-full w-full object-cover"
					/>
				{:else}
					<div class="flex h-full w-full items-center justify-center">
						{#if mediaType === 'movie'}
							<Clapperboard class="h-6 w-6 text-base-content/30" />
						{:else}
							<Tv class="h-6 w-6 text-base-content/30" />
						{/if}
					</div>
				{/if}
			</div>
			<div class="min-w-0 flex-1">
				<p class="font-medium wrap-break-word sm:truncate">{result.title || result.name}</p>
				<p class="text-sm text-base-content/60">
					{(result.release_date || result.first_air_date)?.substring(0, 4) ||
						m.common_unknownYear()}
				</p>
				{#if result.overview}
					<p class="mt-0.5 line-clamp-1 text-xs text-base-content/40">{result.overview}</p>
				{/if}
			</div>
			{#if trailing === 'chevron'}
				<div class="shrink-0">
					{#if busy}
						<Loader2 class="h-4 w-4 animate-spin text-base-content/40" />
					{:else}
						<ChevronRight
							class="h-4 w-4 text-base-content/20 transition-all group-hover:translate-x-0.5 group-hover:text-base-content/60"
						/>
					{/if}
				</div>
			{/if}
		</button>
	{/each}
</div>
