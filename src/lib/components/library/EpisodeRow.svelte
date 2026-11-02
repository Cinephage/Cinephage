<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import {
		CheckCircle,
		XCircle,
		Search,
		Eye,
		EyeOff,
		Lock,
		Info,
		Zap,
		ChevronDown,
		Loader2,
		Captions,
		CaptionsOff,
		Trash2
	} from '@lucide/svelte';
	import QualityBadge from './QualityBadge.svelte';
	import AutoSearchStatus from './AutoSearchStatus.svelte';
	import SubtitleRequirementBadge from './SubtitleRequirementBadge.svelte';
	import { SubtitleDisplay } from '#lib/components/subtitles/index.js';
	import SubtitlePopover from '#lib/components/subtitles/SubtitlePopover.svelte';
	import { normalizeLanguageCode } from '#lib/shared/languages.js';
	import type { EpisodeSubtitleCounts } from '#lib/shared/language-profile.js';
	import type { SubtitleRequirementProgress } from '#lib/utils/subtitle-status-display.js';
	import * as m from '#lib/paraglide/messages.js';
	import { formatBytes, getFileName, formatDisplayDate } from '#lib/utils/format.js';

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

	interface Subtitle {
		id: string;
		language: string;
		isForced?: boolean;
		isHearingImpaired?: boolean;
		format?: string;
		wasSynced?: boolean;
		syncOffset?: number | null;
		isEmbedded?: boolean;
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
		/** Tri-state subtitle gate (null = inherit from series). */
		wantsSubtitlesOverride?: boolean | null;
		file: EpisodeFile | null;
		subtitles?: Subtitle[];
		/** Cutoff-aware requirement progress from the loader (null when no effective profile). */
		subtitleCounts?: EpisodeSubtitleCounts | null;
	}

	interface AutoSearchResult {
		found: boolean;
		grabbed: boolean;
		releaseName?: string;
		error?: string;
	}

	interface Props {
		episode: Episode;
		seriesMonitored: boolean;
		isStreamerProfile?: boolean;
		wantsSubtitles?: boolean;
		/** Viewer mode: hide monitor/search/delete controls, keep browsing. */
		readOnly?: boolean;
		selected?: boolean;
		showCheckbox?: boolean;
		isDownloading?: boolean;
		autoSearching?: boolean;
		autoSearchResult?: AutoSearchResult | null;
		subtitleAutoSearching?: boolean;
		subtitleSyncingId?: string | null;
		subtitleDeletingId?: string | null;
		onMonitorToggle?: (episodeId: string, newValue: boolean) => void;
		onSearch?: (episode: Episode) => void;
		onAutoSearch?: (episode: Episode) => void;
		onSelectChange?: (episodeId: string, selected: boolean) => void;
		onSubtitleSearch?: (episode: Episode) => void;
		onSubtitleAutoSearch?: (episode: Episode) => void;
		onSubtitleSync?: (subtitleId: string) => void;
		onSubtitleDelete?: (subtitleId: string) => void;
		onSubtitleGateChange?: (episodeId: string, value: boolean | null) => void;
		onDelete?: (episode: Episode) => void;
	}

	let {
		episode,
		seriesMonitored,
		isStreamerProfile = false,
		wantsSubtitles = false,
		readOnly = false,
		selected = false,
		showCheckbox = false,
		isDownloading = false,
		autoSearching = false,
		autoSearchResult = null,
		subtitleAutoSearching = false,
		subtitleSyncingId = null,
		subtitleDeletingId = null,
		onMonitorToggle,
		onSearch,
		onAutoSearch,
		onSelectChange,
		onSubtitleSearch,
		onSubtitleAutoSearch,
		onSubtitleSync,
		onSubtitleDelete,
		onSubtitleGateChange,
		onDelete
	}: Props = $props();

	// Derive auto-search status for the status indicator
	const autoSearchStatus = $derived.by(() => {
		if (autoSearching) return 'searching';
		if (autoSearchResult?.grabbed) return 'success';
		if (autoSearchResult?.error) return 'failed';
		return 'idle';
	});

	// Combine external subtitles with embedded subtitles from mediaInfo
	const allSubtitles = $derived.by(() => {
		const external = episode.subtitles ?? [];
		const combined: Subtitle[] = [...external];

		// Add embedded subtitles from file mediaInfo (if not already covered by external)
		const embeddedLangs = episode.file?.mediaInfo?.subtitleLanguages ?? [];
		const externalLangSet = new SvelteSet(external.map((s) => s.language));

		for (const lang of embeddedLangs) {
			const normalized = normalizeLanguageCode(lang);
			// Only add if we don't already have an external subtitle for this language
			if (!externalLangSet.has(normalized)) {
				combined.push({
					id: `embedded-${lang}`,
					language: normalized,
					isForced: false,
					isHearingImpaired: false,
					format: 'embedded',
					isEmbedded: true
				});
				externalLangSet.add(normalized); // Prevent duplicates
			}
		}

		return combined;
	});

	const monitorDisabled = $derived.by(() => !seriesMonitored);
	const monitorTooltip = $derived.by(() =>
		seriesMonitored
			? episode.monitored
				? m.library_episodeRow_monitored()
				: m.library_episodeRow_notMonitored()
			: m.library_episodeRow_seriesUnmonitoredTooltip()
	);
	const hasEpisodeFile = $derived(episode.file !== null);
	// Requirement-aware progress from the loader. Present only when the series
	// has an effective profile; absent -> fall back to language-agnostic count.
	const requirementCounts = $derived(episode.subtitleCounts ?? null);
	const hasRequirementCounts = $derived(
		requirementCounts !== null && requirementCounts.totalRequirements > 0
	);
	const subtitleProgress = $derived.by<SubtitleRequirementProgress | null>(() => {
		if (!hasRequirementCounts || !requirementCounts) return null;
		const { satisfiedCount, totalRequirements, satisfiedViaCutoff } = requirementCounts;
		return {
			satisfiedCount,
			totalCount: totalRequirements,
			satisfiedViaCutoff,
			state:
				satisfiedCount === 0
					? 'missing'
					: satisfiedCount < totalRequirements
						? 'partial'
						: 'satisfied'
		};
	});
	const subtitleProgressTooltip = $derived.by(() => {
		if (subtitleProgress) {
			return m.library_badges_subtitleRequirementsTooltip({
				satisfied: subtitleProgress.satisfiedCount,
				total: subtitleProgress.totalCount
			});
		}
		return missingSubtitles
			? m.library_episodeRow_noSubtitlesTooltip()
			: m.library_episodeRow_subtitleCountTooltip({ count: allSubtitles.length });
	});
	const missingSubtitles = $derived.by(() => {
		if (!hasEpisodeFile) return false;
		if (requirementCounts) {
			return requirementCounts.totalRequirements > 0 && requirementCounts.satisfiedCount === 0;
		}
		return wantsSubtitles && allSubtitles.length === 0;
	});

	function formatAirDate(dateString: string | null): string {
		if (!dateString) return m.library_episodeRow_tba();
		const date = new Date(dateString);
		const now = new Date();

		// Check if not yet aired
		if (date > now) {
			const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
			if (diffDays <= 7) {
				return m.library_episodeRow_inDays({ count: diffDays });
			}
		}

		return formatDisplayDate(dateString, { month: 'short', day: 'numeric' });
	}

	function isAired(dateString: string | null): boolean {
		if (!dateString) return false;
		return new Date(dateString) <= new Date();
	}

	function handleMonitorClick() {
		if (!seriesMonitored) return;
		if (onMonitorToggle) {
			onMonitorToggle(episode.id, !episode.monitored);
		}
	}

	function handleSearchClick() {
		if (onSearch) {
			onSearch(episode);
		}
	}

	function handleAutoSearchClick() {
		if (onAutoSearch) {
			onAutoSearch(episode);
		}
	}

	function handleCheckboxChange(event: Event) {
		const target = event.target as HTMLInputElement;
		if (onSelectChange) {
			onSelectChange(episode.id, target.checked);
		}
	}

	function handleDeleteClick() {
		if (onDelete) {
			onDelete(episode);
		}
	}

	function handleSubtitleAutoSearchClick() {
		if (subtitleAutoSearching) return;
		onSubtitleAutoSearch?.(episode);
	}
