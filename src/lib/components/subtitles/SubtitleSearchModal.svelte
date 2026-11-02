<script lang="ts">
	import { SvelteSet, SvelteMap } from 'svelte/reactivity';
	import { X, Search, Loader2, RefreshCw, Captions, AlertTriangle, Info } from '@lucide/svelte';
	import SubtitleSearchResultRow from './SubtitleSearchResultRow.svelte';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { searchSubtitles, downloadSubtitle, getSubtitleProviders } from '#lib/api/subtitles.js';
	import { ALL_LANGUAGE_OPTIONS } from '#lib/shared/languages.js';

	interface SubtitleResult {
		providerId: string;
		providerName: string;
		providerSubtitleId: string;
		language: string;
		title: string;
		releaseName?: string;
		fileName?: string;
		isForced: boolean;
		isHearingImpaired: boolean;
		format: string;
		isHashMatch: boolean;
		matchScore: number;
		downloadUrl?: string;
		pageLink?: string;
		movieFileId?: string;
		movieFileName?: string;
		fileSize?: number;
		downloadCount?: number;
		uploadDate?: string;
	}

	interface ProviderFailure {
		providerId: string;
		providerName: string;
		error?: string;
	}

	interface SubtitleProviderOption {
		id: string;
		name: string;
		enabled?: boolean;
	}

	interface DownloadedSubtitle {
		id: string;
		language: string;
		isForced?: boolean;
		isHearingImpaired?: boolean;
		format?: string;
		wasSynced?: boolean;
		syncOffset?: number | null;
	}

	interface Props {
		open: boolean;
		title: string;
		movieId?: string;
		episodeId?: string;
		onClose: () => void;
		onDownloaded?: (subtitle: DownloadedSubtitle) => void;
	}

	let { open, title, movieId, episodeId, onClose, onDownloaded }: Props = $props();

	// State
	let results = $state<SubtitleResult[]>([]);
	let searching = $state(false);
	let searchError = $state<string | null>(null);
	let downloadingIds = new SvelteSet<string>();
	let downloadedIds = new SvelteSet<string>();
	let downloadErrors = new SvelteMap<string, string>();
	let searchTriggered = $state(false);
	let searchMeta = $state<{ totalResults: number; searchTimeMs: number } | null>(null);
	let providerResults = $state<ProviderFailure[]>([]);
	let bestRejectedScore = $state<number | null>(null);
	let bestRejectedReason = $state<'requirement' | 'threshold' | null>(null);
	let effectiveMinimumScore = $state<number | null>(null);

	// Pre-search filters (sent with every search)
	let providers = $state<SubtitleProviderOption[]>([]);
	let providersLoaded = $state(false);
	let selectedProviderIds = $state<string[]>([]);
	let selectedLanguages = $state<string[]>([]);
	let languageSeeded = $state(false);
	let includeForced = $state(true);
	let includeHearingImpaired = $state(true);
	let excludeHearingImpaired = $state(false);

	// Sorting & Filtering (client-side, on top of server results)
	let sortBy = $state<'score' | 'language'>('score');
	let sortDir = $state<'asc' | 'desc'>('desc');
	let filterQuery = $state('');
	let showHashOnly = $state(false);
	let languageFilterQuery = $state('');
	const visibleLanguageOptions = $derived.by(() => {
		const q = languageFilterQuery.trim().toLowerCase();
		if (!q) return ALL_LANGUAGE_OPTIONS;
		return ALL_LANGUAGE_OPTIONS.filter(
			(option) => option.name.toLowerCase().includes(q) || option.code.toLowerCase().includes(q)
		);
	});

	// Provider failures worth surfacing to the user.
	const providerFailures = $derived(providerResults.filter((p) => p.error));

	// Show the threshold notice only when results exist but none would be
	// auto-downloaded for the effective profile.
	const thresholdNotice = $derived(
		results.length > 0 && bestRejectedScore !== null
			? {
					total: searchMeta?.totalResults ?? results.length,
					score: bestRejectedScore,
					threshold: effectiveMinimumScore
				}
			: null
	);

	// Derived filtered/sorted results
	const filteredResults = $derived.by(() => {
		let result = [...results];

		// Filter by hash match
		if (showHashOnly) {
			result = result.filter((r) => r.isHashMatch);
		}

		// Filter by query
		if (filterQuery) {
			const q = filterQuery.toLowerCase();
			result = result.filter(
				(r) =>
					r.title.toLowerCase().includes(q) ||
					r.language.toLowerCase().includes(q) ||
					r.providerName.toLowerCase().includes(q)
			);
		}

		// Sort
		result.sort((a, b) => {
			let comparison = 0;
			switch (sortBy) {
				case 'score':
					comparison = a.matchScore - b.matchScore;
					break;
				case 'language':
					comparison = a.language.localeCompare(b.language);
					break;
			}
			return sortDir === 'desc' ? -comparison : comparison;
		});

		return result;
	});

	// Group results by originating movie file so multi-file movies are labelled.
	const resultGroups = $derived.by(() => {
		const groups = new SvelteMap<string, { id: string; label: string; items: SubtitleResult[] }>();
		for (const result of filteredResults) {
			const id = result.movieFileId ?? '';
			let group = groups.get(id);
			if (!group) {
				group = { id, label: result.movieFileName ?? '', items: [] };
				groups.set(id, group);
			}
			group.items.push(result);
		}
		return [...groups.values()];
	});

	// Auto-search when modal opens
	$effect(() => {
		if (open && results.length === 0 && !searching && !searchTriggered) {
			searchTriggered = true;
			performSearch();
		}
	});

	// Load the provider list once for the pre-search filter.
	$effect(() => {
		if (open && !providersLoaded) {
			providersLoaded = true;
			loadProviders();
		}
	});

	// Reset state when modal closes
	$effect(() => {
		if (!open) {
			results = [];
			searchError = null;
			downloadingIds.clear();
			downloadedIds.clear();
			downloadErrors.clear();
			filterQuery = '';
			searchTriggered = false;
			searchMeta = null;
			providerResults = [];
			bestRejectedScore = null;
			bestRejectedReason = null;
			effectiveMinimumScore = null;
			selectedProviderIds = [];
			selectedLanguages = [];
			languageFilterQuery = '';
			languageSeeded = false;
			includeForced = true;
			includeHearingImpaired = true;
			excludeHearingImpaired = false;
		}
	});

	async function loadProviders() {
		try {
			const data = (await getSubtitleProviders()) as unknown as SubtitleProviderOption[] | null;
			providers = (Array.isArray(data) ? data : []).filter((p) => p.enabled !== false);
		} catch {
			// Non-fatal: the filter simply stays empty.
			providers = [];
		}
	}

	async function performSearch() {
		searching = true;
		searchError = null;

		try {
			const searchBody: Record<string, unknown> = {
				...(movieId ? { movieId } : {}),
				...(episodeId ? { episodeId } : {}),
				includeForced,
				includeHearingImpaired,
				excludeHearingImpaired
			};
			if (selectedLanguages.length > 0) searchBody.languages = [...selectedLanguages];
			if (selectedProviderIds.length > 0) searchBody.providerIds = [...selectedProviderIds];

			const data = (await searchSubtitles(searchBody)) as unknown as {
				results?: SubtitleResult[];
				totalResults: number;
				searchTimeMs: number;
				languages?: string[];
				providerResults?: ProviderFailure[];
				bestRejectedScore?: number;
				bestRejectedReason?: 'requirement' | 'threshold';
				effectiveMinimumScore?: number;
			};

			results = data.results || [];
			searchMeta = {
				totalResults: data.totalResults,
				searchTimeMs: data.searchTimeMs
			};
			providerResults = data.providerResults ?? [];
			bestRejectedScore = data.bestRejectedScore ?? null;
			bestRejectedReason = data.bestRejectedReason ?? null;
			effectiveMinimumScore = data.effectiveMinimumScore ?? null;

			// Seed the language filter from the effective profile on first search.
			if (!languageSeeded && data.languages && data.languages.length > 0) {
				selectedLanguages = [...data.languages];
				languageSeeded = true;
			}
		} catch (err) {
			searchError = err instanceof Error ? err.message : 'Search failed';
			results = [];
			providerResults = [];
			bestRejectedScore = null;
			bestRejectedReason = null;
			effectiveMinimumScore = null;
		} finally {
			searching = false;
		}
	}

	async function handleDownload(result: SubtitleResult) {
		const key = getResultKey(result);
		downloadingIds.add(key);
		downloadErrors.delete(key);

		try {
			// Submit the full selected result so provider-specific fields
			// (downloadUrl/pageLink/releaseName/movieFileId) survive the round-trip.
			const downloadBody = {
				providerId: result.providerId,
				providerName: result.providerName,
				providerSubtitleId: result.providerSubtitleId,
				language: result.language,
				title: result.title,
				releaseName: result.releaseName,
				fileName: result.fileName,
				isForced: result.isForced,
				isHearingImpaired: result.isHearingImpaired,
				format: result.format,
				isHashMatch: result.isHashMatch,
				matchScore: result.matchScore,
				downloadUrl: result.downloadUrl,
				pageLink: result.pageLink,
				movieFileId: result.movieFileId,
				fileSize: result.fileSize,
				uploadDate: result.uploadDate,
				downloadCount: result.downloadCount,
				...(movieId ? { movieId } : {}),
				...(episodeId ? { episodeId } : {})
			};

			const data = (await downloadSubtitle(downloadBody)) as unknown as {
				success: boolean;
				subtitle?: {
					subtitleId?: string;
					language?: string;
					format?: string;
					wasSynced?: boolean;
					syncOffset?: number | null;
				};
			};

			downloadedIds.add(key);
			onDownloaded?.({
				id: data.subtitle?.subtitleId ?? key,
				language: data.subtitle?.language ?? result.language,
				isForced: result.isForced,
				isHearingImpaired: result.isHearingImpaired,
				format: data.subtitle?.format ?? result.format,
				wasSynced: data.subtitle?.wasSynced,
				syncOffset: data.subtitle?.syncOffset ?? null
			});
		} catch (err) {
			downloadErrors.set(key, err instanceof Error ? err.message : 'Download failed');
		} finally {
			downloadingIds.delete(key);
		}
	}

	function toggleSort(field: typeof sortBy) {
		if (sortBy === field) {
			sortDir = sortDir === 'desc' ? 'asc' : 'desc';
		} else {
			sortBy = field;
			sortDir = 'desc';
		}
	}

	// Include movieFileId so identical provider results for different quality
	// tiers of a multi-file movie get distinct keys.
	function getResultKey(result: SubtitleResult): string {
		return `${result.providerId}:${result.providerSubtitleId}:${result.movieFileId ?? ''}`;
	}

	function toggleProvider(id: string): void {
		selectedProviderIds = selectedProviderIds.includes(id)
			? selectedProviderIds.filter((p) => p !== id)
			: [...selectedProviderIds, id];
	}

	function toggleLanguage(code: string): void {
		selectedLanguages = selectedLanguages.includes(code)
			? selectedLanguages.filter((l) => l !== code)
			: [...selectedLanguages, code];
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="4xl" labelledBy="subtitle-search-modal-title">
	<!-- Header -->
	<div class="mb-4 flex items-center justify-between">
		<div>
			<h3 id="subtitle-search-modal-title" class="flex items-center gap-2 text-lg font-bold">
				<Captions size={20} class="text-primary" />
				Subtitle Search
			</h3>
			<p class="text-sm text-base-content/60">{title}</p>
		</div>
		<div class="flex items-center gap-2">
			<button class="btn btn-ghost btn-sm" onclick={performSearch} disabled={searching}>
				{#if searching}
					<Loader2 size={16} class="animate-spin" />
				{:else}
					<RefreshCw size={16} />
				{/if}
				Search
			</button>
			<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
				<X size={16} />
			</button>
		</div>
	</div>

	<!-- Search stats -->
	{#if searchMeta}
		<div class="mb-4 flex flex-wrap items-center gap-4 text-sm text-base-content/70">
			<span>{searchMeta.totalResults} results</span>
			<span>Search: {searchMeta.searchTimeMs}ms</span>
		</div>
	{/if}

	<!-- Pre-search filters -->
	<div class="mb-4 flex flex-col gap-4 rounded-lg border border-base-300 p-3">
		<div class="flex flex-wrap items-start gap-x-6 gap-y-4">
			<div class="min-w-0 flex-1 basis-48">
				<span
					class="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-base-content/60 uppercase"
				>
					Providers
					{#if selectedProviderIds.length > 0}
						<span class="badge badge-sm badge-primary">{selectedProviderIds.length}</span>
					{/if}
				</span>
				{#if providers.length > 0}
					<div class="flex flex-wrap gap-1.5">
						{#each providers as provider (provider.id)}
							<button
								type="button"
								class="btn btn-xs {selectedProviderIds.includes(provider.id)
									? 'btn-primary'
									: 'border-base-300 btn-outline hover:btn-primary'}"
								onclick={() => toggleProvider(provider.id)}
							>
								{provider.name}
							</button>
						{/each}
					</div>
				{:else}
					<p class="text-xs text-base-content/50">No providers configured</p>
				{/if}
			</div>

			<div class="flex flex-col gap-1.5">
				<label class="label cursor-pointer justify-start gap-2 py-0">
					<input type="checkbox" class="checkbox checkbox-sm" bind:checked={includeForced} />
					<span class="label-text text-xs">Include forced</span>
				</label>
				<label class="label cursor-pointer justify-start gap-2 py-0">
					<input
						type="checkbox"
						class="checkbox checkbox-sm"
						bind:checked={includeHearingImpaired}
					/>
					<span class="label-text text-xs">Include HI</span>
				</label>
				<label class="label cursor-pointer justify-start gap-2 py-0">
					<input
						type="checkbox"
						class="checkbox checkbox-sm"
						bind:checked={excludeHearingImpaired}
					/>
					<span class="label-text text-xs">Exclude HI</span>
				</label>
			</div>
		</div>

		<div class="min-w-0">
			<span
				class="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-base-content/60 uppercase"
			>
				Languages
				{#if selectedLanguages.length > 0}
					<span class="badge badge-sm badge-primary">{selectedLanguages.length}</span>
				{/if}
			</span>
			<input
				type="text"
				placeholder="Filter languages…"
				class="input-bordered input mb-1.5 w-full max-w-56 input-xs"
				bind:value={languageFilterQuery}
			/>
			<div class="max-h-28 overflow-y-auto rounded-md bg-base-200/50 p-1.5">
				<div class="flex flex-wrap gap-1.5">
					{#each visibleLanguageOptions as option (option.code)}
						<button
							type="button"
							class="btn btn-xs {selectedLanguages.includes(option.code)
								? 'btn-primary'
								: 'border-base-300 btn-outline hover:btn-primary'}"
							onclick={() => toggleLanguage(option.code)}
						>
							{option.name}
						</button>
					{:else}
						<p class="text-xs text-base-content/50">No languages match "{languageFilterQuery}"</p>
					{/each}
				</div>
			</div>
		</div>
	</div>

	<!-- Client-side result filtering -->
	<div class="mb-4 flex flex-wrap items-center gap-4">
		<div class="form-control">
			<div class="input-group input-group-sm">
				<input
					type="text"
					placeholder="Filter results..."
					class="input-bordered input w-full input-sm sm:w-48"
					bind:value={filterQuery}
				/>
			</div>
		</div>

		<label class="label cursor-pointer gap-2">
			<input
				type="checkbox"
				class="checkbox checkbox-sm checkbox-primary"
				bind:checked={showHashOnly}
			/>
			<span class="label-text">Hash matches only</span>
		</label>
	</div>

	<!-- Provider failures -->
	{#if providerFailures.length > 0}
		<div class="mb-4 alert text-sm alert-warning">
			<AlertTriangle size={16} />
			<div>
				<p class="font-medium">
					{providerFailures.length} provider{providerFailures.length === 1 ? '' : 's'} failed
				</p>
				<ul class="list-inside list-disc text-xs">
					{#each providerFailures as provider (provider.providerId)}
						<li>{provider.providerName}: {provider.error}</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}

	<!-- Threshold notice -->
	{#if thresholdNotice}
		<div class="mb-4 alert text-sm alert-info">
			<Info size={16} />
			<span>
				{thresholdNotice.total} results, best score {thresholdNotice.score} below threshold
				{thresholdNotice.threshold ?? '—'}{#if bestRejectedReason === 'requirement'}
					(no result matched the required language/variant){/if}
			</span>
		</div>
	{/if}

	<!-- Results -->
	<div class="flex-1 overflow-auto">
		{#if searching}
			<div class="flex flex-col items-center justify-center py-12">
				<Loader2 size={32} class="animate-spin text-primary" />
				<p class="mt-4 text-base-content/60">Searching subtitle providers...</p>
			</div>
		{:else if searchError}
			<div class="alert alert-error">
				<span>{searchError}</span>
			</div>
		{:else if results.length === 0}
			<div class="flex flex-col items-center justify-center py-12">
				<Search size={48} class="text-base-content/30" />
				<p class="mt-4 text-base-content/60">No subtitles found</p>
				<p class="mt-2 text-sm text-base-content/40">
					Try adjusting your language profile or search filters
				</p>
			</div>
		{:else if filteredResults.length === 0}
			<div class="flex flex-col items-center justify-center py-12">
				<Search size={48} class="text-base-content/30" />
				<p class="mt-4 text-base-content/60">No results match your filters</p>
			</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="table table-sm">
					<thead class="sticky top-0 z-10 bg-base-100">
						<tr>
							<th>
								<button class="btn btn-ghost btn-xs" onclick={() => toggleSort('language')}>
									Language {sortBy === 'language' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
								</button>
							</th>
							<th>Release</th>
							<th>Provider</th>
							<th>
								<button class="btn btn-ghost btn-xs" onclick={() => toggleSort('score')}>
									Score {sortBy === 'score' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
								</button>
							</th>
							<th>Actions</th>
						</tr>
					</thead>
					{#each resultGroups as group (group.id)}
						<tbody>
							{#if resultGroups.length > 1}
								<tr class="bg-base-200">
									<td colspan="5" class="text-xs font-semibold">
										{group.label || 'Movie file'}
									</td>
								</tr>
							{/if}
							{#each group.items as result (getResultKey(result))}
								<SubtitleSearchResultRow
									{result}
									onDownload={handleDownload}
									downloading={downloadingIds.has(getResultKey(result))}
									downloaded={downloadedIds.has(getResultKey(result))}
									error={downloadErrors.get(getResultKey(result))}
								/>
							{/each}
						</tbody>
					{/each}
				</table>
			</div>
		{/if}
	</div>

	<!-- Footer -->
	<div class="modal-action">
		<button class="btn" onclick={onClose}>Close</button>
	</div>
</ModalWrapper>
