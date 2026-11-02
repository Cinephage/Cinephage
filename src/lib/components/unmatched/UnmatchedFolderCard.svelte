<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		ChevronDown,
		ChevronUp,
		Search,
		Trash2,
		AlertCircle,
		HardDrive,
		Clapperboard,
		Tv
	} from '@lucide/svelte';
	import type { UnmatchedFolder } from '#lib/types/unmatched.js';
	import { getFileName } from '#lib/utils/format.js';
	import { SvelteMap } from 'svelte/reactivity';

	interface AggregatedCandidate {
		tmdbId: number;
		title: string;
		year?: number;
		confidence: number;
	}

	interface Props {
		folder: UnmatchedFolder;
		expanded?: boolean;
		onToggle?: () => void;
		onMatch?: () => void;
		onDelete?: () => void;
		onForceMatch?: (tmdbId: number, mediaType: 'movie' | 'tv') => void;
		forceMatchLoading?: boolean;
	}

	let {
		folder,
		expanded = false,
		onToggle,
		onMatch,
		onDelete,
		onForceMatch,
		forceMatchLoading = false
	}: Props = $props();

	function formatSize(bytes: number | null): string {
		if (!bytes) return m.unmatched_file_unknown();
		const gb = bytes / (1024 * 1024 * 1024);
		if (gb >= 1) return `${gb.toFixed(2)} GB`;
		const mb = bytes / (1024 * 1024);
		return `${mb.toFixed(1)} MB`;
	}

	function formatReason(reason: string): string {
		switch (reason) {
			case 'multiple_matches':
				return m.unmatched_folder_reason_multipleMatches();
			case 'ambiguous':
				return m.unmatched_folder_reason_ambiguous();
			case 'low_confidence':
				return m.unmatched_folder_reason_lowConfidence();
			case 'no_match':
				return m.unmatched_folder_reason_noMatch();
			case 'parse_error':
			case 'parse_failed':
				return m.unmatched_folder_reason_parseFailed();
			default:
				return reason;
		}
	}

	const totalSize = $derived(folder.files.reduce((sum, f) => sum + (f.size ?? 0), 0));

	// Aggregate candidates from all files: deduplicate by tmdbId, average confidence
	const aggregatedCandidates = $derived<AggregatedCandidate[]>(
		(() => {
			const map = new SvelteMap<
				number,
				{ title: string; year?: number; total: number; count: number }
			>();
			for (const file of folder.files) {
				for (const c of file.suggestedMatches ?? []) {
					const existing = map.get(c.tmdbId);
					if (existing) {
						existing.total += c.confidence;
						existing.count += 1;
					} else {
						map.set(c.tmdbId, { title: c.title, year: c.year, total: c.confidence, count: 1 });
					}
				}
			}
			return Array.from(map.entries())
				.map(([tmdbId, v]) => ({
					tmdbId,
					title: v.title,
					year: v.year,
					confidence: v.total / v.count
				}))
				.sort((a, b) => b.confidence - a.confidence);
		})()
	);

	const topCandidate = $derived(aggregatedCandidates[0] ?? null);
	const topScore = $derived(topCandidate ? Math.round(topCandidate.confidence * 100) : 0);
	const showCandidates = $derived(aggregatedCandidates.length > 0);
	const canForceMatch = $derived(topCandidate !== null && topScore >= 75);
	const isAmbiguous = $derived(
		aggregatedCandidates.length >= 2 &&
			aggregatedCandidates[0].confidence - aggregatedCandidates[1].confidence < 0.1
	);
	const useCaution = $derived(isAmbiguous || topScore < 75);

	let showAllCandidates = $state(false);
	const visibleCandidates = $derived(
		showAllCandidates ? aggregatedCandidates : aggregatedCandidates.slice(0, 3)
	);
	const hiddenCount = $derived(aggregatedCandidates.length - 3);
</script>