</script>

<tr class="hover" class:opacity-60={!isAired(episode.airDate) && !hasEpisodeFile}>
	<!-- Checkbox for selection -->
	{#if showCheckbox}
		<td class="w-10">
			<input
				type="checkbox"
				class="checkbox checkbox-sm checkbox-primary"
				checked={selected}
				onchange={handleCheckboxChange}
			/>
		</td>
	{/if}

	<!-- Episode number -->
	<td class="w-12 text-center font-mono text-sm">
		{episode.episodeNumber}
	</td>

	<!-- Title -->
	<td class="min-w-0">
		<div class="flex min-w-0 flex-col">
			<div class="flex items-start justify-between gap-2">
				<span
					class={`wrap-break-words min-w-0 flex-1 font-medium ${!episode.title ? 'text-base-content/60' : ''}`}
				>
					{episode.title || m.library_episodeRow_tba()}
				</span>
				<div class="ml-auto flex shrink-0 items-center gap-1 sm:hidden">
					{#if !readOnly}
						<button
							class="btn btn-ghost btn-xs {episode.monitored
								? 'text-success'
								: 'text-base-content/40'} {monitorDisabled ? 'opacity-40' : ''}"
							onclick={handleMonitorClick}
							disabled={monitorDisabled}
							title={monitorTooltip}
						>
							{#if monitorDisabled}
								<Lock size={14} />
							{:else if episode.monitored}
								<Eye size={14} />
							{:else}
								<EyeOff size={14} />
							{/if}
						</button>
					{/if}

					<AutoSearchStatus
						status={autoSearchStatus}
						releaseName={autoSearchResult?.releaseName}
						error={autoSearchResult?.error}
						size="xs"
					/>
					{#if !readOnly}
						<div class="dropdown dropdown-end">
							<div
								tabindex={autoSearching ? -1 : 0}
								role="button"
								class="btn btn-ghost btn-xs"
								class:btn-disabled={autoSearching}
								title={m.library_episodeRow_searchOptions()}
							>
								{#if autoSearching}
									<Loader2 size={14} class="animate-spin" />
								{:else}
									<Search size={14} />
								{/if}
								<ChevronDown size={10} />
							</div>
							<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
							<ul
								tabindex="0"
								class="menu dropdown-content z-50 w-52 rounded-box bg-base-200 p-2 shadow-lg"
							>
								<li class="menu-title">
									<span>{m.library_episodeRow_mediaMenuTitle()}</span>
								</li>
								<li>
									<button onclick={handleAutoSearchClick} disabled={autoSearching}>
										<Zap size={14} />
										{m.library_episodeRow_autoGrabBest()}
									</button>
								</li>
								<li>
									<button onclick={handleSearchClick}>
										<Search size={14} />
										{m.library_episodeRow_interactiveSearch()}
									</button>
								</li>
							</ul>
						</div>
					{/if}
					{#if episode.file?.mediaInfo}
						<div class="dropdown dropdown-end">
							<div tabindex="0" role="button" class="btn btn-ghost btn-xs">
								<Info size={14} />
							</div>
							<div
								tabindex="0"
								role="dialog"
								class="dropdown-content z-50 w-64 rounded-lg bg-base-200 p-3 text-xs shadow-xl"
							>
								<div class="space-y-1">
									{#if episode.file.mediaInfo.videoCodec}
										<div>
											{m.library_episodeRow_videoLabel({
												codec: episode.file.mediaInfo.videoCodec
											})}
										</div>
									{/if}
									{#if episode.file.mediaInfo.audioCodec}
										<div>
											{m.library_episodeRow_audioLabel({
												codec: episode.file.mediaInfo.audioCodec,
												channels: episode.file.mediaInfo.audioChannels ?? 0
											})}
										</div>
									{/if}
									{#if episode.file.mediaInfo.audioLanguages?.length}
										<div>
											{m.library_episodeRow_languagesLabel({
												languages: episode.file.mediaInfo.audioLanguages.join(', ')
											})}
										</div>
									{/if}
									{#if episode.file.mediaInfo.subtitleLanguages?.length}
										<div>
											{m.library_episodeRow_subsLabel({
												languages: episode.file.mediaInfo.subtitleLanguages.join(', ')
											})}
										</div>
									{/if}
									{#if episode.file.releaseGroup || isStreamerProfile}
										<div>
											{m.library_episodeRow_groupLabel({
												group: episode.file.releaseGroup ?? m.library_episodeRow_streamingLabel()
											})}
										</div>
									{/if}
								</div>
							</div>
						</div>
					{/if}
					{#if !readOnly && onDelete}
						<button
							class="btn btn-ghost btn-xs {!hasEpisodeFile && !isDownloading
								? 'text-base-content/30'
								: 'text-error'}"
							onclick={handleDeleteClick}
							disabled={!hasEpisodeFile && !isDownloading}
							title={!hasEpisodeFile && !isDownloading
								? m.library_episodeRow_noFilesToDelete()
								: m.library_episodeRow_deleteEpisode()}
						>
							<Trash2 size={14} />
						</button>
					{/if}
				</div>
			</div>
			{#if episode.file}
				<span
					class="wrap-break-words block max-w-full text-xs text-base-content/50 sm:whitespace-normal"
					title={episode.file.relativePath}
				>
					{getFileName(episode.file.relativePath)}
				</span>
			{/if}
			<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-base-content/60 sm:hidden">
				<span>{formatAirDate(episode.airDate)}</span>
				<span class="text-base-content/40">•</span>
				{#if hasEpisodeFile}
					<span class="text-success">{m.library_episodeRow_downloaded()}</span>
				{:else if isDownloading}
					<span class="text-warning">{m.library_episodeRow_downloading()}</span>
				{:else if isAired(episode.airDate)}
					<span class="text-error">{m.library_episodeRow_missing()}</span>
				{:else}
					<span class="text-base-content/50">{m.library_episodeRow_notAired()}</span>
				{/if}
				<span class="text-base-content/40">•</span>
				<span>
					{#if episode.file?.size}
						{formatBytes(episode.file.size)}
					{:else}
						—
					{/if}
				</span>
			</div>
			{#if hasEpisodeFile}
				<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-base-content/60 sm:hidden">
					{#if isStreamerProfile}
						<span class="badge badge-xs badge-secondary">Streaming</span>
					{:else}
						<QualityBadge quality={episode.file?.quality ?? null} mediaInfo={null} size="sm" />
					{/if}
					<!-- Subtitle popover trigger -->
					<div class="dropdown dropdown-end">
						<div
							tabindex="0"
							role="button"
							class="btn gap-1 btn-ghost btn-xs {missingSubtitles ? 'text-warning' : ''}"
							title={subtitleProgressTooltip}
						>
							{#if allSubtitles.length > 0}
								<Captions
									size={12}
									aria-hidden="true"
									class={missingSubtitles ? 'text-warning' : 'text-base-content/50'}
								/>
								<span class="inline-flex min-w-0">
									<SubtitleDisplay
										subtitles={allSubtitles}
										maxDisplay={1}
										size="xs"
										showSyncStatus={true}
										noWrap={true}
										countVariant="badge"
									/>
								</span>
							{:else if !hasRequirementCounts}
								<CaptionsOff size={12} aria-hidden="true" class="text-warning" />
								<span class="text-xs text-warning"
									>{m.library_episodeRow_subtitlesMissingLabel()}</span
								>
							{/if}
							{#if subtitleProgress}
								<SubtitleRequirementBadge progress={subtitleProgress} size="xs" />
							{/if}
						</div>
						{#if !readOnly}
							<SubtitlePopover
								subtitles={allSubtitles}
								hasFile={hasEpisodeFile}
								syncingId={subtitleSyncingId}
								deletingId={subtitleDeletingId}
								onSync={onSubtitleSync}
								onDelete={onSubtitleDelete}
								onSearch={() => onSubtitleSearch?.(episode)}
								onAutoSearch={handleSubtitleAutoSearchClick}
								wantsSubtitles={episode.wantsSubtitlesOverride ?? null}
								onWantsSubtitlesChange={(value) => onSubtitleGateChange?.(episode.id, value)}
							/>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</td>

	<!-- Air date -->
	<td class="hidden text-sm text-base-content/70 sm:table-cell">
		{formatAirDate(episode.airDate)}
	</td>

	<!-- Status -->
	<td class="hidden sm:table-cell">
		{#if hasEpisodeFile}
			<div class="flex flex-col gap-1">
				<div class="flex items-center gap-2">
					<CheckCircle size={16} class="text-success" />
					{#if isStreamerProfile}
						<span class="badge badge-xs badge-secondary">Streaming</span>
					{:else}
						<QualityBadge quality={episode.file?.quality ?? null} mediaInfo={null} size="sm" />
					{/if}
				</div>
				<!-- Subtitle popover trigger (desktop) -->
				<div class="dropdown dropdown-end">
					<div
						tabindex="0"
						role="button"
						class="btn max-w-full justify-start gap-1 btn-ghost px-1 btn-xs {missingSubtitles
							? 'text-warning'
							: ''}"
						title={subtitleProgressTooltip}
					>
						{#if allSubtitles.length > 0}
							<Captions
								size={12}
								aria-hidden="true"
								class={missingSubtitles ? 'text-warning' : 'text-base-content/50'}
							/>
							<span class="inline-flex max-w-38 min-w-0">
								<SubtitleDisplay
									subtitles={allSubtitles}
									maxDisplay={2}
									size="xs"
									showSyncStatus={true}
									noWrap={true}
									countVariant="badge"
								/>
							</span>
						{:else if !hasRequirementCounts}
							{#if missingSubtitles}
								<Captions size={12} aria-hidden="true" />
								<span class="text-xs text-warning"
									>{m.library_episodeRow_subtitlesMissingLabel()}</span
								>
							{:else}
								<CaptionsOff size={12} aria-hidden="true" class="text-base-content/50" />
								<span class="text-xs text-base-content/40"
									>{m.library_episodeRow_subtitlesNoneLabel()}</span
								>
							{/if}
						{/if}
						{#if subtitleProgress}
							<SubtitleRequirementBadge progress={subtitleProgress} size="xs" />
						{/if}
					</div>
					{#if !readOnly}
						<SubtitlePopover
							subtitles={allSubtitles}
							hasFile={hasEpisodeFile}
							syncingId={subtitleSyncingId}
							deletingId={subtitleDeletingId}
							onSync={onSubtitleSync}
							onDelete={onSubtitleDelete}
							onSearch={() => onSubtitleSearch?.(episode)}
							onAutoSearch={handleSubtitleAutoSearchClick}
							wantsSubtitles={episode.wantsSubtitlesOverride ?? null}
							onWantsSubtitlesChange={(value) => onSubtitleGateChange?.(episode.id, value)}
						/>
					{/if}
				</div>
			</div>
		{:else if isDownloading}
			<div class="flex items-center gap-2 text-warning">
				<Zap size={16} class="animate-pulse" />
				<span class="text-sm">{m.library_episodeRow_downloading()}</span>
			</div>
		{:else if isAired(episode.airDate)}
			<div class="flex items-center gap-2 text-error">
				<XCircle size={16} />
				<span class="text-sm">{m.library_episodeRow_missing()}</span>
			</div>
		{:else}
			<span class="text-sm text-base-content/50">{m.library_episodeRow_notAired()}</span>
		{/if}
	</td>

	<!-- Size -->
	<td class="hidden text-sm text-base-content/70 sm:table-cell">
		{#if episode.file?.size}
			{formatBytes(episode.file.size)}
		{:else}
			—
		{/if}
	</td>

	<!-- Actions -->
	<td class="hidden sm:table-cell">
		<div class="flex flex-wrap items-center gap-1">
			{#if !readOnly}
				<!-- Monitor toggle -->
				<button
					class="btn btn-ghost btn-xs {episode.monitored
						? 'text-success'
						: 'text-base-content/40'} {monitorDisabled ? 'opacity-40' : ''}"
					onclick={handleMonitorClick}
					disabled={monitorDisabled}
					title={monitorTooltip}
				>
					{#if monitorDisabled}
						<Lock size={14} />
					{:else if episode.monitored}
						<Eye size={14} />
					{:else}
						<EyeOff size={14} />
					{/if}
				</button>
			{/if}

			<!-- Auto-search status indicator -->
			<AutoSearchStatus
				status={autoSearchStatus}
				releaseName={autoSearchResult?.releaseName}
				error={autoSearchResult?.error}
				size="xs"
			/>

			{#if !readOnly}
				<!-- Search dropdown with auto-grab and interactive options -->
				<div class="dropdown dropdown-end">
					<div
						tabindex={autoSearching ? -1 : 0}
						role="button"
						class="btn btn-ghost btn-xs"
						class:btn-disabled={autoSearching}
						title={m.library_episodeRow_searchOptions()}
					>
						{#if autoSearching}
							<Loader2 size={14} class="animate-spin" />
						{:else}
							<Search size={14} />
						{/if}
						<ChevronDown size={10} />
					</div>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<ul
						tabindex="0"
						class="menu dropdown-content z-50 w-52 rounded-box bg-base-200 p-2 shadow-lg"
					>
						<li class="menu-title">
							<span>{m.library_episodeRow_mediaMenuTitle()}</span>
						</li>
						<li>
							<button onclick={handleAutoSearchClick} disabled={autoSearching}>
								<Zap size={14} />
								{m.library_episodeRow_autoGrabBest()}
							</button>
						</li>
						<li>
							<button onclick={handleSearchClick}>
								<Search size={14} />
								{m.library_episodeRow_interactiveSearch()}
							</button>
						</li>
					</ul>
				</div>
			{/if}

			<!-- File info -->
			{#if episode.file?.mediaInfo}
				<div class="dropdown dropdown-end">
					<div tabindex="0" role="button" class="btn btn-ghost btn-xs">
						<Info size={14} />
					</div>
					<div
						tabindex="0"
						role="dialog"
						class="dropdown-content z-50 w-64 rounded-lg bg-base-200 p-3 text-xs shadow-xl"
					>
						<div class="space-y-1">
							{#if episode.file.mediaInfo.videoCodec}
								<div>
									{m.library_episodeRow_videoLabel({ codec: episode.file.mediaInfo.videoCodec })}
								</div>
							{/if}
							{#if episode.file.mediaInfo.audioCodec}
								<div>
									{m.library_episodeRow_audioLabel({
										codec: episode.file.mediaInfo.audioCodec,
										channels: episode.file.mediaInfo.audioChannels ?? 0
									})}
								</div>
							{/if}
							{#if episode.file.mediaInfo.audioLanguages?.length}
								<div>
									{m.library_episodeRow_languagesLabel({
										languages: episode.file.mediaInfo.audioLanguages.join(', ')
									})}
								</div>
							{/if}
							{#if episode.file.mediaInfo.subtitleLanguages?.length}
								<div>
									{m.library_episodeRow_subsLabel({
										languages: episode.file.mediaInfo.subtitleLanguages.join(', ')
									})}
								</div>
							{/if}
							{#if episode.file.releaseGroup || isStreamerProfile}
								<div>
									{m.library_episodeRow_groupLabel({
										group: episode.file.releaseGroup ?? m.library_episodeRow_streamingLabel()
									})}
								</div>
							{/if}
						</div>
					</div>
				</div>
			{/if}

			{#if !readOnly && onDelete}
				<button
					class="btn btn-ghost btn-xs {!hasEpisodeFile && !isDownloading
						? 'text-base-content/30'
						: 'text-error'}"
					onclick={handleDeleteClick}
					disabled={!hasEpisodeFile && !isDownloading}
					title={!hasEpisodeFile && !isDownloading
						? m.library_episodeRow_noFilesToDelete()
						: m.library_episodeRow_deleteEpisode()}
				>
					<Trash2 size={14} />
				</button>
			{/if}
		</div>
	</td>
</tr>
