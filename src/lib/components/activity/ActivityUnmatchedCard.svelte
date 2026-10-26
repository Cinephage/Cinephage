<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		Loader2,
		RefreshCw,
		Search,
		Download,
		Link2,
		Unlink,
		ChevronRight,
		Filter,
		ChevronDown,
		ChevronUp,
		X
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import {
		getUnmatched,
		trackUnmatched,
		enrollUnmatched,
		type UnmatchedDownloadItem
	} from '#lib/api/downloads.js';
	import { ApiError } from '#lib/api/client.js';
	import { formatBytes } from '#lib/utils/format.js';
	import { formatRelativeTime } from './activity-display-utils.js';
	import ActiveFilters from './ActiveFilters.svelte';
	import type { ActivityFilters } from '#lib/types/activity.js';

	interface Props {
		downloadClients?: { id: string; name: string }[];
		filters: ActivityFilters;
		onFiltersChange: (filters: ActivityFilters) => void;
	}

	let { downloadClients = [], filters, onFiltersChange }: Props = $props();

	const PAGE_LIMIT = 25;
	// Suggestions at or above this confidence are trusted enough to
	// pre-check for bulk confirm.
	const SUGGESTION_AUTO_SELECT_THRESHOLD = 0.8;

	let items = $state<UnmatchedDownloadItem[]>([]);
	let total = $state(0);
	let page = $state(1);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let clientId = $state('');
	let mediaType = $state<'all' | 'movie' | 'tv'>('all');
	let search = $state('');
	let startDate = $state<string | undefined>(undefined);
	let endDate = $state<string | undefined>(undefined);
	let status = $state<string>('all');
	let protocol = $state<string>('all');
	let resolution = $state<string>('');
	let moreFiltersExpanded = $state(false);

	const statusOptions = [
		{ value: 'all', label: m.common_all() },
		{ value: 'downloading', label: m.status_downloading() },
		{ value: 'queued', label: m.status_queued() },
		{ value: 'paused', label: m.status_paused() },
		{ value: 'stalled', label: m.status_stalled() },
		{ value: 'postprocessing', label: 'Post-processing' },
		{ value: 'seeding', label: m.status_seeding() },
		{ value: 'completed', label: m.status_completed() },
		{ value: 'error', label: m.status_failed() }
	];

	// Debrid is deliberately excluded here: debrid clients never implement
	// IDownloadClient/getDownloads() (see DownloadClientManager.getEnabledClients),
	// so a debrid item can never reach this list - offering it as a filter
	// choice would just be a guaranteed-empty dead end.
	const protocolOptions = [
		{ value: 'all', label: m.common_all() },
		{ value: 'torrent', label: m.activity_filters_torrent() },
		{ value: 'usenet', label: m.activity_filters_usenet() }
	];

	// Same set ActivityFilters.svelte offers.
	const resolutionOptions = ['4K', '2160p', '1080p', '720p', '480p', 'SD'];

	let selected = new SvelteSet<string>();
	let searchDebounce: ReturnType<typeof setTimeout> | undefined;
	// Single-expand, matching Reports/ActivityRow's convention: opening one
	// row closes whatever was open.
	let expandedHash = $state<string | null>(null);

	function toggleExpand(hash: string): void {
		expandedHash = expandedHash === hash ? null : hash;
	}

	// Mirrors ActivityRow's protocolLabels - a torrent's identifier is a real
	// infohash, a usenet one is just SABnzbd/NZBGet's internal job id, and
	// calling either one "infohash" is actively wrong for the other protocol.
	const protocolLabels: Record<string, string> = {
		torrent: 'torrent',
		usenet: 'usenet',
		debrid: 'debrid'
	};

	function idLabel(protocol: string): string {
		return protocol === 'torrent'
			? m.activity_unmatched_infoHashLabel()
			: m.activity_unmatched_downloadIdLabel();
	}

	function qualityBadges(item: UnmatchedDownloadItem): string[] {
		if (!item.quality) return [];
		return [
			item.quality.resolution,
			item.quality.source,
			item.quality.codec,
			item.quality.hdr
		].filter((v): v is string => Boolean(v) && v !== 'unknown');
	}

	function updateStartDate(value: string) {
		startDate = value || undefined;
		onFiltersChange({ ...filters, startDate });
		load(true);
	}

	function updateEndDate(value: string) {
		endDate = value || undefined;
		onFiltersChange({ ...filters, endDate });
		load(true);
	}

	function clearDateRange() {
		startDate = undefined;
		endDate = undefined;
		onFiltersChange({ ...filters, startDate: undefined, endDate: undefined });
		load(true);
	}

	let lastExternalClientId = $state('');
	let lastExternalMediaType = $state<'all' | 'movie' | 'tv'>('all');
	let lastExternalSearch = $state('');
	let lastExternalStartDate = $state<string | undefined>(undefined);
	let lastExternalEndDate = $state<string | undefined>(undefined);
	let lastExternalStatus = $state('all');
	let lastExternalProtocol = $state('all');
	let lastExternalResolution = $state('');

	$effect(() => {
		const incoming = filters.unmatchedStatus ?? 'all';
		if (incoming !== lastExternalStatus) {
			lastExternalStatus = incoming;
			status = incoming;
		}
	});
	$effect(() => {
		const incoming = filters.protocol ?? 'all';
		if (incoming !== lastExternalProtocol) {
			lastExternalProtocol = incoming;
			protocol = incoming;
		}
	});
	$effect(() => {
		const incoming = filters.resolution ?? '';
		if (incoming !== lastExternalResolution) {
			lastExternalResolution = incoming;
			resolution = incoming;
		}
	});

	$effect(() => {
		const incoming = filters.downloadClientId ?? '';
		if (incoming !== lastExternalClientId) {
			lastExternalClientId = incoming;
			clientId = incoming;
		}
	});
	$effect(() => {
		const incoming = filters.mediaType ?? 'all';
		if (incoming !== lastExternalMediaType) {
			lastExternalMediaType = incoming;
			mediaType = incoming;
		}
	});
	$effect(() => {
		const incoming = filters.search ?? '';
		if (incoming !== lastExternalSearch) {
			lastExternalSearch = incoming;
			search = incoming;
		}
	});
	$effect(() => {
		const incoming = filters.startDate;
		if (incoming !== lastExternalStartDate) {
			lastExternalStartDate = incoming;
			startDate = incoming;
		}
	});
	$effect(() => {
		const incoming = filters.endDate;
		if (incoming !== lastExternalEndDate) {
			lastExternalEndDate = incoming;
			endDate = incoming;
		}
	});

	const selectableHashes = $derived(items.map((item) => item.hash));
	const allSelected = $derived(
		selectableHashes.length > 0 && selectableHashes.every((h) => selected.has(h))
	);
	const totalPages = $derived(Math.max(1, Math.ceil(total / PAGE_LIMIT)));

	function statusBadge(status: string): string {
		switch (status) {
			case 'downloading':
				return 'badge-info';
			case 'seeding':
			case 'completed':
				return 'badge-success';
			case 'paused':
			case 'stalled':
				return 'badge-warning';
			case 'error':
				return 'badge-error';
			default:
				return 'badge-ghost';
		}
	}

	function statusProgress(status: string): string {
		switch (status) {
			case 'downloading':
				return 'progress-info';
			case 'seeding':
			case 'completed':
				return 'progress-success';
			case 'paused':
			case 'stalled':
				return 'progress-warning';
			case 'error':
				return 'progress-error';
			default:
				return '';
		}
	}

	function statusLabel(status: string): string {
		switch (status) {
			case 'downloading':
				return m.status_downloading();
			case 'seeding':
				return m.status_seeding();
			case 'paused':
				return m.status_paused();
			case 'completed':
				return m.status_completed();
			case 'stalled':
				return m.status_stalled();
			case 'queued':
				return m.status_queued();
			case 'error':
				return m.status_failed();
			default:
				return status;
		}
	}

	async function load(resetPage = false) {
		if (resetPage) page = 1;
		loading = true;
		loadError = null;
		try {
			const res = await getUnmatched({
				clientId: clientId || undefined,
				page,
				limit: PAGE_LIMIT,
				search: search.trim() || undefined,
				mediaType: mediaType === 'all' ? undefined : mediaType,
				status: status === 'all' ? undefined : status,
				protocol: protocol === 'all' ? undefined : (protocol as 'torrent' | 'usenet' | 'debrid'),
				resolution: resolution || undefined,
				startDate,
				endDate
			});
			items = res.items;
			total = res.total;
			page = res.page;
			// Drop selections for rows that are gone — imported rows leave
			// the pane by definition (they become tracked queue rows).
			const live = new Set(items.map((item) => item.hash));
			for (const hash of [...selected]) {
				if (!live.has(hash)) selected.delete(hash);
			}
			// Pre-check high-confidence suggestions so a bulk confirm is one
			// click away - the user can always uncheck ones they don't want.
			for (const item of items) {
				if (
					!item.attachable &&
					item.suggestion &&
					item.suggestion.confidence >= SUGGESTION_AUTO_SELECT_THRESHOLD
				) {
					selected.add(item.hash);
				}
			}
		} catch (error) {
			loadError =
				error instanceof ApiError
					? error.message
					: error instanceof Error
						? error.message
						: m.activity_unmatched_loadFailed();
		} finally {
			loading = false;
		}
	}

	// The manual Refresh button toasts (matching the Active tab's own
	// handleRefreshQueue); filter-triggered load(true) calls stay silent -
	// loadError already surfaces those, a toast on every filter click would
	// be noise.
	async function handleRefresh(): Promise<void> {
		await load(true);
		if (loadError) toasts.error(m.toast_activity_failedToRefresh());
		else toasts.success(m.toast_activity_refreshed());
	}

	function onSearchInput(value: string) {
		search = value;
		clearTimeout(searchDebounce);
		searchDebounce = setTimeout(() => {
			onFiltersChange({ ...filters, search: value || undefined });
			void load(true);
		}, 300);
	}

	function toggleSelect(hash: string) {
		if (selected.has(hash)) selected.delete(hash);
		else selected.add(hash);
	}

	function toggleSelectAll() {
		if (allSelected) {
			for (const hash of selectableHashes) selected.delete(hash);
		} else {
			for (const hash of selectableHashes) selected.add(hash);
		}
	}

	function openWizardFor(item: UnmatchedDownloadItem) {
		openWizardEntries([{ clientId: item.clientId, hash: item.hash }]);
	}

	function openWizardSelected() {
		openWizardEntries(
			selectedImportable.map((item) => ({ clientId: item.clientId, hash: item.hash }))
		);
	}

	function openWizardEntries(entries: { clientId: string; hash: string }[]) {
		if (entries.length === 0) return;
		const value = encodeURIComponent(entries.map((e) => `${e.clientId}:${e.hash}`).join(','));
		void goto(`/library/import?unmatched=${value}`);
	}

	// Import needs real bytes on disk to review - there's nothing to show the
	// wizard for a download that hasn't finished yet.
	const selectedImportable = $derived(
		items.filter((item) => selected.has(item.hash) && item.progress >= 1)
	);

	const selectedAttachable = $derived(
		items.filter((item) => selected.has(item.hash) && item.attachable && item.progress >= 1)
	);

	// Suggestion-confirmable: a probabilistic TMDB match, not an exact
	// infohash hit - those go through attachItems/track instead, since
	// "track" means the library already has this exact file.
	const selectedSuggestable = $derived(
		items.filter((item) => selected.has(item.hash) && !item.attachable && item.suggestion)
	);

	let attaching = $state(false);
	let confirming = $state(false);

	async function attachItems(itemsToAttach: UnmatchedDownloadItem[]) {
		const pairs = itemsToAttach
			.filter((item) => item.attachable)
			.map((item) => ({
				hash: item.hash,
				mediaType: (item.attachable as NonNullable<UnmatchedDownloadItem['attachable']>).mediaType,
				tmdbId: (item.attachable as NonNullable<UnmatchedDownloadItem['attachable']>).tmdbId
			}));
		if (pairs.length === 0 || attaching) return;
		attaching = true;
		try {
			const result = await trackUnmatched(pairs);
			toasts.success(m.activity_unmatched_attachedToast({ count: result.tracked }));
			for (const item of itemsToAttach) selected.delete(item.hash);
			await load(true);
		} catch (error) {
			toasts.error(
				error instanceof ApiError
					? error.message
					: error instanceof Error
						? error.message
						: m.activity_unmatched_attachFailed()
			);
		} finally {
			attaching = false;
		}
	}

	/**
	 * Accept a TMDB suggestion directly, skipping the wizard - enrolls the
	 * download against the suggested title so the monitor's import pipeline
	 * picks it up, regardless of whether the download has finished yet
	 * (mirrors its live client status onto the queue row either way). No
	 * rootFolderId is sent for a new-to-library title - the backend resolves
	 * one itself (library default, then the Unmatched tab's own default
	 * settings) and only skips if neither is configured.
	 */
	async function confirmSuggestions(itemsToConfirm: UnmatchedDownloadItem[]) {
		const pairs = itemsToConfirm
			.filter((item) => item.suggestion)
			.map((item) => ({
				hash: item.hash,
				mediaType: (item.suggestion as NonNullable<UnmatchedDownloadItem['suggestion']>).mediaType,
				tmdbId: (item.suggestion as NonNullable<UnmatchedDownloadItem['suggestion']>).tmdbId
			}));
		if (pairs.length === 0 || confirming) return;
		confirming = true;
		try {
			const result = await enrollUnmatched(pairs);
			if (result.enrolled > 0) {
				toasts.success(m.activity_unmatched_enrolledToast());
			}
			if (result.skipped.length > 0) {
				const reasons = [...new Set(result.skipped.map((s) => s.reason))];
				const hint = reasons.includes('no_default_root_folder')
					? ' - set a default root folder for this media type in Settings > Libraries, or use Import'
					: ' - use Import instead';
				toasts.warning(`${result.skipped.length} skipped: ${reasons.join(', ')}${hint}`);
			}
			for (const item of itemsToConfirm) selected.delete(item.hash);
			await load(true);
		} catch (error) {
			toasts.error(
				error instanceof ApiError
					? error.message
					: error instanceof Error
						? error.message
						: m.activity_unmatched_confirmFailed()
			);
		} finally {
			confirming = false;
		}
	}

	// Mirrors +page.svelte's removeFilter/clearAllFilters for the shared
	// ActiveFilters component - same reset-to-'all'-vs-delete convention.
	function removeUnmatchedFilter(key: keyof ActivityFilters) {
		const newFilters = { ...filters };
		if (key === 'mediaType' || key === 'protocol' || key === 'unmatchedStatus') {
			newFilters[key] = 'all' as never;
		} else {
			delete newFilters[key];
		}
		switch (key) {
			case 'mediaType':
				mediaType = 'all';
				break;
			case 'protocol':
				protocol = 'all';
				break;
			case 'unmatchedStatus':
				status = 'all';
				break;
			case 'resolution':
				resolution = '';
				break;
			case 'search':
				search = '';
				break;
			case 'downloadClientId':
				clientId = '';
				break;
			case 'startDate':
				startDate = undefined;
				break;
			case 'endDate':
				endDate = undefined;
				break;
		}
		onFiltersChange(newFilters);
		load(true);
	}

	function clearAllUnmatchedFilters() {
		clientId = '';
		mediaType = 'all';
		search = '';
		status = 'all';
		protocol = 'all';
		resolution = '';
		startDate = undefined;
		endDate = undefined;
		onFiltersChange({ mediaType: 'all', protocol: 'all', unmatchedStatus: 'all' });
		load(true);
	}

	onMount(() => {
		clientId = filters.downloadClientId ?? '';
		mediaType = filters.mediaType ?? 'all';
		search = filters.search ?? '';
		startDate = filters.startDate;
		endDate = filters.endDate;
		status = filters.unmatchedStatus ?? 'all';
		protocol = filters.protocol ?? 'all';
		resolution = filters.resolution ?? '';
		lastExternalClientId = clientId;
		lastExternalMediaType = mediaType;
		lastExternalSearch = search;
		lastExternalStartDate = startDate;
		lastExternalEndDate = endDate;
		lastExternalStatus = status;
		lastExternalProtocol = protocol;
		lastExternalResolution = resolution;
		void load(true);
	});
