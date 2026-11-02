<script lang="ts">
	import {
		AlertCircle,
		Bug,
		CheckCircle2,
		ChevronDown,
		ChevronUp,
		Download,
		XCircle
	} from '@lucide/svelte';
	import { getContext } from 'svelte';

	type SearchMode = 'all' | 'multiSeasonPack';

	import type { Release } from './SearchResultRow.svelte';

	const indexerSourceCtx = getContext<{ map: Map<string, 'prowlarr' | 'jackett'> } | undefined>(
		'indexerSources'
	);

	interface IndexerResult {
		name: string;
		count: number;
		durationMs: number;
		error?: string;
	}

	interface RejectedIndexer {
		indexerId: string;
		indexerName: string;
		reason: 'searchType' | 'searchSource' | 'disabled' | 'backoff' | 'indexerFilter';
		message: string;
	}

	interface FilterBreakdown {
		afterSeasonEpisode: number;
		afterCategory: number;
		afterNonVideo: number;
		afterIdTitle: number;
	}

	interface SearchMeta {
		totalResults: number;
		afterDedup?: number;
		afterFiltering?: number;
		filterBreakdown?: FilterBreakdown;
		afterEnrichment?: number;
		rejectedCount?: number;
		searchTimeMs: number;
		enrichTimeMs?: number;
		indexerCount?: number;
		indexerResults?: Record<string, IndexerResult>;
		rejectedIndexers?: RejectedIndexer[];
	}

	interface ReportedIndexer {
		indexerId: string;
		name: string;
		displayCount: number;
		rawCount: number;
		durationMs: number;
		error?: string;
	}

	interface Props {
		meta: SearchMeta;
		searchMode: SearchMode;
		filteredReleases: Release[];
		modeBaseReleases: Release[];
		modeRejectedCount: number;
		rejectionBreakdown?: Record<string, number>;
		reportedIndexerResults: ReportedIndexer[];
		showIndexerDetails: boolean;
		showPipelineDetails: boolean;
		showDebugPanel: boolean;
		selectedDebugRelease: Record<string, unknown> | null;
		releases: Release[];
		onToggleIndexerDetails: () => void;
		onTogglePipelineDetails: () => void;
		onToggleDebugPanel: () => void;
		onDownloadDebugJson: () => void;
		onSelectDebugRelease: (release: Record<string, unknown> | null) => void;
	}

	let {
		meta,
		searchMode,
		filteredReleases,
		modeBaseReleases,
		modeRejectedCount,
		rejectionBreakdown = {},
		reportedIndexerResults,
		showIndexerDetails,
		showPipelineDetails,
		showDebugPanel,
		selectedDebugRelease,
		releases,
		onToggleIndexerDetails,
		onTogglePipelineDetails,
		onToggleDebugPanel,
		onDownloadDebugJson,
		onSelectDebugRelease
	}: Props = $props();

	function trimTitle(title: string, maxLen = 50): string {
		if (title.length <= maxLen) return title;
		return title.substring(0, maxLen) + '...';
	}
</script>

