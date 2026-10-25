<script lang="ts">
	import {
		ChevronDown,
		ChevronRight,
		Eye,
		EyeOff,
		Lock,
		Search,
		Zap,
		Loader2,
		Trash2,
		Captions
	} from '@lucide/svelte';
	import EpisodeRow from './EpisodeRow.svelte';
	import AutoSearchStatus from './AutoSearchStatus.svelte';
	import { formatBytes, todayDateString } from '#lib/utils/format.js';
	import { calculateEpisodeStats } from '#lib/utils/episode-stats.svelte.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Subtitle {
		id: string;
		language: string;
		isForced?: boolean;
		isHearingImpaired?: boolean;
		format?: string;
		wasSynced?: boolean;
		syncOffset?: number | null;
	}

	interface EpisodeFile {
		id: string;
		relativePath: string;
		size: number | null;
		quality: {
			resolution?: string;
			source?: string;
			codec?: string;
			hdr?: string;
		} | null;
		mediaInfo: {
			videoCodec?: string;
			audioCodec?: string;
			audioChannels?: number;
			audioLanguages?: string[];
			subtitleLanguages?: string[];
		} | null;
		releaseGroup: string | null;
	}

	interface Episode {
		id: string;
		seasonNumber: number;
		episodeNumber: number;
		absoluteEpisodeNumber: number | null;
		title: string | null;
		airDate: string | null;
		runtime: number | null;
		monitored: boolean | null;
		hasFile: boolean | null;
		file: EpisodeFile | null;
		subtitles?: Subtitle[];
	}

	interface Season {
		id: string;
		seasonNumber: number;
		name: string | null;
		monitored: boolean | null;
		episodeCount: number | null;
		episodeFileCount: number | null;
		episodes: Episode[];
	}

	interface AutoSearchResult {
		found: boolean;
		grabbed: boolean;
		releaseName?: string;
		error?: string;
	}

	interface Props {
		season: Season;
		seriesMonitored: boolean;
		isStreamerProfile?: boolean;
		wantsSubtitles?: boolean;
		/** Viewer mode: hide monitor/search/delete controls, keep browsing. */
		readOnly?: boolean;
		defaultOpen?: boolean;
		selectedEpisodes?: Set<string>;
		showCheckboxes?: boolean;
		downloadingEpisodeIds?: Set<string>;
		downloadingSeasons?: Set<number>;
		autoSearchingSeason?: boolean;
		autoSearchSeasonResult?: AutoSearchResult | null;
		autoSearchingEpisodes?: Set<string>;
		autoSearchEpisodeResults?: Map<string, AutoSearchResult>;
		subtitleAutoSearchingEpisodes?: Set<string>;
		subtitleAutoSearchingSeason?: boolean;
		subtitleSyncingId?: string | null;
		subtitleDeletingId?: string | null;
		onToggleOpen?: (seasonId: string) => void;
		onSeasonMonitorToggle?: (seasonId: string, newValue: boolean) => void;
		onEpisodeMonitorToggle?: (episodeId: string, newValue: boolean) => void;
		onSeasonSearch?: (season: Season) => void;
		onAutoSearchSeason?: (season: Season) => void;
		onSubtitleAutoSearchSeason?: (season: Season) => void;
		onEpisodeSearch?: (episode: Episode) => void;
		onAutoSearchEpisode?: (episode: Episode) => void;
		onEpisodeSelectChange?: (episodeId: string, selected: boolean) => void;
		onSelectAllInSeason?: (seasonId: string, selectAll: boolean) => void;
		onSubtitleSearch?: (episode: Episode) => void;
		onSubtitleAutoSearch?: (episode: Episode) => void;
		onSubtitleSync?: (subtitleId: string) => void;
		onSubtitleGateChange?: (episodeId: string, value: boolean | null) => void;
		onSubtitleDelete?: (subtitleId: string) => void;
		onSeasonDelete?: (season: Season) => void;
		onEpisodeDelete?: (episode: Episode) => void;
	}

	let {
		season,
		seriesMonitored,
		isStreamerProfile = false,
		wantsSubtitles = false,
		readOnly = false,
		defaultOpen = false,
		selectedEpisodes = new Set(),
		showCheckboxes = false,
		downloadingEpisodeIds = new Set(),
		downloadingSeasons = new Set(),
		autoSearchingSeason = false,
		autoSearchSeasonResult = null,
		autoSearchingEpisodes = new Set(),
		autoSearchEpisodeResults = new Map(),
		subtitleAutoSearchingEpisodes = new Set(),
		subtitleAutoSearchingSeason = false,
		subtitleSyncingId = null,
		subtitleDeletingId = null,
		onToggleOpen,
		onSeasonMonitorToggle,
		onEpisodeMonitorToggle,
		onSeasonSearch,
		onAutoSearchSeason,
		onSubtitleAutoSearchSeason,
		onEpisodeSearch,
		onAutoSearchEpisode,
		onEpisodeSelectChange,
		onSelectAllInSeason,
		onSubtitleSearch,
		onSubtitleAutoSearch,
		onSubtitleSync,
		onSubtitleGateChange,
		onSubtitleDelete,
		onSeasonDelete,
		onEpisodeDelete
	}: Props = $props();

	// Track accordion open state - sync when defaultOpen prop changes
	let isOpen = $state(false);
	$effect(() => {
		isOpen = defaultOpen;
	});

	// Keep header counts aligned with visible rows (episodes array), not cached flags/aggregates.
	const episodeStats = $derived(calculateEpisodeStats(season.episodes));
	const downloadedCount = $derived(episodeStats.downloaded);
	const totalCount = $derived(episodeStats.totalAired);
	const percentComplete = $derived(episodeStats.percentComplete);

	// Calculate cumulative season file size
	const seasonSize = $derived(season.episodes.reduce((sum, ep) => sum + (ep.file?.size ?? 0), 0));

	// Calculate subtitle stats for the season header
	const episodesWithFiles = $derived(season.episodes.filter((ep) => ep.file !== null));
	const episodesWithSubs = $derived(
		episodesWithFiles.filter((ep) => (ep.subtitles?.length ?? 0) > 0)
	);
	const subtitleCoverage = $derived(
		episodesWithFiles.length > 0
			? { withSubs: episodesWithSubs.length, total: episodesWithFiles.length }
			: null
	);

	// Calculate selection state for season checkbox
	const seasonEpisodeIds = $derived(season.episodes.map((e) => e.id));
	const selectedInSeasonCount = $derived(
		seasonEpisodeIds.filter((id) => selectedEpisodes.has(id)).length
	);
	const isAllSelected = $derived(
		season.episodes.length > 0 && selectedInSeasonCount === season.episodes.length
	);
	const isSomeSelected = $derived(
		selectedInSeasonCount > 0 && selectedInSeasonCount < season.episodes.length
	);

	// Derive auto-search status for the season
	const autoSearchSeasonStatus = $derived.by(() => {
		if (autoSearchingSeason) return 'searching';
		if (autoSearchSeasonResult?.grabbed) return 'success';
		if (autoSearchSeasonResult?.error) return 'failed';
		return 'idle';
	});
	const seasonMonitorDisabled = $derived.by(() => !seriesMonitored);

	const seasonPartiallyMonitored = $derived.by(() => {
		const today = todayDateString();
		const aired = season.episodes.filter((ep) => ep.airDate && ep.airDate <= today);
		if (aired.length === 0) return false;
		const monitored = aired.filter((ep) => ep.monitored !== false).length;
		return monitored > 0 && monitored < aired.length;
	});

	const seasonMonitorTooltip = $derived.by(() =>
		seriesMonitored
			? seasonPartiallyMonitored
				? m.library_seasonAccordion_seasonPartiallyMonitored()
				: season.monitored
					? m.library_seasonAccordion_seasonMonitored()
					: m.library_seasonAccordion_seasonNotMonitored()
			: m.library_seasonAccordion_seriesUnmonitoredTooltip()
	);

	function getSeasonName(): string {
		if (season.seasonNumber === 0) return m.library_seasonAccordion_specials();
		return season.name || m.common_season({ number: season.seasonNumber });
	}

	function handleSeasonMonitorToggle() {
		if (!seriesMonitored) return;
		if (onSeasonMonitorToggle) {
			onSeasonMonitorToggle(season.id, !season.monitored);
		}
	}

	function handleSeasonSearch() {
		if (onSeasonSearch) {
			onSeasonSearch(season);
		}
	}

	function handleAutoSearchSeason() {
		if (onAutoSearchSeason) {
			onAutoSearchSeason(season);
		}
	}

	function handleSelectAllChange(event: Event) {
		const target = event.target as HTMLInputElement;
		if (onSelectAllInSeason) {
			onSelectAllInSeason(season.id, target.checked);
		}
	}

	function handleSubtitleAutoSearchSeason() {
		if (onSubtitleAutoSearchSeason) {
			onSubtitleAutoSearchSeason(season);
		}
	}

	function handleSeasonDelete() {
		if (onSeasonDelete) {
			onSeasonDelete(season);
		}
	}
