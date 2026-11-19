<script lang="ts">
	import type { LibrarySeries } from '#lib/types/library.js';
	import * as m from '#lib/paraglide/messages.js';
	import Panel from '#lib/components/ui/Panel.svelte';
	import FactRow from '#lib/components/ui/FactRow.svelte';

	interface Props {
		series: LibrarySeries;
		qualityProfileName?: string | null;
		configuredProviders?: { anilist: boolean; mal: boolean };
		onResolveProviderRef?: (provider: 'anilist' | 'mal') => void;
	}

	let {
		series,
		qualityProfileName = null,
		configuredProviders = { anilist: false, mal: false },
		onResolveProviderRef
	}: Props = $props();

	const seriesStoragePath = $derived.by(() => {
		const rootPath = series.rootFolderPath ?? '';
		const relativePath = series.path ?? '';

		if (!rootPath) {
			return relativePath;
		}

		if (!relativePath) {
			return rootPath;
		}

		const normalizedRoot = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;
		const normalizedRelative = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;

		return `${normalizedRoot}/${normalizedRelative}`;
	});

	const providerLinkRows = $derived.by(() => {
		const isAnimeItem =
			(series.rootFolderPath ?? '').toLowerCase().includes('/anime/') ||
			Boolean(series.providerRefs?.anilist) ||
			Boolean(series.providerRefs?.mal);
		if (!isAnimeItem) return [];

		const refs = series.providerRefs ?? {};
		const rows: Array<
			{ label: string; value: string } & (
				| { resolved: true; href: string; provider: 'anilist' | 'mal' }
				| { resolved: false; provider: 'anilist' | 'mal' }
			)
		> = [];
		if (configuredProviders.anilist && refs.anilist) {
			rows.push({
				label: 'AniList ID',
				href: `https://anilist.co/anime/${refs.anilist}`,
				value: refs.anilist,
				resolved: true,
				provider: 'anilist'
			});
		} else if (configuredProviders.anilist) {
			rows.push({
				label: 'AniList ID',
				value: 'N/A',
				resolved: false,
				provider: 'anilist'
			});
		}
		if (configuredProviders.mal && refs.mal) {
			rows.push({
				label: 'MAL ID',
				href: `https://myanimelist.net/anime/${refs.mal}`,
				value: refs.mal,
				resolved: true,
				provider: 'mal'
			});
		} else if (configuredProviders.mal) {
			rows.push({
				label: 'MAL ID',
				value: 'N/A',
				resolved: false,
				provider: 'mal'
			});
		}
		return rows;
	});
</script>

<div class="space-y-4 md:space-y-6">
	<!-- Details -->
	<Panel title={m.common_details()}>
		<dl class="space-y-2 text-sm">
			{#if series.originalTitle && series.originalTitle !== series.title}
				<FactRow label={m.library_movieDetail_originalTitle()} value={series.originalTitle} />
			{/if}
			<FactRow
				label={m.library_seriesHeader_qualityProfileLabel()}
				value={qualityProfileName || m.common_default()}
			/>
			{#if series.imdbId}
				<FactRow
					label={m.library_movieDetail_imdb()}
					value={series.imdbId}
					href={`https://www.imdb.com/title/${series.imdbId}`}
				/>
			{/if}
			<FactRow
				label={m.library_movieDetail_tmdbId()}
				value={series.tmdbId}
				href={`https://www.themoviedb.org/tv/${series.tmdbId}`}
			/>
			{#if series.tvdbId}
				<FactRow
					label={m.library_tvDetail_tvdbId()}
					value={series.tvdbId}
					href={`https://thetvdb.com/dereferrer/series/${series.tvdbId}`}
				/>
			{/if}
			{#each providerLinkRows as row (row.label)}
				<FactRow label={row.label}>
					{#if row.resolved}
						<a
							href={row.href}
							target="_blank"
							rel="noopener noreferrer"
							class="link link-primary"
						>
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
			<FactRow label={m.common_path()} variant="block" mono>
				{seriesStoragePath}
			</FactRow>
			<FactRow
				label={m.library_tvDetail_seasonFolders()}
				value={series.seasonFolder ? m.common_yes() : m.common_no()}
			/>
		</dl>
	</Panel>
</div>
