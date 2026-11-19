<script lang="ts">
	/**
	 * The movie detail sidebar's Details panel — the series, album and artist pages
	 * render the same grammar (`Panel` + `FactRow`). Provider ids and the storage
	 * path come from `#lib/shared/media-details`, so the two video detail surfaces
	 * cannot label or link them differently.
	 */
	import type { LibraryMovie } from '#lib/types/library.js';
	import * as m from '#lib/paraglide/messages.js';
	import Panel from '#lib/components/ui/Panel.svelte';
	import FactRow from '#lib/components/ui/FactRow.svelte';
	import {
		animeProviderRows,
		hasAnimeProviderLink,
		mediaStoragePath,
		type ProviderVisibility
	} from '#lib/shared/media-details.js';

	interface Props {
		movie: LibraryMovie;
		qualityProfileName?: string | null;
		configuredProviders?: ProviderVisibility;
		onResolveProviderRef?: (provider: 'anilist' | 'mal') => void;
	}

	let {
		movie,
		qualityProfileName = null,
		configuredProviders = { anilist: false, mal: false },
		onResolveProviderRef
	}: Props = $props();

	const storagePath = $derived(mediaStoragePath(movie.rootFolderPath, movie.path));
	const providerLinkRows = $derived(animeProviderRows(movie, configuredProviders));
	const showsStudios = $derived(hasAnimeProviderLink(movie));
</script>

<Panel title={m.library_movieDetail_detailsHeading()}>
	<dl class="space-y-2 text-sm">
		{#if movie.originalTitle && movie.originalTitle !== movie.title}
			<FactRow label={m.library_movieDetail_originalTitle()} value={movie.originalTitle} />
		{/if}
		{#if showsStudios && movie.studios && movie.studios.length > 0}
			<FactRow label="Studios" value={movie.studios.join(', ')} />
		{/if}
		<FactRow
			label={m.library_movieHeader_qualityProfileLabel()}
			value={qualityProfileName || m.common_default()}
		/>
		{#if movie.imdbId}
			<FactRow
				label={m.library_movieDetail_imdb()}
				value={movie.imdbId}
				href={`https://www.imdb.com/title/${movie.imdbId}`}
			/>
		{/if}
		<FactRow
			label={m.library_movieDetail_tmdbId()}
			value={movie.tmdbId}
			href={`https://www.themoviedb.org/movie/${movie.tmdbId}`}
		/>
		{#each providerLinkRows as row (row.label)}
			<FactRow label={row.label}>
				{#if row.resolved}
					<a href={row.href} target="_blank" rel="noopener noreferrer" class="link link-primary">
						{row.value}
					</a>
				{:else}
					<button
						type="button"
						class="link link-warning"
						onclick={() => onResolveProviderRef?.(row.provider)}
					>
						{row.value}
					</button>
				{/if}
			</FactRow>
		{/each}
		<FactRow label={m.library_movieDetail_path()} variant="block" mono>
			{storagePath}
		</FactRow>
	</dl>
</Panel>
