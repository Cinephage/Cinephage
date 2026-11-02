<script lang="ts">
	import { SvelteSet, SvelteMap } from 'svelte/reactivity';
	import { setContext } from 'svelte';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import SearchHeader from './SearchHeader.svelte';
	import SearchStats from './SearchStats.svelte';
	import SearchFilters from './SearchFilters.svelte';
	import SearchResultsList from './SearchResultsList.svelte';
	import { BlockReleaseModal } from '#lib/components/blocklist/index.js';
	import { getUsenetServers } from '#lib/api/usenet.js';
	import { searchReleases } from '#lib/api/indexers.js';
	import { addToBlocklist } from '#lib/api/settings.js';
	import { isMultiSeasonPack } from '#lib/utils/release-analysis.js';
	import { getGrabErrorMessage } from './grab-errors.js';
	import { downloadDebugJson as downloadJsonFile } from './debug-export.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import * as m from '#lib/paraglide/messages.js';
	import type { Release } from './SearchResultRow.svelte';

	interface IndexerResult {
		name: string;
		count: number;
		durationMs: number;
		error?: string;
		searchMethod?: 'id' | 'text';
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
		/** Results after first deduplication */
		afterDedup?: number;
		/** Results after season/category filtering */
		afterFiltering?: number;
		/** Per-step filter breakdown */
		filterBreakdown?: FilterBreakdown;
		/** Results after enrichment and smart dedup */
		afterEnrichment?: number;
		rejectedCount?: number;
		searchTimeMs: number;
		enrichTimeMs?: number;
		indexerCount?: number;
		indexerResults?: Record<string, IndexerResult>;
		rejectedIndexers?: RejectedIndexer[];
	}

	export type SearchMode = 'all' | 'multiSeasonPack';

	interface Props {
		open: boolean;
		title: string;
		tmdbId?: number;
		imdbId?: string | null;
		tvdbId?: number | null;
		expectedEpisodeCount?: number | null;
		year?: number | null;
		mediaType: 'movie' | 'tv';
		scoringProfileId?: string | null;
		season?: number;
		episode?: number;
		searchMode?: SearchMode;
		language?: string;
		onClose: () => void;
		onGrab: (
			release: Release,
			streaming?: boolean,
			acquisitionProtocol?: 'default' | 'torrent' | 'debrid'
		) => Promise<{ success: boolean; error?: string; errorCode?: string }>;
	}

	let {
		open,
		title,
		tmdbId,
		imdbId,
		tvdbId,
		expectedEpisodeCount,
		year,
		mediaType,
		scoringProfileId,
		season,
		episode,
		searchMode = 'all',
		language,
		onClose,
		onGrab
	}: Props = $props();

	let releases = $state<Release[]>([]);
	let meta = $state<SearchMeta | null>(null);
	let searching = $state(false);
	let searchError = $state<string | null>(null);
	let grabbingIds = new SvelteSet<string>();
	let grabbedIds = new SvelteSet<string>();
	let streamingIds = new SvelteSet<string>();
	// Only ever set to 'torrent' or 'debrid' from this component - 'default'
	// stays in the type for compatibility with onGrab/other callers that omit
	// this field, but this modal always resolves and sends a concrete choice.
	let acquisitionProtocol = $state<'default' | 'torrent' | 'debrid'>('torrent');
	let debridAvailable = $state(false);
	let grabErrors = new SvelteMap<string, string>();
	let searchTriggered = $state(false);
	let blockedIds = new SvelteSet<string>();
	let blockModalOpen = $state(false);
	let releaseToBlock = $state<Release | null>(null);
	let blocking = $state(false);

	// Resolve whether a debrid client is usable and, if so, seed the selector
	// with the global default (Settings > Download Clients) rather than an
	// opaque "Default" option the user would have to look up elsewhere.
	$effect(() => {
		if (!open) return;
		void Promise.all([
			fetch('/api/download-clients').then((response) => response.json()),
			fetch('/api/settings/acquisition').then((response) => response.json())
		]).then(
			([clients, acquisitionSettings]: [
				Array<{ implementation: string; enabled: boolean; hasApiToken: boolean }>,
				{ defaultAcquisitionProtocol: 'torrent' | 'debrid' }
			]) => {
				debridAvailable = clients.some(
					(client) =>
						(client.implementation === 'realdebrid' || client.implementation === 'torbox') &&
						client.enabled &&
						client.hasApiToken
				);
				acquisitionProtocol = debridAvailable
					? acquisitionSettings.defaultAcquisitionProtocol
					: 'torrent';
			}
		);
	});

	let usenetStreamingState = $state<
		'unknown' | 'available' | 'noConfiguredServers' | 'noEnabledServers' | 'unavailable'
	>('unknown');

	// Indexer source lookup: maps Cinephage indexer UUID → 'prowlarr' | 'jackett'.
	// Populated lazily on first open by fetching the indexers list and connection URLs.
	const indexerSourceCtx = $state<{ map: Map<string, 'prowlarr' | 'jackett'> }>({ map: new Map() });
	setContext('indexerSources', indexerSourceCtx);
	let indexerSourceLoaded = $state(false);

	$effect(() => {
		if (!open || indexerSourceLoaded) return;
		indexerSourceLoaded = true;
		Promise.all([
			fetch('/api/indexers').then((r) => (r.ok ? r.json() : [])),
			fetch('/api/indexers/prowlarr/connection').then((r) =>
				r.ok ? r.json() : { connection: null }
			),
			fetch('/api/indexers/jackett/connection').then((r) =>
				r.ok ? r.json() : { connection: null }
			)
		])
			.then(([allIndexers, prowlarrData, jackettData]) => {
				const prowlarrBase = prowlarrData.connection?.url?.replace(/\/+$/, '') ?? null;
				const jackettBase = jackettData.connection?.url?.replace(/\/+$/, '') ?? null;
				const map = new SvelteMap<string, 'prowlarr' | 'jackett'>();
				for (const idx of allIndexers as { id: string; baseUrl: string }[]) {
					const url = idx.baseUrl;
					if (prowlarrBase && url.startsWith(prowlarrBase + '/')) {
						const suffix = url.slice(prowlarrBase.length + 1).replace(/\/+$/, '');
						if (/^\d+$/.test(suffix)) {
							map.set(idx.id, 'prowlarr');
							continue;
						}
					}
					if (
						jackettBase &&
						url.startsWith(jackettBase + '/api/v2.0/indexers/') &&
						url.includes('/results/torznab')
					) {
						map.set(idx.id, 'jackett');
					}
				}
				indexerSourceCtx.map = map;
			})
			.catch(() => {});
	});

	let sortBy = $state<'score' | 'seeders' | 'size' | 'age'>('score');
	let sortDir = $state<'asc' | 'desc'>('desc');

	let showRejected = $state(false);
	let filterQuery = $state('');

	let showIndexerDetails = $state(false);
	let showPipelineDetails = $state(false);
	let showDebugPanel = $state(false);
	let selectedDebugRelease = $state<Record<string, unknown> | null>(null);

	function downloadDebugJson() {
		const debugData = {
			timestamp: new Date().toISOString(),
			searchParams: {
				title,
				tmdbId,
				imdbId,
				tvdbId,
				year,
				mediaType,
				season,
				episode,
				scoringProfileId,
				searchMode
			},
			meta,
			allReleases: releases,
			filteredReleases: filteredReleases
		};
		downloadJsonFile(
			debugData,
			`search-debug-${title.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}.json`
		);
	}

	function releaseKey(release: Release): string {
		return `${release.guid}-${release.indexerId}`;
	}

	async function loadUsenetStreamingAvailability() {
		try {
			usenetStreamingState = 'unknown';
			const response = await getUsenetServers();
			const servers = (response as unknown as Array<{ enabled: boolean }>) || [];

			if (servers.length === 0) {
				usenetStreamingState = 'noConfiguredServers';
				return;
			}

			if (!servers.some((server) => server.enabled)) {
				usenetStreamingState = 'noEnabledServers';
				return;
			}

			usenetStreamingState = 'available';
		} catch {
			usenetStreamingState = 'unavailable';
		}
	}

	const showUsenetStreamButton = $derived.by(() => usenetStreamingState !== 'noConfiguredServers');
	const canUsenetStream = $derived.by(() => usenetStreamingState === 'available');
	const usenetStreamUnavailableReason = $derived.by(() => {
		switch (usenetStreamingState) {
			case 'unknown':
				return 'Checking NNTP server availability...';
			case 'noEnabledServers':
				return 'NNTP servers are configured but disabled. Enable one to stream.';
			case 'unavailable':
				return 'Unable to verify NNTP server status right now.';
			default:
				return null;
		}
	});

	const filteredReleases = $derived.by(() => {
		let result = [...releases];

		if (searchMode === 'multiSeasonPack') {
			result = result.filter((r) => isMultiSeasonPack(r, expectedEpisodeCount));
		}

		if (!showRejected) {
			result = result.filter((r) => !r.rejected);
		}

		if (filterQuery) {
			const q = filterQuery.toLowerCase();
			result = result.filter((r) => r.title.toLowerCase().includes(q));
		}

		result.sort((a, b) => {
			let comparison = 0;
			switch (sortBy) {
				case 'score':
					comparison = (a.totalScore ?? 0) - (b.totalScore ?? 0);
					break;
				case 'seeders':
					comparison = (a.seeders ?? 0) - (b.seeders ?? 0);
					break;
				case 'size':
					comparison = a.size - b.size;
					break;
				case 'age':
					comparison = new Date(a.publishDate).getTime() - new Date(b.publishDate).getTime();
					break;
			}
			return sortDir === 'desc' ? -comparison : comparison;
		});

		return result;
	});

	const modeBaseReleases = $derived.by(() => {
		if (searchMode === 'multiSeasonPack') {
			return releases.filter((r) => isMultiSeasonPack(r, expectedEpisodeCount));
		}
		return releases;
	});

	const rawReleaseCount = $derived.by(() => releases.length);

	const modeRejectedCount = $derived.by(() => modeBaseReleases.filter((r) => r.rejected).length);

	const rejectionBreakdown = $derived.by(() => {
		const groups: Record<string, number> = {};
		for (const r of modeBaseReleases) {
			if (r.rejected && r.rejections?.length) {
				const reason = r.rejections[0];
				const key = reason.length > 30 ? reason.substring(0, 30) + '...' : reason;
				groups[key] = (groups[key] || 0) + 1;
			}
		}
		return groups;
	});

	const reportedIndexerResults = $derived.by(() => {
		if (!meta?.indexerResults) {
			return [];
		}

		const modeCountsByIndexer = new SvelteMap<string, number>();
		if (searchMode === 'multiSeasonPack') {
			for (const release of modeBaseReleases) {
				modeCountsByIndexer.set(
					release.indexerId,
					(modeCountsByIndexer.get(release.indexerId) ?? 0) + 1
				);
			}
		}

		return Object.entries(meta.indexerResults).map(([indexerId, result]) => ({
			indexerId,
			...result,
			rawCount: result.count,
			displayCount:
				searchMode === 'multiSeasonPack' ? (modeCountsByIndexer.get(indexerId) ?? 0) : result.count
		}));
	});

	$effect(() => {
		if (open && releases.length === 0 && !searching && !searchTriggered) {
			searchTriggered = true;
			void loadUsenetStreamingAvailability();
			void performSearch();
		}
	});

	$effect(() => {
		if (!open) {
			releases = [];
			meta = null;
			searchError = null;
			showRejected = false;
			grabbingIds.clear();
			grabbedIds.clear();
			streamingIds.clear();
			grabErrors.clear();
			filterQuery = '';
			searchTriggered = false;
			usenetStreamingState = 'unknown';
			blockedIds.clear();
			blockModalOpen = false;
			releaseToBlock = null;
		}
	});

	async function performSearch() {
		searching = true;
		searchError = null;

		try {
			const params: Record<string, string> = {
				searchType: mediaType,
				enrich: 'true',
				filterRejected: 'false'
			};

			if (searchMode) params.searchMode = searchMode;

			if (tmdbId) params.tmdbId = tmdbId.toString();
			if (imdbId) params.imdbId = imdbId;
			if (tvdbId) params.tvdbId = tvdbId.toString();
			if (year) params.year = year.toString();
			if (scoringProfileId) params.scoringProfileId = scoringProfileId;
			if (season !== undefined) params.season = season.toString();
			if (episode !== undefined) params.episode = episode.toString();
			if (language) params.language = language;

			params.q = title;

			const data = await searchReleases(params);

			releases = data.releases || [];
			meta = data.meta;
		} catch (err) {
			searchError = err instanceof Error ? err.message : 'Search failed';
			releases = [];
		} finally {
			searching = false;
		}
	}

	async function handleGrab(release: Release, streaming?: boolean) {
		if (streaming && !canUsenetStream) {
			const reason = usenetStreamUnavailableReason ?? 'NNTP streaming is unavailable';
			grabErrors.set(releaseKey(release), reason);
			return;
		}

		const key = releaseKey(release);
		grabbingIds.add(key);
		if (streaming) {
			streamingIds.add(key);
		}
		grabErrors.delete(key);

		try {
			const result = await onGrab(release, streaming, acquisitionProtocol);
			if (result.success) {
				grabbedIds.add(key);
			} else {
				grabErrors.set(key, getGrabErrorMessage(result.errorCode, result.error));
			}
		} catch (err) {
			grabErrors.set(key, err instanceof Error ? err.message : 'Failed');
		} finally {
			grabbingIds.delete(key);
			streamingIds.delete(key);
		}
	}

	function handleBlockClick(release: Release) {
		releaseToBlock = release;
		blockModalOpen = true;
	}

	async function confirmBlock(expiresInHours: number | null) {
		if (!releaseToBlock) return;
		blocking = true;
		try {
			await addToBlocklist({
				title: releaseToBlock.title,
				infoHash: releaseToBlock.infoHash,
				indexerId: releaseToBlock.indexerId,
				size: releaseToBlock.size,
				protocol: releaseToBlock.protocol,
				reason: 'manual',
				expiresInHours
			});
			blockedIds.add(releaseKey(releaseToBlock));
			toasts.success(m.blocklist_addedToBlocklist());
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : 'Failed to block release');
		} finally {
			blocking = false;
			blockModalOpen = false;
			releaseToBlock = null;
		}
	}

	function cancelBlock() {
		blockModalOpen = false;
		releaseToBlock = null;
	}
