<script lang="ts">
	import {
		Eye,
		EyeOff,
		HardDrive,
		Film,
		Tv,
		Play,
		ArrowUpDown,
		ArrowUp,
		ArrowDown,
		Check
	} from '@lucide/svelte';
	import { formatBytes } from '#lib/utils/format.js';
	import { formatRelativeDate } from '#lib/utils/format-relative-date.js';
	import { getPosterUrl } from '#lib/utils/poster-url.js';
	import * as m from '#lib/paraglide/messages.js';

	type MediaExplorerItem = {
		id: string;
		tmdbId: number;
		title: string;
		year: number | null;
		mediaType: 'movie' | 'tv';
		mediaSubType: 'standard' | 'anime';
		libraryName: string;
		rootFolderName: string | null;
		monitored: boolean;
		hasFile: boolean;
		fileSize: number;
		resolution: string | null;
		videoCodec: string | null;
		hdrFormat: string | null;
		audioCodec: string | null;
		containerFormat: string | null;
		addedAt: string | null;
		playCount: number;
		lastPlayedDate: string | null;
		isPlayed: boolean;
		playedPercentage: number | null;
		episodeCount: number | null;
		episodeFileCount: number | null;
		posterPath: string | null;
	};

	interface Props {
		items: MediaExplorerItem[];
		currentSort?: string;
		onSortChange?: (sort: string) => void;
	}

	let { items, currentSort = 'title-asc', onSortChange }: Props = $props();

	function getDetailUrl(item: MediaExplorerItem): string {
		if (item.mediaType === 'movie') {
			return `/library/movie/${item.id}`;
		}
		return `/library/tv/${item.id}`;
	}

	function getQualityBadges(item: MediaExplorerItem): Array<{ label: string; type: string }> {
		const badges: Array<{ label: string; type: string }> = [];
		if (item.resolution) badges.push({ label: item.resolution, type: 'resolution' });
		if (item.videoCodec) badges.push({ label: item.videoCodec, type: 'codec' });
		if (item.hdrFormat) badges.push({ label: item.hdrFormat, type: 'hdr' });
		if (item.containerFormat) badges.push({ label: item.containerFormat, type: 'container' });
		return badges;
	}

	function getEpisodeProgress(item: MediaExplorerItem): number | null {
		if (item.mediaType !== 'tv' || !item.episodeCount || item.episodeCount === 0) return null;
		return Math.round(((item.episodeFileCount ?? 0) / item.episodeCount) * 100);
	}

	function handleHeaderSort(field: string) {
		if (!onSortChange) return;
		const [currentField, currentDir] = currentSort.split('-');
		if (currentField === field) {
			onSortChange(currentDir === 'asc' ? `${field}-desc` : `${field}-asc`);
		} else {
			onSortChange(`${field}-asc`);
		}
	}

	function getSortDirection(field: string): 'asc' | 'desc' | null {
		const [currentField, currentDir] = currentSort.split('-');
		return currentField === field ? (currentDir as 'asc' | 'desc') : null;
	}
</script>