</script>

<div class="space-y-4">
	<div class="rounded-lg border border-base-content/12 bg-base-100 p-4 shadow-sm">
		<div class="flex flex-wrap items-center gap-2">
			<div class="form-control min-w-50 flex-1 sm:max-w-64">
				<div class="group relative">
					<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
						<Search
							class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
						/>
					</div>
					<input
						type="text"
						placeholder={m.activity_unmatched_searchPlaceholder()}
						class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
						value={search}
						oninput={(e) => onSearchInput(e.currentTarget.value)}
					/>
				</div>
			</div>
			<span class="h-4 w-px bg-base-content/15"></span>
			<div class="join">
				<button
					class="btn join-item btn-sm {mediaType === 'all' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => {
						mediaType = 'all';
						onFiltersChange({ ...filters, mediaType: 'all' });
						load(true);
					}}
				>
					{m.common_all()}
				</button>
				<button
					class="btn join-item btn-sm {mediaType === 'movie' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => {
						mediaType = 'movie';
						onFiltersChange({ ...filters, mediaType: 'movie' });
						load(true);
					}}
				>
					{m.common_movies()}
				</button>
				<button
					class="btn join-item btn-sm {mediaType === 'tv' ? 'btn-primary' : 'btn-ghost'}"
					onclick={() => {
						mediaType = 'tv';
						onFiltersChange({ ...filters, mediaType: 'tv' });
						load(true);
					}}
				>
					{m.common_tvShows()}
				</button>
			</div>
			{#if downloadClients.length > 0}
				<span class="h-4 w-px bg-base-content/15"></span>
				<select
					class="select w-38 border-base-content/20 bg-base-200 select-sm sm:w-auto"
					bind:value={clientId}
					onchange={() => {
						onFiltersChange({ ...filters, downloadClientId: clientId || undefined });
						load(true);
					}}
					aria-label={m.activity_unmatched_clientFilter()}
				>
					<option value="">{m.activity_unmatched_allClients()}</option>
					{#each downloadClients as client (client.id)}
						<option value={client.id}>{client.name}</option>
					{/each}
				</select>
			{/if}
			<button
				class="btn ml-auto gap-1.5 btn-ghost btn-sm"
				onclick={() => (moreFiltersExpanded = !moreFiltersExpanded)}
				aria-label={moreFiltersExpanded ? 'Collapse filters' : 'Expand filters'}
			>
				<Filter class="h-4 w-4 text-base-content/50" />
				{#if moreFiltersExpanded}
					<span>{m.activity_filters_lessFilters()}</span>
					<ChevronUp class="h-4 w-4" />
				{:else}
					<span>{m.activity_filters_moreFilters()}</span>
					<ChevronDown class="h-4 w-4" />
				{/if}
			</button>
		</div>

		{#if moreFiltersExpanded}
			<div
				class="mt-3 grid gap-4 border-t border-base-content/10 pt-4 md:grid-cols-2 lg:grid-cols-3"
			>
				<div class="space-y-2">
					<label class="text-sm font-medium" for="unmatched-status-filter"
						>{m.common_status()}</label
					>
					<select
						id="unmatched-status-filter"
						class="select-bordered select w-full select-sm"
						bind:value={status}
						onchange={() => {
							onFiltersChange({
								...filters,
								unmatchedStatus: status === 'all' ? undefined : status
							});
							load(true);
						}}
					>
						{#each statusOptions as option (option.value)}
							<option value={option.value}>{option.label}</option>
						{/each}
					</select>
				</div>
				<div class="space-y-2">
					<label class="text-sm font-medium" for="unmatched-protocol-filter"
						>{m.activity_detail_protocol()}</label
					>
					<select
						id="unmatched-protocol-filter"
						class="select-bordered select w-full select-sm"
						bind:value={protocol}
						onchange={() => {
							onFiltersChange({
								...filters,
								protocol: protocol === 'all' ? undefined : (protocol as ActivityFilters['protocol'])
							});
							load(true);
						}}
					>
						{#each protocolOptions as option (option.value)}
							<option value={option.value}>{option.label}</option>
						{/each}
					</select>
				</div>
				<div class="space-y-2">
					<label class="text-sm font-medium" for="unmatched-resolution-filter"
						>{m.activity_filters_resolution()}</label
					>
					<select
						id="unmatched-resolution-filter"
						class="select-bordered select w-full select-sm"
						bind:value={resolution}
						onchange={() => {
							onFiltersChange({ ...filters, resolution: resolution || undefined });
							load(true);
						}}
					>
						<option value="">{m.activity_filters_allResolutions()}</option>
						{#each resolutionOptions as res (res)}
							<option value={res}>{res}</option>
						{/each}
					</select>
				</div>
				<div class="space-y-2 md:col-span-2">
					<label class="text-sm font-medium" for="unmatched-start-date"
						>{m.activity_filters_dateRange()}</label
					>
					<div class="flex flex-wrap items-center gap-2">
						<input
							id="unmatched-start-date"
							type="date"
							class="input-bordered input input-sm"
							value={startDate || ''}
							onchange={(e) => updateStartDate(e.currentTarget.value)}
						/>
						<span class="text-base-content/50">{m.activity_activeFilters_toSeparator()}</span>
						<input
							type="date"
							class="input-bordered input input-sm"
							value={endDate || ''}
							onchange={(e) => updateEndDate(e.currentTarget.value)}
							aria-label={m.activity_filters_dateRange()}
						/>
						{#if startDate || endDate}
							<button class="btn btn-ghost btn-error btn-sm" onclick={clearDateRange}>
								<X class="h-4 w-4" />
							</button>
						{/if}
					</div>
				</div>
			</div>
		{/if}

		<div class="mt-3 border-t border-base-content/10 pt-3">
			<ActiveFilters
				{filters}
				{downloadClients}
				onFilterRemove={removeUnmatchedFilter}
				onClearAll={clearAllUnmatchedFilters}
			/>
			<div class="mt-3 flex flex-wrap items-center gap-2">
				<span class="text-sm font-bold tracking-wide text-base-content/70"
					>{m.activity_queue_bulkActionsHeading()}</span
				>
				<div class="divider m-0 divider-horizontal h-6"></div>

				{#if selected.size > 0}
					<span class="text-xs text-base-content/60">
						{m.common_selected({ count: selected.size })}
					</span>
					{#if selectedAttachable.length > 0}
						<button
							class="btn gap-1.5 btn-outline btn-sm"
							disabled={attaching}
							onclick={() => attachItems(selectedAttachable)}
						>
							<Link2 class="h-3.5 w-3.5" />
							{m.activity_unmatched_attachSelected({ count: selectedAttachable.length })}
						</button>
					{/if}
					{#if selectedSuggestable.length > 0}
						<button
							class="btn gap-1.5 btn-outline btn-sm"
							disabled={confirming}
							onclick={() => confirmSuggestions(selectedSuggestable)}
							title="Accept each selected download's suggested match now - skips the import wizard, works even while still downloading."
						>
							<Link2 class="h-3.5 w-3.5" />
							{m.activity_unmatched_confirmSuggested({ count: selectedSuggestable.length })}
						</button>
					{/if}
					{#if selectedImportable.length > 0}
						<button
							class="btn gap-1.5 btn-primary btn-sm"
							onclick={openWizardSelected}
							title="Open the import wizard for each selected download to review or change its match"
						>
							<Download class="h-3.5 w-3.5" />
							{m.activity_unmatched_importSelected({ count: selectedImportable.length })}
						</button>
					{/if}
					<div class="ml-auto"></div>
					<button class="btn gap-1.5 btn-outline btn-sm" onclick={() => selected.clear()}>
						<X class="h-3.5 w-3.5" />
						{m.activity_queue_clearSelection()}
					</button>
				{:else}
					<span class="text-xs text-base-content/60">
						{m.activity_unmatched_bulkHint()}
					</span>
					<div class="ml-auto"></div>
					<button class="btn gap-1.5 btn-outline btn-sm" onclick={handleRefresh} disabled={loading}>
						{#if loading}
							<Loader2 class="h-3.5 w-3.5 animate-spin" />
						{:else}
							<RefreshCw class="h-3.5 w-3.5" />
						{/if}
						{m.activity_unmatched_refresh()}
					</button>
				{/if}
			</div>
		</div>
	</div>

	{#if loadError}
		<div class="alert alert-error">
			<span>{loadError}</span>
		</div>
	{:else if loading && items.length === 0}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="h-8 w-8 animate-spin" />
		</div>
	{:else if items.length === 0}
		<div class="py-12 text-center text-base-content/60">
			<Unlink class="mx-auto mb-4 h-12 w-12 opacity-40" />
			<p class="text-lg font-medium">
				{search ? m.activity_unmatched_noFilterResults() : m.activity_unmatched_empty()}
			</p>
		</div>
	{:else}
		<div class="text-sm text-base-content/70">
			<span>{m.activity_unmatched_count({ count: total })}</span>
		</div>

		<div class="overflow-x-auto rounded-lg border border-base-content/12 bg-base-100 shadow-sm">
			<table class="table w-full table-sm">
				<thead>
					<tr
						class="border-b border-base-content/10 bg-base-200 text-[11px] font-semibold tracking-widest text-base-content/50 uppercase"
					>
						<th class="w-10 px-2">
							<input
								type="checkbox"
								class="checkbox checkbox-xs checkbox-primary"
								checked={allSelected}
								onchange={toggleSelectAll}
								aria-label={m.activity_unmatched_selectAll()}
							/>
						</th>
						<th class="w-8 px-1"><span class="sr-only">Expand</span></th>
						<th>{m.activity_unmatched_colName()}</th>
						<th class="hidden lg:table-cell">{m.activity_table_quality()}</th>
						<th class="hidden lg:table-cell">{m.activity_table_group()}</th>
						<th class="hidden lg:table-cell">{m.activity_unmatched_colSize()}</th>
						<th class="hidden lg:table-cell">{m.activity_unmatched_colClient()}</th>
						<th><span class="sr-only">{m.activity_unmatched_openImport()}</span></th>
					</tr>
				</thead>
				<tbody class="divide-y divide-base-content/8">
					{#each items as item (item.hash)}
						<tr
							class="cursor-pointer transition-colors {selected.has(item.hash)
								? 'bg-primary/5'
								: expandedHash === item.hash
									? 'bg-base-200/60'
									: 'hover:bg-base-200/50'}"
							onclick={() => toggleExpand(item.hash)}
						>
							<td class="w-10 px-2" onclick={(e) => e.stopPropagation()}>
								<input
									type="checkbox"
									class="checkbox checkbox-xs checkbox-primary"
									checked={selected.has(item.hash)}
									onchange={() => toggleSelect(item.hash)}
									aria-label={item.name}
								/>
							</td>
							<td class="px-1">
								<ChevronRight
									class="h-3.5 w-3.5 shrink-0 text-base-content/30 transition-transform {expandedHash ===
									item.hash
										? 'rotate-90'
										: ''}"
								/>
							</td>
							<td>
								<div class="max-w-xs truncate font-medium" title={item.name}>{item.name}</div>
								<div class="mt-1 flex flex-wrap items-center gap-2">
									<span class="badge badge-sm {statusBadge(item.status)}"
										>{statusLabel(item.status)}</span
									>
									<progress
										class="progress w-16 {statusProgress(item.status)}"
										value={item.progress * 100}
										max="100"
									></progress>
									<span class="text-xs text-base-content/60"
										>{Math.round(item.progress * 100)}%</span
									>
									{#if item.date}
										<span class="text-xs text-base-content/50" title={item.date}
											>{formatRelativeTime(item.date)}</span
										>
									{/if}
									{#if !item.attachable && item.suggestion}
										<span
											class="badge gap-1 badge-outline badge-sm"
											title={m.activity_unmatched_suggestionBadgeTitle({
												confidence: Math.round(item.suggestion.confidence * 100)
											})}
										>
											{item.suggestion.title}
											{#if item.suggestion.year}({item.suggestion.year}){/if}
											· {Math.round(item.suggestion.confidence * 100)}%
										</span>
									{/if}
								</div>
							</td>
							<td class="hidden lg:table-cell">
								{#if qualityBadges(item).length > 0}
									<div class="flex flex-wrap gap-1">
										{#each qualityBadges(item) as badge (badge)}
											<span class="badge badge-outline badge-xs">{badge}</span>
										{/each}
									</div>
								{:else}
									<span class="text-base-content/40">-</span>
								{/if}
							</td>
							<td class="hidden text-sm lg:table-cell">{item.releaseGroup || '-'}</td>
							<td class="hidden text-sm whitespace-nowrap lg:table-cell">
								{formatBytes(item.size)}
							</td>
							<td class="hidden text-sm whitespace-nowrap lg:table-cell">
								{item.clientName}
								<span class="text-base-content/40">({protocolLabels[item.protocol]})</span>
							</td>
							<td onclick={(e) => e.stopPropagation()}>
								<div class="flex items-center gap-1">
									{#if item.attachable && item.progress >= 1}
										<button
											class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
											onclick={() => attachItems([item])}
											disabled={attaching}
											aria-label={m.activity_unmatched_attach()}
											title={m.activity_unmatched_attachTitle({
												title: item.attachable.title
											})}
										>
											<Link2 class="h-3 w-3" />
											{m.activity_unmatched_attach()}
										</button>
									{:else if item.suggestion}
										<button
											class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
											onclick={() => confirmSuggestions([item])}
											disabled={confirming}
											aria-label={m.activity_unmatched_confirm()}
											title={m.activity_unmatched_confirmTitle({ title: item.suggestion.title })}
										>
											<Link2 class="h-3 w-3" />
											{m.activity_unmatched_confirm()}
										</button>
									{/if}
									{#if item.progress >= 1}
										<button
											class="btn gap-1.5 border border-base-content/15 bg-base-100 btn-xs hover:bg-base-200"
											onclick={() => openWizardFor(item)}
											aria-label={m.activity_unmatched_openImport()}
											title={m.activity_unmatched_openImportTitle()}
										>
											<Download class="h-3 w-3" />
											{m.activity_unmatched_openImport()}
										</button>
									{/if}
								</div>
							</td>
						</tr>
						{#if expandedHash === item.hash}
							<tr>
								<td colspan={8} class="border-b border-base-content/10 p-0">
									<div class="border-l-4 border-l-primary bg-base-200 py-3 pr-6 pl-10">
										<div class="flex flex-wrap items-center gap-x-6 gap-y-2">
											<div class="flex flex-wrap items-center gap-1.5 text-sm">
												<span
													class="mr-1 text-[10px] font-bold tracking-widest text-base-content/50 uppercase"
													>{idLabel(item.protocol)}</span
												>
												<span class="rounded bg-base-100 px-2 py-1 font-mono text-xs"
													>{item.hash}</span
												>
											</div>
											{#if item.category}
												<div class="text-sm">
													<span
														class="mr-1 text-[10px] font-bold tracking-widest text-base-content/50 uppercase"
														>{m.activity_unmatched_detailCategory()}</span
													>
													<span class="rounded bg-base-100 px-2 py-1">{item.category}</span>
												</div>
											{/if}
											{#if item.date}
												<div class="text-sm">
													<span
														class="mr-1 text-[10px] font-bold tracking-widest text-base-content/50 uppercase"
														>{m.common_added()}</span
													>
													<span class="rounded bg-base-100 px-2 py-1" title={item.date}
														>{formatRelativeTime(item.date)}</span
													>
												</div>
											{/if}
										</div>

										<div
											class="mt-2 rounded-lg border border-base-content/12 bg-base-100 px-3 py-2 font-mono text-sm break-all"
										>
											<span class="mr-2 font-semibold text-base-content/50"
												>{m.activity_unmatched_detailRelease()}</span
											>
											<span class="text-base-content/80">{item.name}</span>
										</div>

										<!-- Narrow viewports hide Quality/Group/Size/Client (see the
										     header above); surface them here instead of losing them. -->
										<div
											class="mt-2 overflow-hidden rounded-lg border border-base-content/12 bg-base-100 shadow-sm lg:hidden"
										>
											{#if qualityBadges(item).length > 0}
												<div
													class="flex items-center justify-between border-b border-base-content/8 px-3 py-2 text-sm"
												>
													<span class="font-medium text-base-content/55"
														>{m.activity_table_quality()}</span
													>
													<div class="flex flex-wrap justify-end gap-1">
														{#each qualityBadges(item) as badge (badge)}
															<span class="badge badge-outline badge-xs">{badge}</span>
														{/each}
													</div>
												</div>
											{/if}
											<div
												class="flex items-center justify-between border-b border-base-content/8 px-3 py-2 text-sm"
											>
												<span class="font-medium text-base-content/55"
													>{m.activity_table_group()}</span
												>
												<span class="text-base-content/70">{item.releaseGroup || '-'}</span>
											</div>
											<div
												class="flex items-center justify-between border-b border-base-content/8 px-3 py-2 text-sm"
											>
												<span class="font-medium text-base-content/55">{m.common_size()}</span>
												<span class="font-semibold">{formatBytes(item.size)}</span>
											</div>
											<div class="flex items-center justify-between px-3 py-2 text-sm">
												<span class="font-medium text-base-content/55"
													>{m.activity_unmatched_colClient()}</span
												>
												<span class="text-base-content/70"
													>{item.clientName}
													<span class="text-base-content/40">({protocolLabels[item.protocol]})</span
													></span
												>
											</div>
										</div>

										{#if item.savePath}
											<div
												class="mt-2 rounded-lg border border-base-content/12 bg-base-100 px-3 py-2 font-mono text-sm break-all"
											>
												<span class="mr-2 font-semibold text-base-content/50"
													>{m.activity_unmatched_detailSavePath()}</span
												>
												<span class="text-base-content/80">{item.savePath}</span>
											</div>
										{/if}

										{#if item.attachable}
											<div
												class="mt-2 rounded-lg border border-base-content/12 bg-base-100 px-3 py-2 text-sm"
											>
												<span class="mr-2 font-semibold text-base-content/50"
													>{m.activity_unmatched_detailLibraryMatch()}</span
												>
												<span class="text-base-content/80"
													>{item.attachable.title} · {item.attachable.mediaType === 'movie'
														? m.common_movies()
														: m.common_tvShows()} · tmdb:{item.attachable.tmdbId}</span
												>
											</div>
										{:else if item.suggestion}
											<div
												class="mt-2 rounded-lg border border-base-content/12 bg-base-100 px-3 py-2 text-sm"
											>
												<span class="mr-2 font-semibold text-base-content/50"
													>{m.activity_unmatched_detailSuggestedMatch()}</span
												>
												<span class="text-base-content/80"
													>{item.suggestion.title}
													{#if item.suggestion.year}({item.suggestion.year}){/if} · {item.suggestion
														.mediaType === 'movie'
														? m.common_movies()
														: m.common_tvShows()} · {Math.round(item.suggestion.confidence * 100)}%
													· tmdb:{item.suggestion.tmdbId}</span
												>
											</div>
										{/if}
									</div>
								</td>
							</tr>
						{/if}
					{/each}
				</tbody>
				{#if totalPages > 1}
					<tfoot>
						<tr>
							<td colspan={8} class="border-t border-base-content/8 py-2">
								<div class="flex items-center justify-center gap-2">
									<button
										class="btn btn-ghost btn-xs"
										disabled={page <= 1 || loading}
										onclick={() => {
											page -= 1;
											void load();
										}}
									>
										{m.reports_pagination_prev()}
									</button>
									<span class="text-xs text-base-content/60">{page} / {totalPages}</span>
									<button
										class="btn btn-ghost btn-xs"
										disabled={page >= totalPages || loading}
										onclick={() => {
											page += 1;
											void load();
										}}
									>
										{m.reports_pagination_next()}
									</button>
								</div>
							</td>
						</tr>
					</tfoot>
				{/if}
			</table>
		</div>
	{/if}
</div>