</script>

<ModalWrapper
	{open}
	{onClose}
	maxWidth="5xl"
	labelledBy="interactive-search-modal-title"
	flexContent
>
	<div class="shrink-0">
		<SearchHeader {title} {searchMode} {searching} onRefresh={performSearch} {onClose} />
		{#if debridAvailable}
			<div class="mb-2 flex items-center gap-2">
				<label class="text-sm" for="acquisitionProtocol">{m.acquisition_acquireVia()}</label>
				<select
					id="acquisitionProtocol"
					class="select-bordered select select-xs"
					bind:value={acquisitionProtocol}
				>
					<option value="torrent">{m.acquisition_torrentClient()}</option>
					<option value="debrid">{m.acquisition_debrid()}</option>
				</select>
			</div>
		{/if}

		{#if meta}
			<SearchStats
				{meta}
				{searchMode}
				{filteredReleases}
				{modeBaseReleases}
				{modeRejectedCount}
				{rejectionBreakdown}
				{reportedIndexerResults}
				{showIndexerDetails}
				{showPipelineDetails}
				{showDebugPanel}
				{selectedDebugRelease}
				{releases}
				onToggleIndexerDetails={() => (showIndexerDetails = !showIndexerDetails)}
				onTogglePipelineDetails={() => (showPipelineDetails = !showPipelineDetails)}
				onToggleDebugPanel={() => (showDebugPanel = !showDebugPanel)}
				onDownloadDebugJson={downloadDebugJson}
				onSelectDebugRelease={(r: Record<string, unknown> | null) => (selectedDebugRelease = r)}
			/>
		{/if}

		<SearchFilters
			{filterQuery}
			{showRejected}
			{sortBy}
			{sortDir}
			onFilterChange={(v) => (filterQuery = v)}
			onShowRejectedChange={(v) => (showRejected = v)}
			onSortByChange={(v) => (sortBy = v)}
			onSortDirToggle={() => (sortDir = sortDir === 'desc' ? 'asc' : 'desc')}
		/>
	</div>

	<SearchResultsList
		{searching}
		{searchError}
		{filteredReleases}
		{rawReleaseCount}
		{searchMode}
		getReleaseKey={releaseKey}
		{grabbingIds}
		{grabbedIds}
		{streamingIds}
		{grabErrors}
		{showUsenetStreamButton}
		{canUsenetStream}
		{usenetStreamUnavailableReason}
		onGrab={handleGrab}
		onBlock={handleBlockClick}
		{blockedIds}
	/>

	<div class="modal-action mt-0 shrink-0 border-t border-base-300 pt-3">
		<button class="btn" onclick={onClose}>Close</button>
	</div>
</ModalWrapper>

<BlockReleaseModal
	open={blockModalOpen}
	releaseTitle={releaseToBlock?.title ?? ''}
	loading={blocking}
	onConfirm={confirmBlock}
	onCancel={cancelBlock}
/>