{#if items.length === 0}
	<div class="py-12 text-center text-base-content/60">
		<Film class="mx-auto mb-4 h-12 w-12 opacity-40" />
		<p class="text-lg font-medium">{m.mediaExplorer_noMediaFound()}</p>
	</div>
{:else}
	<!-- Mobile: Card View -->
	<div class="space-y-3 lg:hidden">
		{#each items as item (item.id)}
			{@const qualityBadges = getQualityBadges(item)}
			{@const progress = getEpisodeProgress(item)}
			<a href={getDetailUrl(item)} class="block">
				<div class="rounded-xl bg-base-200 p-3 transition-colors hover:bg-base-300">
					<div class="flex items-start gap-3">
						{#if item.posterPath}
							<div class="shrink-0">
								<img
									src={getPosterUrl(item.posterPath)}
									alt={item.title}
									class="h-24 w-16 rounded object-cover"
									loading="lazy"
								/>
							</div>
						{:else}
							<div class="flex h-24 w-16 shrink-0 items-center justify-center rounded bg-base-300">
								{#if item.mediaType === 'movie'}
									<Film class="h-6 w-6 opacity-40" />
								{:else}
									<Tv class="h-6 w-6 opacity-40" />
								{/if}
							</div>
						{/if}

						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-1.5">
								<span class="line-clamp-2 text-sm font-medium">
									{item.title}
								</span>
							</div>
							<div class="mt-0.5 flex flex-wrap items-center gap-1.5">
								{#if item.year}
									<span class="text-xs text-base-content/60">({item.year})</span>
								{/if}
								<span class="badge badge-ghost badge-sm">
									{#if item.mediaType === 'movie'}
										<Film class="h-3 w-3" />
										{m.mediaExplorer_typeMovie()}
									{:else}
										<Tv class="h-3 w-3" />
										{m.mediaExplorer_typeTv()}
									{/if}
								</span>
								{#if item.mediaSubType === 'anime'}
									<span class="badge badge-xs badge-secondary">{m.mediaExplorer_typeAnime()}</span>
								{/if}
							</div>

							{#if item.fileSize > 0}
								<div class="mt-1">
									<span class="badge badge-xs badge-info">
										{formatBytes(item.fileSize)}
									</span>
								</div>
							{/if}

							{#if qualityBadges.length > 0}
								<div class="mt-1 flex flex-wrap gap-1">
									{#each qualityBadges as badge (`${badge.type}-${badge.label}`)}
										<span class="badge badge-outline badge-xs">{badge.label}</span>
									{/each}
								</div>
							{/if}

							<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
								{#if item.monitored}
									<Eye class="h-3.5 w-3.5 text-success" />
								{:else}
									<EyeOff class="h-3.5 w-3.5 text-base-content/40" />
								{/if}
								{#if item.hasFile}
									<HardDrive class="h-3.5 w-3.5 text-success" />
								{:else}
									<HardDrive class="h-3.5 w-3.5 text-warning" />
								{/if}
								{#if item.playCount > 0}
									<span class="badge badge-ghost badge-xs">
										{#if item.isPlayed}
											<Check class="h-2.5 w-2.5 text-success" />
										{:else}
											<Play class="h-2.5 w-2.5" />
										{/if}
										{item.playCount}
									</span>
								{/if}
							</div>

							{#if progress !== null}
								<div class="mt-1.5">
									<div class="flex items-center gap-2 text-xs text-base-content/60">
										<span
											>{item.episodeFileCount ?? 0}/{item.episodeCount ?? 0}
											{m.mediaExplorer_episodes()}</span
										>
										{#if progress === 100}
											<span class="badge badge-xs badge-success">{m.mediaExplorer_complete()}</span>
										{:else if progress > 0}
											<span class="badge badge-xs badge-primary">{progress}%</span>
										{/if}
									</div>
									{#if progress > 0}
										<progress
											class="progress mt-1 h-1.5 w-full max-w-40 {progress === 100
												? 'progress-success'
												: 'progress-primary'}"
											value={progress}
											max="100"
										></progress>
									{/if}
								</div>
							{/if}
							{#if item.playedPercentage !== null && item.playCount > 0}
								<div class="mt-1.5">
									<div class="flex items-center gap-1.5 text-xs text-base-content/60">
										<progress
											class="progress h-1.5 w-full max-w-32 {item.playedPercentage >= 90
												? 'progress-success'
												: 'progress-primary'}"
											value={Math.min(100, Math.round(item.playedPercentage))}
											max="100"
										></progress>
										<span>{Math.min(100, Math.round(item.playedPercentage))}%</span>
									</div>
								</div>
							{/if}
						</div>
					</div>
				</div>
			</a>
		{/each}
	</div>

	<!-- Desktop: Table View with Sortable Headers -->
	<div class="hidden overflow-visible lg:block">
		<table class="table table-sm">
			<thead>
				<tr>
					<th class="w-14"></th>
					<th>
						<button
							class="flex items-center gap-1 text-xs font-medium tracking-wide uppercase {getSortDirection(
								'title'
							) !== null
								? 'text-primary'
								: 'text-base-content/50 hover:text-base-content'}"
							onclick={() => handleHeaderSort('title')}
						>
							{m.mediaExplorer_headerTitle()}
							{#if getSortDirection('title') === 'asc'}
								<ArrowUp class="h-3 w-3" />
							{:else if getSortDirection('title') === 'desc'}
								<ArrowDown class="h-3 w-3" />
							{:else}
								<ArrowUpDown class="h-3 w-3 opacity-40" />
							{/if}
						</button>
					</th>
					<th>{m.mediaExplorer_headerType()}</th>
					<th>{m.mediaExplorer_headerLibrary()}</th>
					<th>{m.mediaExplorer_headerQuality()}</th>
					<th>
						<button
							class="flex items-center gap-1 text-xs font-medium tracking-wide uppercase {getSortDirection(
								'size'
							) !== null
								? 'text-primary'
								: 'text-base-content/50 hover:text-base-content'}"
							onclick={() => handleHeaderSort('size')}
						>
							{m.mediaExplorer_headerSize()}
							{#if getSortDirection('size') === 'asc'}
								<ArrowUp class="h-3 w-3" />
							{:else if getSortDirection('size') === 'desc'}
								<ArrowDown class="h-3 w-3" />
							{:else}
								<ArrowUpDown class="h-3 w-3 opacity-40" />
							{/if}
						</button>
					</th>
					<th>
						<button
							class="flex items-center gap-1 text-xs font-medium tracking-wide uppercase {getSortDirection(
								'plays'
							) !== null
								? 'text-primary'
								: 'text-base-content/50 hover:text-base-content'}"
							onclick={() => handleHeaderSort('plays')}
						>
							{m.mediaExplorer_headerPlayback()}
							{#if getSortDirection('plays') === 'asc'}
								<ArrowUp class="h-3 w-3" />
							{:else if getSortDirection('plays') === 'desc'}
								<ArrowDown class="h-3 w-3" />
							{:else}
								<ArrowUpDown class="h-3 w-3 opacity-40" />
							{/if}
						</button>
					</th>
					<th>{m.mediaExplorer_headerStatus()}</th>
					<th>
						<button
							class="flex items-center gap-1 text-xs font-medium tracking-wide uppercase {getSortDirection(
								'added'
							) !== null
								? 'text-primary'
								: 'text-base-content/50 hover:text-base-content'}"
							onclick={() => handleHeaderSort('added')}
						>
							{m.mediaExplorer_headerAdded()}
							{#if getSortDirection('added') === 'asc'}
								<ArrowUp class="h-3 w-3" />
							{:else if getSortDirection('added') === 'desc'}
								<ArrowDown class="h-3 w-3" />
							{:else}
								<ArrowUpDown class="h-3 w-3 opacity-40" />
							{/if}
						</button>
					</th>
				</tr>
			</thead>
			<tbody>
				{#each items as item (item.id)}
					{@const qualityBadges = getQualityBadges(item)}
					{@const progress = getEpisodeProgress(item)}
					{@const addedRel = item.addedAt ? formatRelativeDate(item.addedAt) : null}
					{@const lastPlayedRel = item.lastPlayedDate
						? formatRelativeDate(item.lastPlayedDate)
						: null}
					<tr class="transition-colors hover:bg-base-200/60">
						<td>
							{#if item.posterPath}
								<a href={getDetailUrl(item)}>
									<img
										src={getPosterUrl(item.posterPath)}
										alt={item.title}
										class="h-14 w-10 rounded object-cover"
										loading="lazy"
									/>
								</a>
							{:else}
								<div class="flex h-14 w-10 items-center justify-center rounded bg-base-300">
									{#if item.mediaType === 'movie'}
										<Film class="h-4 w-4 opacity-40" />
									{:else}
										<Tv class="h-4 w-4 opacity-40" />
									{/if}
								</div>
							{/if}
						</td>

						<td>
							<div class="flex items-center gap-1.5">
								<a
									href={getDetailUrl(item)}
									class="block max-w-xs truncate font-medium hover:underline"
								>
									{item.title}
								</a>
								{#if item.year}
									<span class="shrink-0 text-xs text-base-content/60">
										({item.year})
									</span>
								{/if}
								{#if item.mediaSubType === 'anime'}
									<span class="badge badge-xs badge-secondary">{m.mediaExplorer_typeAnime()}</span>
								{/if}
							</div>
						</td>

						<td>
							<span class="badge badge-ghost badge-sm">
								{#if item.mediaType === 'movie'}
									<Film class="h-3 w-3" />
									{m.mediaExplorer_typeMovie()}
								{:else}
									<Tv class="h-3 w-3" />
									{m.mediaExplorer_typeTv()}
								{/if}
							</span>
						</td>

						<td>
							<span class="text-sm text-base-content/60">
								{item.libraryName || '-'}
							</span>
						</td>

						<td>
							{#if qualityBadges.length > 0}
								<div class="flex flex-wrap gap-1">
									{#each qualityBadges as badge (`${badge.type}-${badge.label}`)}
										<span class="badge badge-outline badge-xs">{badge.label}</span>
									{/each}
								</div>
							{:else}
								<span class="text-sm text-base-content/40">-</span>
							{/if}
						</td>

						<td>
							<span class="text-sm">
								{item.fileSize > 0 ? formatBytes(item.fileSize) : '-'}
							</span>
						</td>

						<td>
							<div class="flex flex-col gap-0.5">
								<div class="flex items-center gap-1">
									{#if item.playCount > 0}
										{#if item.isPlayed}
											<Check class="h-3.5 w-3.5 text-success" />
										{:else}
											<Play class="h-3 w-3 text-base-content/50" />
										{/if}
										<span class="text-sm">{item.playCount}</span>
									{:else}
										<span class="text-sm text-base-content/40">-</span>
									{/if}
								</div>
								{#if item.playedPercentage !== null && item.playCount > 0}
									<div class="flex items-center gap-1.5">
										<progress
											class="progress h-1.5 w-full max-w-16 {item.playedPercentage >= 90
												? 'progress-success'
												: 'progress-primary'}"
											value={Math.min(100, Math.round(item.playedPercentage))}
											max="100"
										></progress>
										<span class="text-xs text-base-content/50"
											>{Math.min(100, Math.round(item.playedPercentage))}%</span
										>
									</div>
								{/if}
								{#if lastPlayedRel}
									<span class="text-xs text-base-content/50" title={lastPlayedRel.full}>
										{lastPlayedRel.display}
									</span>
								{/if}
							</div>
						</td>

						<td>
							<div class="flex items-center gap-1.5">
								{#if item.monitored}
									<span
										class="badge badge-sm badge-success"
										title={m.mediaExplorer_statusMonitored()}
									>
										<Eye class="h-3.5 w-3.5" />
									</span>
								{:else}
									<span
										class="badge badge-ghost badge-sm"
										title={m.mediaExplorer_statusUnmonitored()}
									>
										<EyeOff class="h-3.5 w-3.5" />
									</span>
								{/if}
								{#if item.hasFile}
									<span
										class="badge badge-sm badge-success"
										title={m.mediaExplorer_statusFileAvailable()}
									>
										<HardDrive class="h-3.5 w-3.5" />
									</span>
								{:else}
									<span class="badge badge-sm badge-warning" title={m.mediaExplorer_statusNoFile()}>
										<HardDrive class="h-3.5 w-3.5" />
									</span>
								{/if}
								{#if progress !== null}
									<span class="text-xs text-base-content/60">
										{item.episodeFileCount ?? 0}/{item.episodeCount ?? 0}
									</span>
									{#if progress > 0 && progress < 100}
										<progress class="progress w-12 progress-primary" value={progress} max="100"
										></progress>
									{:else if progress === 100}
										<span class="badge badge-xs badge-success">{m.mediaExplorer_statusDone()}</span>
									{/if}
								{/if}
							</div>
						</td>

						<td>
							{#if addedRel}
								<span class="text-sm text-base-content/60" title={addedRel.full}>
									{addedRel.display}
								</span>
							{:else}
								<span class="text-sm text-base-content/40">-</span>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
