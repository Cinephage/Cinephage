<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		Clapperboard,
		Tv,
		HardDrive,
		Calendar,
		AlertCircle,
		Search,
		Trash2
	} from '@lucide/svelte';
	import type { UnmatchedFile } from '#lib/types/unmatched.js';
	import { formatDisplayDateShort } from '#lib/utils/format.js';

	interface Props {
		file: UnmatchedFile;
		selected?: boolean;
		showCheckboxes?: boolean;
		onSelect?: () => void;
		onMatch?: () => void;
		onForceMatch?: (tmdbId: number, mediaType: 'movie' | 'tv') => void;
		onDelete?: () => void;
		forceMatchLoading?: boolean;
	}

	let {
		file,
		selected = false,
		showCheckboxes = false,
		onSelect,
		onMatch,
		onForceMatch,
		onDelete,
		forceMatchLoading = false
	}: Props = $props();

	function formatSize(bytes: number | null): string {
		if (!bytes) return m.unmatched_file_unknown();
		const gb = bytes / (1024 * 1024 * 1024);
		if (gb >= 1) return `${gb.toFixed(2)} GB`;
		const mb = bytes / (1024 * 1024);
		return `${mb.toFixed(1)} MB`;
	}

	function formatPath(fullPath: string, rootPath: string | null): string {
		if (!rootPath) return fullPath;
		if (fullPath.startsWith(rootPath)) {
			return fullPath.substring(rootPath.length).replace(/^\//, '');
		}
		return fullPath;
	}

	const topCandidate = $derived(file.suggestedMatches?.[0] ?? null);
	const allCandidates = $derived(file.suggestedMatches ?? []);

	// Derived: is the near-tie ambiguous even if stored as multiple_matches?
	const isAmbiguous = $derived(
		file.reason === 'ambiguous' ||
			(file.reason === 'multiple_matches' &&
				allCandidates.length >= 2 &&
				allCandidates[0].confidence - allCandidates[1].confidence < 0.1)
	);

	// Show candidates inline for these reason codes when candidates exist
	const showCandidates = $derived(
		allCandidates.length > 0 &&
			(file.reason === 'multiple_matches' ||
				file.reason === 'ambiguous' ||
				file.reason === 'low_confidence')
	);

	// Whether the primary action is "force match" or "search manually"
	const canForceMatch = $derived(
		topCandidate !== null &&
			file.reason !== 'no_match' &&
			file.reason !== 'parse_error' &&
			file.reason !== 'parse_failed'
	);

	// Score display: 0.91 → 91
	const topScore = $derived(topCandidate ? Math.round(topCandidate.confidence * 100) : 0);

	// Button variant: warning (amber) when ambiguous/low-confidence, primary otherwise
	// Use 0.75 as the visual threshold - below that, amber; at/above, primary
	const useCaution = $derived(
		isAmbiguous ||
			file.reason === 'low_confidence' ||
			(topCandidate !== null && topCandidate.confidence < 0.75)
	);

	function reasonLabel(): string {
		switch (file.reason) {
			case 'multiple_matches':
				return m.unmatched_file_multipleMatches({ count: allCandidates.length });
			case 'ambiguous':
				return m.unmatched_file_ambiguous();
			case 'low_confidence':
				return m.unmatched_file_lowConfidence({ threshold: 75 });
			case 'no_match':
				return m.unmatched_file_noMatch();
			case 'parse_error':
			case 'parse_failed':
				return m.unmatched_file_parseError();
			default:
				return file.reason ?? '';
		}
	}

	function scoreBarClass(index: number): string {
		if (index === 0) return isAmbiguous ? 'progress-warning' : 'progress-primary';
		return 'progress-base-content/30';
	}

	let showAllCandidates = $state(false);
	const visibleCandidates = $derived(showAllCandidates ? allCandidates : allCandidates.slice(0, 3));
	const hiddenCount = $derived(allCandidates.length - 3);
</script>

<div class="rounded-lg bg-base-200 p-3 transition-colors hover:bg-base-300">
	<!-- Top row: checkbox + icon + content -->
	<div class="flex items-start gap-3">
		{#if showCheckboxes}
			<input
				type="checkbox"
				class="checkbox mt-1 shrink-0 checkbox-sm checkbox-primary"
				checked={selected}
				onchange={onSelect}
			/>
		{/if}

		<!-- Media type icon -->
		<div class="mt-0.5 shrink-0 rounded-lg bg-base-300 p-2">
			{#if file.mediaType === 'movie'}
				<Clapperboard class="h-5 w-5 text-primary" />
			{:else}
				<Tv class="h-5 w-5 text-secondary" />
			{/if}
		</div>

		<!-- Main content -->
		<div class="min-w-0 flex-1">
			<p class="leading-snug font-medium break-all" title={file.path}>
				{formatPath(file.path, file.rootFolderPath)}
			</p>
			{#if file.parsedTitle && !formatPath(file.path, file.rootFolderPath)
					.toLowerCase()
					.includes(file.parsedTitle.toLowerCase())}
				<p class="mt-0.5 text-xs text-base-content/40">
					{m.unmatched_file_parsedAs({ title: file.parsedTitle ?? '' })}
				</p>
			{/if}

			<!-- Metadata pills -->
			<div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
				<span class="flex items-center gap-1 text-base-content/50">
					<HardDrive class="h-3 w-3" />
					{formatSize(file.size)}
				</span>
				{#if file.parsedYear}
					<span class="badge badge-outline badge-sm">{file.parsedYear}</span>
				{/if}
				{#if file.mediaType === 'tv' && file.parsedSeason !== null}
					<span class="badge badge-sm badge-secondary">
						S{String(file.parsedSeason).padStart(2, '0')}{#if file.parsedEpisode !== null}E{String(
								file.parsedEpisode
							).padStart(2, '0')}{/if}
					</span>
				{/if}
				<span class="badge badge-outline badge-sm">
					{file.mediaType === 'movie' ? m.unmatched_file_movie() : m.unmatched_file_tv()}
				</span>
			</div>

			<!-- Reason -->
			{#if file.reason}
				<div class="mt-2 flex items-start gap-1 text-xs text-warning">
					<AlertCircle class="mt-0.5 h-3 w-3 shrink-0" />
					<span>{reasonLabel()}</span>
				</div>
			{/if}

			<!-- Inline candidates -->
			{#if showCandidates}
				<div
					class="mt-2 w-full space-y-1.5 rounded-md border border-base-content/10 bg-base-content/5 px-2.5 py-2"
				>
					{#each visibleCandidates as candidate, i (candidate.tmdbId)}
						{@const isTop = i === 0}
						{@const showIndex = allCandidates.length > 1}
						<!-- Mobile: wrap layout -->
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
								<span class="min-w-0 flex-1 leading-snug">
									<span class={isTop ? 'font-medium text-base-content/80' : 'text-base-content/50'}
										>{candidate.title}</span
									>
									{#if candidate.year}<span class="text-base-content/50">
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
								class="progress mt-1 h-1 w-full {scoreBarClass(i)}"
								value={candidate.confidence}
								max={1}
							></progress>
						</div>
						<!-- Desktop: single-line grid -->
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
								class="progress h-1 w-full {scoreBarClass(i)}"
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

			<!-- Date -->
			<div class="mt-2 flex items-center gap-1 text-xs text-base-content/40">
				<Calendar class="h-3 w-3" />
				<span>{formatDisplayDateShort(file.discoveredAt)}</span>
			</div>
		</div>

		<!-- Actions: desktop sidebar (hidden on mobile) -->
		<div class="hidden shrink-0 flex-col items-end gap-1.5 sm:flex">
			{#if canForceMatch}
				<div class="flex items-center gap-1.5">
					<button
						class="btn btn-sm {useCaution ? 'btn-warning' : 'btn-primary'}"
						disabled={forceMatchLoading}
						onclick={() =>
							topCandidate && onForceMatch?.(topCandidate.tmdbId, file.mediaType as 'movie' | 'tv')}
					>
						{#if forceMatchLoading}
							<span class="loading loading-xs loading-spinner"></span>
						{:else}
							{#if allCandidates.length > 1}
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
				<button
					class="btn border-error/40 btn-outline text-error btn-xs hover:border-error hover:bg-error hover:text-error-content"
					onclick={onDelete}
				>
					<Trash2 class="h-3 w-3" />{m.unmatched_file_delete()}
				</button>
			{:else}
				<div class="flex flex-col items-end gap-1">
					<button
						class="btn border border-base-content/20 bg-transparent text-base-content btn-sm hover:border-base-content/30 hover:bg-base-content/10"
						onclick={onMatch}
					>
						<Search class="h-3.5 w-3.5" />{m.unmatched_file_searchManually()}
					</button>
					<button
						class="btn border-error/40 btn-outline text-error btn-xs hover:border-error hover:bg-error hover:text-error-content"
						onclick={onDelete}
					>
						<Trash2 class="h-3 w-3" />{m.unmatched_file_delete()}
					</button>
				</div>
			{/if}
		</div>
	</div>

	<!-- Actions: mobile bottom row (hidden on sm+) -->
	<div class="mt-3 flex items-center gap-2 border-t border-base-content/10 pt-3 sm:hidden">
		{#if canForceMatch}
			<div class="flex-1">
				<button
					class="btn w-full btn-sm {useCaution ? 'btn-warning' : 'btn-primary'}"
					disabled={forceMatchLoading}
					onclick={() =>
						topCandidate && onForceMatch?.(topCandidate.tmdbId, file.mediaType as 'movie' | 'tv')}
				>
					{#if forceMatchLoading}
						<span class="loading loading-xs loading-spinner"></span>
					{:else}
						{#if allCandidates.length > 1}
							<span
								class="flex h-4 w-4 items-center justify-center rounded-full bg-white/25 text-[10px] font-bold"
								>1</span
							>
						{/if}
						{m.unmatched_file_forceMatchScore({ score: topScore })}
					{/if}
				</button>
			</div>
			<button
				class="btn shrink-0 border border-base-content/20 btn-ghost btn-sm"
				onclick={onMatch}
				aria-label={m.unmatched_file_searchManually()}
			>
				<Search class="h-3.5 w-3.5" />
			</button>
		{:else}
			<button
				class="btn flex-1 border border-base-content/20 bg-transparent btn-sm hover:bg-base-content/10"
				onclick={onMatch}
			>
				<Search class="h-3.5 w-3.5" />{m.unmatched_file_searchManually()}
			</button>
		{/if}
		<button
			class="btn border-error/40 btn-outline text-error btn-sm hover:border-error hover:bg-error hover:text-error-content"
			onclick={onDelete}
		>
			<Trash2 class="h-3.5 w-3.5" />
		</button>
	</div>
</div>