<div class="rounded-lg bg-base-200 p-3 transition-colors hover:bg-base-300">
	<!-- Top row: icon + content + desktop actions -->
	<div class="flex items-start gap-3">
		<!-- Folder icon -->
		<div class="mt-0.5 shrink-0 rounded-lg bg-base-300 p-2">
			{#if folder.mediaType === 'movie'}
				<Clapperboard class="h-5 w-5 text-primary" />
			{:else}
				<Tv class="h-5 w-5 text-secondary" />
			{/if}
		</div>

		<!-- Main content -->
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-2">
				<h3 class="truncate leading-snug font-medium" title={folder.folderPath}>
					{folder.folderName}
				</h3>
			</div>
			<p class="mt-0.5 truncate text-xs text-base-content/40" title={folder.folderPath}>
				{folder.folderPath}
			</p>

			<!-- Metadata pills -->
			<div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
				<span class="flex items-center gap-1 text-base-content/50">
					<HardDrive class="h-3 w-3" />
					{formatSize(totalSize)}
				</span>
				<span class="badge badge-outline badge-sm">
					{folder.fileCount}
					{folder.fileCount === 1 ? m.common_file() : m.common_files()}
				</span>
				<span class="badge badge-outline badge-sm">
					{folder.mediaType === 'movie' ? m.unmatched_folder_movie() : m.unmatched_folder_tv()}
				</span>
				{#if folder.seasonFolders && folder.seasonFolders.length > 0}
					<span class="badge badge-sm badge-secondary">
						{folder.seasonFolders.length}
						{folder.seasonFolders.length === 1 ? m.common_season() : m.common_seasons()}
					</span>
				{/if}
			</div>

			<!-- Reasons -->
			{#if folder.reasons.length > 0}
				<div class="mt-2 flex flex-wrap gap-1.5">
					{#each folder.reasons as reason (reason)}
						<div class="flex items-center gap-1 text-xs text-warning">
							<AlertCircle class="h-3 w-3 shrink-0" />
							<span>{formatReason(reason)}</span>
						</div>
					{/each}
				</div>
			{/if}

			{#if folder.commonParsedTitle && folder.commonParsedTitle.toLowerCase() !== folder.folderName.toLowerCase()}
				<p class="mt-1 text-xs text-base-content/40">
					{m.unmatched_folder_parsed({ title: folder.commonParsedTitle })}
				</p>
			{/if}

			{#if folder.seasonFolders && folder.seasonFolders.length > 0}
				<div class="mt-2 flex flex-wrap gap-1">
					{#each folder.seasonFolders as season (season.name)}
						<span class="badge badge-outline badge-xs">{season.name} ({season.fileCount})</span>
					{/each}
				</div>
			{/if}

			<!-- Aggregated candidates -->
			{#if showCandidates}
				<button
					class="mt-2 flex w-full items-center justify-between rounded-md border border-base-content/10 bg-base-content/5 px-2.5 py-1.5 text-xs text-base-content/60 transition-colors hover:bg-base-content/10 sm:hidden"
					onclick={() => (showAllCandidates = !showAllCandidates)}
				>
					<span
						>{aggregatedCandidates.length === 1
							? m.unmatched_candidates_count({ count: 1 })
							: m.unmatched_candidates_count({ count: aggregatedCandidates.length })}</span
					>
					{#if showAllCandidates}
						<ChevronUp class="h-3.5 w-3.5" />
					{:else}
						<ChevronDown class="h-3.5 w-3.5" />
					{/if}
				</button>

				<div
					class="{showAllCandidates
						? 'block'
						: 'hidden'} mt-2 w-full space-y-1.5 rounded-md border border-base-content/10 bg-base-content/5 px-2.5 py-2 sm:block"
				>
					{#each visibleCandidates as candidate, i (candidate.tmdbId)}
						{@const isTop = i === 0}
						{@const showIndex = aggregatedCandidates.length > 1}
						<!-- Mobile wrap layout -->
						<div class="text-xs sm:hidden">
							<div class="flex items-start gap-x-2">
								{#if showIndex}
									<span
										class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold
										{isTop
											? useCaution
												? 'bg-warning text-warning-content'
												: 'bg-primary text-primary-content'
											: 'bg-base-content/15 text-base-content/40'}"
									>
										{i + 1}
									</span>
								{/if}
								<span
									class="min-w-0 flex-1 leading-snug {isTop
										? 'font-medium text-base-content/80'
										: 'text-base-content/50'}"
								>
									{candidate.title}{#if candidate.year}<span
											class="font-normal text-base-content/50"
										>
											({candidate.year})</span
										>{/if}
									<span class="ml-1 text-base-content/40">· tmdb:{candidate.tmdbId}</span>
								</span>
								<span
									class="shrink-0 tabular-nums {isTop
										? 'text-base-content/80'
										: 'text-base-content/50'}"
								>
									{Math.round(candidate.confidence * 100)}%
								</span>
							</div>
							<progress
								class="progress mt-1 h-1 w-full {isTop
									? useCaution
										? 'progress-warning'
										: 'progress-primary'
									: 'progress-base-content/30'}"
								value={candidate.confidence}
								max={1}
							></progress>
						</div>
						<!-- Desktop grid layout -->
						<div
							class="hidden items-center gap-x-2 text-xs sm:grid"
							style="grid-template-columns: {showIndex
								? '1rem '
								: ''}minmax(0,2fr) minmax(0,1fr) 2.5rem;"
						>
							{#if showIndex}
								<span
									class="flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold
									{isTop
										? useCaution
											? 'bg-warning text-warning-content'
											: 'bg-primary text-primary-content'
										: 'bg-base-content/15 text-base-content/40'}"
								>
									{i + 1}
								</span>
							{/if}
							<span
								class="truncate {isTop
									? 'font-medium text-base-content/80'
									: 'text-base-content/50'}"
							>
								{candidate.title}{#if candidate.year}<span class="font-normal text-base-content/50">
										({candidate.year})</span
									>{/if}
								<span class="ml-1 text-base-content/40">· tmdb:{candidate.tmdbId}</span>
							</span>
							<progress
								class="progress h-1 w-full {isTop
									? useCaution
										? 'progress-warning'
										: 'progress-primary'
									: 'progress-base-content/30'}"
								value={candidate.confidence}
								max={1}
							></progress>
							<span
								class="text-right tabular-nums {isTop
									? 'text-base-content/80'
									: 'text-base-content/50'}"
							>
								{Math.round(candidate.confidence * 100)}%
							</span>
						</div>
					{/each}
					{#if hiddenCount > 0 || showAllCandidates}
						<button
							class="mt-0.5 w-full text-left text-xs text-base-content/40 transition-colors hover:text-base-content/60"
							onclick={() => (showAllCandidates = !showAllCandidates)}
						>
							{showAllCandidates
								? m.unmatched_candidates_showLess()
								: m.unmatched_candidates_more({ count: hiddenCount })}
						</button>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Desktop actions (hidden on mobile) -->
		<div class="hidden shrink-0 flex-col items-end gap-1.5 sm:flex">
			{#if canForceMatch}
				<div class="flex items-center gap-1.5">
					<button
						class="btn btn-sm {useCaution ? 'btn-warning' : 'btn-primary'}"
						disabled={forceMatchLoading}
						onclick={() => topCandidate && onForceMatch?.(topCandidate.tmdbId, folder.mediaType)}
					>
						{#if forceMatchLoading}
							<span class="loading loading-xs loading-spinner"></span>
						{:else}
							{#if aggregatedCandidates.length > 1}
								<span
									class="flex h-4 w-4 items-center justify-center rounded-full bg-white/25 text-[10px] font-bold"
									>1</span
								>
							{/if}
							{m.unmatched_file_forceMatchScore({ score: topScore })}
						{/if}
					</button>
					<button
						class="btn border border-base-content/20 btn-ghost btn-sm"
						onclick={onMatch}
						aria-label={m.unmatched_file_searchManually()}
					>
						<Search class="h-3.5 w-3.5" />
					</button>
				</div>
			{:else}
				<button
					class="btn border border-base-content/20 bg-transparent btn-sm hover:bg-base-content/10"
					onclick={onMatch}
				>
					<Search class="h-3.5 w-3.5" />{m.unmatched_file_searchManually()}
				</button>
			{/if}
			<div class="flex items-center gap-1.5">
				<button
					class="btn border border-base-content/15 btn-ghost btn-xs"
					onclick={onToggle}
					aria-label={expanded ? m.unmatched_folder_collapse() : m.unmatched_folder_expand()}
				>
					{#if expanded}<ChevronUp class="h-3.5 w-3.5" />{:else}<ChevronDown
							class="h-3.5 w-3.5"
						/>{/if}
					{expanded ? m.unmatched_folder_collapse() : m.unmatched_folder_expand()}
				</button>
				<button
					class="btn border-error/40 btn-outline text-error btn-xs hover:border-error hover:bg-error hover:text-error-content"
					onclick={onDelete}
				>
					<Trash2 class="h-3 w-3" />{m.unmatched_file_delete()}
				</button>
			</div>
		</div>
	</div>

	<!-- Mobile bottom row (hidden on sm+) -->
	<div class="mt-3 flex items-center gap-2 border-t border-base-content/10 pt-3 sm:hidden">
		{#if canForceMatch}
			<button
				class="btn flex-1 btn-sm {useCaution ? 'btn-warning' : 'btn-primary'}"
				disabled={forceMatchLoading}
				onclick={() => topCandidate && onForceMatch?.(topCandidate.tmdbId, folder.mediaType)}
			>
				{#if forceMatchLoading}
					<span class="loading loading-xs loading-spinner"></span>
				{:else}
					{#if aggregatedCandidates.length > 1}
						<span
							class="flex h-4 w-4 items-center justify-center rounded-full bg-white/25 text-[10px] font-bold"
							>1</span
						>
					{/if}
					{m.unmatched_file_forceMatchScore({ score: topScore })}
				{/if}
			</button>
		{:else}
			<button
				class="btn flex-1 border border-base-content/20 bg-transparent btn-sm hover:bg-base-content/10"
				onclick={onMatch}
			>
				<Search class="h-3.5 w-3.5" />{m.unmatched_file_searchManually()}
			</button>
		{/if}
		{#if canForceMatch}
			<button
				class="btn border border-base-content/20 btn-ghost btn-sm"
				onclick={onMatch}
				aria-label={m.unmatched_file_searchManually()}
			>
				<Search class="h-3.5 w-3.5" />
			</button>
		{/if}
		<button
			class="btn border border-base-content/15 btn-ghost btn-sm"
			onclick={onToggle}
			aria-label={expanded ? m.unmatched_folder_collapse() : m.unmatched_folder_expand()}
		>
			{#if expanded}
				<ChevronUp class="h-4 w-4" />
			{:else}
				<ChevronDown class="h-4 w-4" />
			{/if}
		</button>
		<button
			class="btn border-error/40 btn-outline text-error btn-sm hover:border-error hover:bg-error hover:text-error-content"
			onclick={onDelete}
		>
			<Trash2 class="h-3.5 w-3.5" />
		</button>
	</div>

	<!-- Expanded file list -->
	{#if expanded}
		<div class="mt-3 border-t border-base-content/10 pt-3">
			<p class="mb-2 text-xs font-medium text-base-content/50">
				{m.unmatched_folder_filesInFolder()}
			</p>
			<div class="space-y-1">
				{#each folder.files as file (file.id)}
					<div class="rounded-md bg-base-content/5 px-3 py-2 text-xs">
						<div class="flex items-center justify-between gap-2">
							<span class="truncate font-medium text-base-content/80">{getFileName(file.path)}</span
							>
							<div class="flex shrink-0 items-center gap-1.5">
								{#if file.parsedSeason !== null && file.parsedEpisode !== null}
									<span class="badge badge-xs badge-secondary">
										S{String(file.parsedSeason).padStart(2, '0')}E{String(
											file.parsedEpisode
										).padStart(2, '0')}
									</span>
								{/if}
								<span class="text-base-content/40">{formatSize(file.size)}</span>
							</div>
						</div>
						{#if file.reason}
							<div class="mt-1 flex items-center gap-1 text-warning">
								<AlertCircle class="h-2.5 w-2.5 shrink-0" />
								<span>{formatReason(file.reason)}</span>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