<div class="mb-4 space-y-2">
	<div class="flex flex-wrap items-center gap-4 text-sm text-base-content/70">
		{#if searchMode === 'multiSeasonPack'}
			<span>{filteredReleases.length} of {modeBaseReleases.length} multi-pack matches</span>
			{#if modeRejectedCount}
				<span class="text-warning">{modeRejectedCount} rejected</span>
			{/if}
		{:else}
			<span>{filteredReleases.length} of {meta.afterEnrichment ?? meta.totalResults} results</span>
			{#if meta.rejectedCount}
				<span class="text-warning">{meta.rejectedCount} rejected</span>
			{/if}
		{/if}
		<span>Search: {meta.searchTimeMs}ms</span>
		{#if meta.enrichTimeMs}
			<span>Enrich: {meta.enrichTimeMs}ms</span>
		{/if}
		{#if meta.indexerCount !== undefined}
			<button class="btn gap-1 btn-ghost btn-xs" onclick={onToggleIndexerDetails}>
				{meta.indexerCount} indexers
				{#if showIndexerDetails}
					<ChevronUp size={12} />
				{:else}
					<ChevronDown size={12} />
				{/if}
			</button>
		{/if}
		{#if searchMode === 'multiSeasonPack' || meta.afterDedup || meta.afterFiltering || meta.afterEnrichment}
			<button class="btn gap-1 btn-ghost btn-xs" onclick={onTogglePipelineDetails}>
				Pipeline
				{#if showPipelineDetails}
					<ChevronUp size={12} />
				{:else}
					<ChevronDown size={12} />
				{/if}
			</button>
		{/if}
	</div>

	{#if showPipelineDetails && (searchMode === 'multiSeasonPack' || meta.afterDedup || meta.afterFiltering || meta.afterEnrichment)}
		<div class="rounded-lg bg-base-200 p-3 text-sm">
			<div class="mb-2 font-medium text-base-content/80">
				{searchMode === 'multiSeasonPack' ? 'Multi-Pack Pipeline:' : 'Filtering Pipeline:'}
			</div>
			{#if searchMode === 'multiSeasonPack'}
				<div class="space-y-1">
					<div class="flex justify-between">
						<span>1. Multi-pack candidates:</span>
						<span class="font-mono">{modeBaseReleases.length}</span>
					</div>
					{#if modeRejectedCount}
						<div class="flex justify-between text-warning">
							<span>2. Quality rejected (hidden by default):</span>
							<span class="font-mono">{modeRejectedCount}</span>
						</div>
					{/if}
					<div class="mt-1 flex justify-between border-t border-base-300 pt-1">
						<span class="font-medium">3. Displayed (after limit):</span>
						<span class="font-mono font-medium">{filteredReleases.length}</span>
					</div>
				</div>
			{:else}
				<div class="space-y-1">
					<div class="flex justify-between">
						<span>1. Raw from indexers:</span>
						<span class="font-mono">{meta.totalResults}</span>
					</div>
					{#if meta.afterDedup !== undefined}
						<div class="flex justify-between">
							<span>2. After deduplication:</span>
							<span class="font-mono"
								>{meta.afterDedup}
								<span class="text-error">(-{meta.totalResults - meta.afterDedup})</span></span
							>
						</div>
					{/if}
					{#if meta.afterFiltering !== undefined}
						<div class="flex justify-between">
							<span>3. After relevance filters (season/category/ID/title/year):</span>
							<span class="font-mono"
								>{meta.afterFiltering}
								{#if meta.afterDedup !== undefined && meta.afterFiltering < meta.afterDedup}
									<span class="text-error">(-{meta.afterDedup - meta.afterFiltering})</span>
								{/if}</span
							>
						</div>
						{#if meta.filterBreakdown && meta.afterDedup !== undefined && meta.afterFiltering < meta.afterDedup}
							<div class="ml-4 space-y-0.5 text-xs text-base-content/60">
								<div class="flex justify-between">
									<span>&#9500; after season/episode:</span>
									<span class="font-mono">{meta.filterBreakdown.afterSeasonEpisode}</span>
								</div>
								<div
									class="flex justify-between {meta.filterBreakdown.afterCategory <
									meta.filterBreakdown.afterSeasonEpisode
										? 'text-error/70'
										: ''}"
								>
									<span>&#9500; after category:</span>
									<span class="font-mono">{meta.filterBreakdown.afterCategory}</span>
								</div>
								<div
									class="flex justify-between {meta.filterBreakdown.afterNonVideo <
									meta.filterBreakdown.afterCategory
										? 'text-error/70'
										: ''}"
								>
									<span>&#9500; after non-video filter:</span>
									<span class="font-mono">{meta.filterBreakdown.afterNonVideo}</span>
								</div>
								<div
									class="flex justify-between {meta.filterBreakdown.afterIdTitle <
									meta.filterBreakdown.afterNonVideo
										? 'text-error/70'
										: ''}"
								>
									<span>&#9492; after ID/title match:</span>
									<span class="font-mono">{meta.filterBreakdown.afterIdTitle}</span>
								</div>
							</div>
						{/if}
					{/if}
					{#if meta.afterEnrichment !== undefined}
						<div class="flex justify-between">
							<span>4. After quality scoring & smart dedup:</span>
							<span class="font-mono"
								>{meta.afterEnrichment}
								{#if meta.afterFiltering !== undefined && meta.afterEnrichment < meta.afterFiltering}
									<span class="text-error">(-{meta.afterFiltering - meta.afterEnrichment})</span>
								{/if}</span
							>
						</div>
					{/if}
					{#if meta.rejectedCount}
						<div class="flex justify-between text-warning">
							<span>&#9500; Quality rejected (hidden by default):</span>
							<span class="font-mono">{meta.rejectedCount}</span>
						</div>
						{#if Object.keys(rejectionBreakdown).length}
							<div class="ml-6 space-y-0.5">
								{#each Object.entries(rejectionBreakdown) as [reason, count] (reason)}
									<div class="flex justify-between text-xs text-warning/70">
										<span class="truncate">{reason}</span>
										<span class="font-mono">{count}</span>
									</div>
								{/each}
							</div>
						{/if}
					{/if}
					<div class="mt-1 flex justify-between border-t border-base-300 pt-1">
						<span class="font-medium">5. Displayed (after limit):</span>
						<span class="font-mono font-medium">{filteredReleases.length}</span>
					</div>
				</div>
			{/if}
		</div>
	{/if}

	{#if showIndexerDetails && (meta.indexerResults || meta.rejectedIndexers?.length)}
		<div class="rounded-lg bg-base-200 p-3 text-sm">
			{#if reportedIndexerResults.length > 0}
				<div class="mb-2">
					<span class="font-medium text-base-content/80"
						>{searchMode === 'multiSeasonPack'
							? 'Searched (multi-pack matches / raw):'
							: 'Raw results per indexer (before dedup & filtering):'}</span
					>
					<div class="mt-1 flex flex-wrap gap-2">
						{#each reportedIndexerResults as result (result.indexerId)}
							<div
								class="badge gap-1 {result.error
									? 'badge-error'
									: result.displayCount > 0
										? 'badge-success'
										: 'badge-ghost'}"
							>
								{#if result.error}
									<XCircle size={12} />
								{:else if result.displayCount > 0}
									<CheckCircle2 size={12} />
								{/if}
								{#if searchMode === 'multiSeasonPack'}
									{result.name}: {result.displayCount}/{result.rawCount}
								{:else}
									{result.name}: {result.displayCount}
								{/if}
								{#if indexerSourceCtx?.map.get(result.indexerId) === 'prowlarr'}
									<span class="badge badge-xs opacity-80 badge-primary">P</span>
								{:else if indexerSourceCtx?.map.get(result.indexerId) === 'jackett'}
									<span class="badge badge-xs opacity-80 badge-secondary">J</span>
								{/if}
								{#if result.error}
									<span class="tooltip" data-tip={result.error}>
										<AlertCircle size={12} />
									</span>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}

			{#if meta.rejectedIndexers?.length}
				<div>
					<span class="font-medium text-base-content/80">Skipped:</span>
					<div class="mt-1 flex flex-wrap gap-2">
						{#each meta.rejectedIndexers as rejected (rejected.indexerId)}
							<div
								class="tooltip tooltip-right badge gap-1 badge-outline badge-warning before:max-w-72 before:text-left before:whitespace-normal"
								data-tip={rejected.message}
							>
								<XCircle size={12} />
								{rejected.indexerName}
								{#if indexerSourceCtx?.map.get(rejected.indexerId) === 'prowlarr'}
									<span class="badge badge-xs opacity-80 badge-primary">P</span>
								{:else if indexerSourceCtx?.map.get(rejected.indexerId) === 'jackett'}
									<span class="badge badge-xs opacity-80 badge-secondary">J</span>
								{/if}
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	{/if}

	<div class="mt-2 flex gap-2">
		<button
			class="btn gap-1 btn-ghost btn-xs"
			onclick={onDownloadDebugJson}
			title="Download full debug JSON with all release details"
		>
			<Download size={12} />
			Download Debug JSON
		</button>
		<button
			class="btn gap-1 btn-ghost btn-xs"
			onclick={onToggleDebugPanel}
			title="View raw JSON data"
		>
			<Bug size={12} />
			{showDebugPanel ? 'Hide' : 'Show'} Debug Panel
		</button>
	</div>

	{#if showDebugPanel}
		<div class="mt-2 rounded-lg bg-base-300 p-3">
			<div class="mb-2 flex gap-2">
				<button
					class="btn btn-xs {selectedDebugRelease === null ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => onSelectDebugRelease(null)}
				>
					All Releases ({releases.length})
				</button>
				{#if selectedDebugRelease}
					<span class="text-sm text-base-content/70">
						Selected: {trimTitle(String(selectedDebugRelease.title ?? ''))}
					</span>
				{/if}
			</div>
			<div class="mb-2 text-xs text-base-content/60">
				Click on any release row below to view its detailed JSON here
			</div>
			<pre
				class="max-h-96 overflow-auto rounded bg-base-100 p-2 font-mono text-xs whitespace-pre-wrap">{JSON.stringify(
					selectedDebugRelease ?? {
						meta,
						releases: releases.slice(0, 10),
						note: 'Showing first 10 releases. Download JSON for full data.'
					},
					null,
					2
				)}</pre>
		</div>
	{/if}
</div>