</script>

<div class="max-w-full overflow-hidden rounded-lg border border-base-300 bg-base-100">
	<!-- Header -->
	<div
		class="flex w-full flex-col gap-3 p-4 transition-colors hover:bg-base-200 sm:flex-row sm:items-center sm:justify-between"
	>
		<!-- Clickable area for expand/collapse -->
		<div class="flex w-full flex-col gap-2 sm:flex-row sm:flex-nowrap sm:items-center">
			<button
				class="flex min-w-0 flex-1 items-center gap-3 text-left"
				onclick={() => {
					if (onToggleOpen) {
						onToggleOpen(season.id);
					} else {
						isOpen = !isOpen;
					}
				}}
			>
				{#if isOpen}
					<ChevronDown size={20} class="text-base-content/50" />
				{:else}
					<ChevronRight size={20} class="text-base-content/50" />
				{/if}

				<div class="min-w-0">
					<h3 class="font-semibold">{getSeasonName()}</h3>
					<div class="mt-1 flex flex-wrap items-center gap-2 text-sm text-base-content/60">
						<span class="whitespace-nowrap">
							{m.library_seasonAccordion_episodesCount({
								count: totalCount
							})}
							{#if seasonSize > 0}
								<span class="text-base-content/40">·</span>
								{formatBytes(seasonSize)}
							{/if}
						</span>
						{#if percentComplete === 100}
							<span class="badge badge-xs badge-success"
								>{m.library_seasonAccordion_completeBadge()}</span
							>
						{:else if percentComplete > 0}
							<span class="badge badge-xs badge-primary">{percentComplete}%</span>
						{/if}
						{#if wantsSubtitles && subtitleCoverage}
							<span class="text-base-content/40">·</span>
							<span
								class="inline-flex items-center gap-1 whitespace-nowrap {subtitleCoverage.withSubs ===
								subtitleCoverage.total
									? 'text-success/70'
									: subtitleCoverage.withSubs === 0
										? 'text-warning/70'
										: 'text-base-content/50'}"
							>
								<Captions size={12} />
								{subtitleCoverage.withSubs}/{subtitleCoverage.total}
							</span>
						{/if}
					</div>
				</div>
			</button>

			<!-- Action buttons -->
			<div class="mx-auto flex shrink-0 items-center gap-2 sm:mx-0 sm:ml-auto">
				{#if !readOnly}
					<!-- Season monitor toggle -->
					<button
						class="btn btn-ghost btn-sm {seasonPartiallyMonitored
							? 'text-warning'
							: season.monitored
								? 'text-success'
								: 'text-base-content/40'} {seasonMonitorDisabled ? 'opacity-40' : ''}"
						onclick={handleSeasonMonitorToggle}
						disabled={seasonMonitorDisabled}
						title={seasonMonitorTooltip}
					>
						{#if seasonMonitorDisabled}
							<Lock size={16} />
						{:else if seasonPartiallyMonitored || season.monitored}
							<Eye size={16} />
						{:else}
							<EyeOff size={16} />
						{/if}
					</button>
				{/if}

				<!-- Auto-search status indicator -->
				<AutoSearchStatus
					status={autoSearchSeasonStatus}
					releaseName={autoSearchSeasonResult?.releaseName}
					error={autoSearchSeasonResult?.error}
					size="sm"
				/>

				{#if !readOnly}
					<!-- Auto-grab season pack -->
					<button
						class="btn btn-ghost btn-sm"
						onclick={handleAutoSearchSeason}
						disabled={autoSearchingSeason}
						title={m.library_seasonAccordion_autoGrabSeasonPack()}
					>
						{#if autoSearchingSeason}
							<Loader2 size={16} class="animate-spin" />
						{:else}
							<Zap size={16} />
						{/if}
					</button>

					<!-- Auto-download subtitles for season -->
					{#if onSubtitleAutoSearchSeason}
						<button
							class="btn btn-ghost btn-sm"
							onclick={handleSubtitleAutoSearchSeason}
							disabled={subtitleAutoSearchingSeason}
							title={m.library_seasonAccordion_autoDownloadSubs()}
						>
							{#if subtitleAutoSearchingSeason}
								<Loader2 size={16} class="animate-spin" />
							{:else}
								<Captions size={16} />
							{/if}
						</button>
					{/if}

					<!-- Interactive search season -->
					<button
						class="btn btn-ghost btn-sm"
						onclick={handleSeasonSearch}
						title={m.library_seasonAccordion_searchSeason()}
					>
						<Search size={16} />
					</button>

					<!-- Delete season -->
					{#if onSeasonDelete}
						<button
							class="btn btn-ghost btn-sm {downloadedCount === 0
								? 'text-base-content/30'
								: 'text-error'}"
							onclick={handleSeasonDelete}
							disabled={downloadedCount === 0}
							title={downloadedCount === 0
								? m.library_seasonAccordion_noFilesToDelete()
								: m.library_seasonAccordion_deleteSeason()}
						>
							<Trash2 size={16} />
						</button>
					{/if}
				{/if}
			</div>
		</div>
	</div>

	<!-- Episodes table -->
	{#if isOpen}
		<div class="border-t border-base-300">
			{#if season.episodes.length === 0}
				<div class="p-8 text-center text-base-content/60">
					{m.library_seasonAccordion_noEpisodes()}
				</div>
			{:else}
				<div class="w-full max-w-full overflow-x-hidden sm:overflow-x-auto">
					<table class="table w-full table-sm sm:min-w-160 sm:table-auto">
						<thead>
							<tr class="text-xs text-base-content/60">
								{#if showCheckboxes}
									<th class="w-10">
										<input
											type="checkbox"
											class="checkbox checkbox-sm checkbox-primary"
											checked={isAllSelected}
											indeterminate={isSomeSelected}
											onchange={handleSelectAllChange}
											title={m.library_seasonAccordion_selectAllEpisodes()}
										/>
									</th>
								{/if}
								<th class="w-12 text-center">{m.library_seasonAccordion_episodeNumberColumn()}</th>
								<th>{m.library_seasonAccordion_titleColumn()}</th>
								<th class="hidden w-24 sm:table-cell"
									>{m.library_seasonAccordion_airDateColumn()}</th
								>
								<th class="hidden w-32 sm:table-cell">{m.library_seasonAccordion_statusColumn()}</th
								>
								<th class="hidden w-20 sm:table-cell">{m.library_seasonAccordion_sizeColumn()}</th>
								<th class="hidden w-28 sm:table-cell"
									>{m.library_seasonAccordion_actionsColumn()}</th
								>
							</tr>
						</thead>
						<tbody>
							{#each season.episodes as episode (episode.id)}
								<EpisodeRow
									{episode}
									{seriesMonitored}
									{isStreamerProfile}
									{wantsSubtitles}
									{readOnly}
									selected={selectedEpisodes.has(episode.id)}
									showCheckbox={showCheckboxes}
									isDownloading={downloadingEpisodeIds.has(episode.id) ||
										downloadingSeasons.has(episode.seasonNumber)}
									autoSearching={autoSearchingEpisodes.has(episode.id)}
									autoSearchResult={autoSearchEpisodeResults.get(episode.id) ?? null}
									subtitleAutoSearching={subtitleAutoSearchingEpisodes.has(episode.id)}
									{subtitleSyncingId}
									{subtitleDeletingId}
									onMonitorToggle={onEpisodeMonitorToggle}
									onSearch={onEpisodeSearch}
									onAutoSearch={onAutoSearchEpisode}
									onSelectChange={onEpisodeSelectChange}
									{onSubtitleSearch}
									{onSubtitleAutoSearch}
									{onSubtitleSync}
									{onSubtitleGateChange}
									{onSubtitleDelete}
									onDelete={onEpisodeDelete}
								/>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{/if}
</div>
