<script lang="ts">
	import { AlertTriangle, X, File, Folder, Film, Monitor, Tv, Info, Search } from '@lucide/svelte';
	import { ModalWrapper } from '#lib/components/ui/modal/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import {
		severityBadgeClass,
		insightTypeLabel,
		dismissInsight,
		formatBytes,
		badgeToneColor,
		getInsightFooterLink
	} from './utils.js';
	import { getInsightItems } from '#lib/api/storage.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import { refreshAll } from '$app/navigation';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { batchMovies, batchSeries, deleteMovie, deleteSeries } from '#lib/api/library.js';
	import { syncMediaServerStats } from '#lib/api/settings.js';
	import { apiDelete } from '#lib/api/client.js';
	import { createSearchProgress } from '#lib/stores/searchProgress.svelte.js';
	import { getPrimaryAutoSearchIssue } from '#lib/utils/autoSearchIssues.js';
	import { MediaSearchModal } from '#lib/components/search/index.js';
	import type { InsightItem as ApiInsightItem } from '#lib/api/storage.js';
	import type { Insight } from './utils.js';

	interface Props {
		open: boolean;
		insight: Insight | null;
		onClose: () => void;
		onDismissed?: (id: string) => void;
	}

	let { open, insight, onClose, onDismissed }: Props = $props();

	let items = $state<ApiInsightItem[]>([]);
	let total = $state(0);
	let totalPages = $state(0);
	let page = $state(1);
	let limit = $state(50);
	let loading = $state(false);
	let error = $state<string | null>(null);

	let dismissing = $state(false);

	// The passed-in insight's summary/itemCount are a snapshot from whenever
	// the dashboard list was last fetched, which can drift from the live
	// resolver total shown below (reconcile/sync ran since). The items
	// endpoint re-syncs the stored insight when it detects that drift and
	// hands back the corrected copy - prefer it over the prop once we have it.
	let displaySummary = $state<string | null>(null);

	let expandedItemId = $state<string | null>(null);
	let expandedGroupKey = $state<string | null>(null);
	let actionLoading = $state(new Set<string>());
	let syncingServer = $state(false);
	const searchProgress = createSearchProgress();
	let searchModalOpen = $state(false);
	let searchModalItem = $state<ApiInsightItem | null>(null);

	$effect(() => {
		if (open && insight) {
			displaySummary = insight.summary;
		}
	});

	async function fetchItems() {
		if (!insight) return;
		loading = true;
		error = null;
		try {
			const res = await getInsightItems(insight.id, { page, limit });
			if (res.success && res.data) {
				items = res.data.items;
				total = res.data.pagination.total;
				totalPages = res.data.pagination.totalPages;
				if (res.meta?.insight) {
					displaySummary = res.meta.insight.summary;
				}
			} else {
				error = res.error ?? 'Failed to load items';
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load items';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (open && insight) {
			page = 1;
			expandedItemId = null;
			expandedGroupKey = null;
			fetchItems();
		}
	});

	async function handlePageChange(newPage: number) {
		page = newPage;
		expandedItemId = null;
		expandedGroupKey = null;
		await fetchItems();
	}

	async function handleDismiss() {
		if (!insight || !onDismissed) return;
		dismissing = true;
		const success = await dismissInsight(insight.id);
		dismissing = false;
		if (success) {
			onDismissed(insight.id);
			onClose();
		}
	}

	let pageButtons = $derived.by(() => {
		const buttons: (number | '...')[] = [];
		if (totalPages <= 7) {
			for (let i = 1; i <= totalPages; i++) buttons.push(i);
		} else {
			buttons.push(1);
			if (page > 3) buttons.push('...');
			const start = Math.max(2, page - 1);
			const end = Math.min(totalPages - 1, page + 1);
			for (let i = start; i <= end; i++) buttons.push(i);
			if (page < totalPages - 2) buttons.push('...');
			buttons.push(totalPages);
		}
		return buttons;
	});

	// Shown above the item list for insight types that have no per-item
	// library row to act on, so the row's "Search to add" link (or whatever
	// remediation exists) isn't the only clue to what's going on.
	const INSIGHT_GUIDANCE: Record<string, string> = {
		'untracked-by-cinephage':
			'These titles exist on your media server but aren\'t in your Cinephage library yet. Use "Search to add" on a row to find and add it, or ignore this insight if you don\'t want Cinephage managing them.'
	};
	const guidanceText = $derived(insight ? (INSIGHT_GUIDANCE[insight.insightType] ?? null) : null);

	const footerLink = $derived(
		insight ? getInsightFooterLink(insight.insightType, insight.id) : null
	);

	function extractIdFromHref(href: string | undefined): string | null {
		if (!href) return null;
		const parts = href.split('/');
		return parts[parts.length - 1] || null;
	}

	function isMovieHref(href: string | undefined): boolean {
		return href?.includes('/library/movie/') ?? false;
	}

	function parseOrphanedUuid(itemId: string): string | null {
		if (itemId.startsWith('of-')) return itemId.slice(3);
		return null;
	}

	function parseSeasonEpisode(title: string): { season: number; episode: number } | null {
		const match = title.match(/[Ss](\d{1,2})[Ee](\d{1,2})/);
		if (match) return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
		return null;
	}

	function getRemediation(insightType: string, _item: ApiInsightItem): string {
		const remediations: Record<string, string> = {
			'missing-from-media-server':
				'This item was not found during the last media server sync. Re-sync your media server library from the dashboard, or verify the file still exists at the expected path.',
			'untracked-by-cinephage':
				'This item exists on your media server but is not tracked in Cinephage. Import it to enable monitoring, downloads, and quality upgrades.',
			'orphaned-files':
				'This file has no matching library item. Either import it into a library or delete it manually to free storage space.',
			'duplicate-items':
				'Multiple entries exist for what appears to be the same media. Review and remove the duplicate from your library.',
			'redundant-quality-tiers':
				'This item has more files than your multi-quality setting keeps. Review the extra files and remove the ones you no longer need.',
			'filename-duplicates':
				'Multiple files share the same name. Review and remove unnecessary duplicates to avoid library clutter.',
			'quality-below-cutoff':
				'The current quality is below your configured cutoff profile. Consider upgrading to a higher quality release.',
			unplayed:
				'This item has never been played since being added to the library. Review whether you still want to keep it, or reclaim the storage.',
			'broken-paths':
				'The file path no longer exists on disk. Either fix the path in library settings or remove the broken reference.',
			'health-issues':
				'Review the item details to identify what needs attention. This could be a path issue, missing media, or configuration problem.'
		};
		return remediations[insightType] ?? 'Review this item and resolve the issue accordingly.';
	}

	// storage_items tracks TV content per-episode for some insight types, so
	// the raw item list reads as one row per episode. These types return
	// items that legitimately share a parent (grouped by subtitle =
	// seriesName); every other resolver's subtitle is a generic per-item
	// descriptor ("N files", "N redundant files") that happens to collide
	// across unrelated items with the same count, so grouping by it there
	// would collapse distinct movies/items into a single unusable row.
	const SUBTITLE_GROUPED_INSIGHT_TYPES = new Set([
		'missing-from-media-server',
		'untracked-by-cinephage'
	]);

	const groupedItems = $derived.by(() => {
		const groups: {
			key: string;
			label: string;
			kind: string;
			href?: string;
			items: ApiInsightItem[];
			count: number;
		}[] = [];
		const groupBySubtitle = !!insight && SUBTITLE_GROUPED_INSIGHT_TYPES.has(insight.insightType);
		const seen: Record<string, number> = {};
		for (const item of items) {
			const groupKey = groupBySubtitle && item.subtitle ? item.subtitle : item.id;
			const idx = seen[groupKey];
			if (idx !== undefined) {
				groups[idx].items.push(item);
				groups[idx].count++;
			} else {
				seen[groupKey] = groups.length;
				groups.push({
					key: groupKey,
					label: groupBySubtitle && item.subtitle ? item.subtitle : item.title,
					kind: item.kind,
					href: item.href,
					items: [item],
					count: 1
				});
			}
		}
		return groups;
	});

	async function handleSyncServer() {
		syncingServer = true;
		try {
			await syncMediaServerStats();
		} finally {
			syncingServer = false;
		}
	}

	async function handleAutoSearch(item: ApiInsightItem) {
		if (!item.href) return;
		const id = extractIdFromHref(item.href);
		if (!id) return;
		actionLoading.add(item.id);
		try {
			if (isMovieHref(item.href)) {
				await searchProgress.startSearch(`/api/library/movies/${id}/auto-search`);
			} else {
				const seasonEp = parseSeasonEpisode(item.title);
				await searchProgress.startSearch(`/api/library/series/${id}/auto-search`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						type: 'season',
						seasonNumber: seasonEp?.season ?? 1
					})
				});
			}
			if (searchProgress.results) {
				if (searchProgress.results.grabbed) {
					toasts.success(`Grabbed: ${searchProgress.results.releaseName || 'release'}`);
				} else if (getPrimaryAutoSearchIssue(searchProgress.results)) {
					toasts.error(getPrimaryAutoSearchIssue(searchProgress.results)!.message);
				} else if (searchProgress.results.found) {
					toasts.info('Found releases but none were grabbed');
				} else {
					toasts.info('No releases found');
				}
			}
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Search failed');
		} finally {
			actionLoading.delete(item.id);
			searchProgress.reset();
		}
	}

	function handleInteractiveSearch(item: ApiInsightItem) {
		searchModalItem = item;
		searchModalOpen = true;
	}

	async function handleUnmonitor(item: ApiInsightItem) {
		if (!item.href) return;
		const id = extractIdFromHref(item.href);
		if (!id) return;
		actionLoading.add(item.id);
		try {
			if (isMovieHref(item.href)) {
				await batchMovies([id], { monitored: false });
			} else {
				await batchSeries([id], { monitored: false });
			}
			toasts.success('Unmonitored');
			void refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to unmonitor');
		} finally {
			actionLoading.delete(item.id);
		}
	}

	async function handleRemoveFromLibrary(item: ApiInsightItem) {
		if (!item.href) return;
		const id = extractIdFromHref(item.href);
		if (!id) return;
		actionLoading.add(item.id);
		try {
			if (isMovieHref(item.href)) {
				await deleteMovie(id, false, true);
			} else {
				await deleteSeries(id, false, true);
			}
			toasts.success('Removed from library');
			void refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to remove');
		} finally {
			actionLoading.delete(item.id);
		}
	}

	async function handleDeleteOrphaned(item: ApiInsightItem) {
		const uuid = parseOrphanedUuid(item.id);
		if (!uuid) return;
		actionLoading.add(item.id);
		try {
			await apiDelete(`/api/library/unmatched/${uuid}?deleteFile=true`);
			toasts.success('File deleted');
			void refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to delete');
		} finally {
			actionLoading.delete(item.id);
		}
	}

	async function handleDeleteAllOrphaned(groupedOrphanItems: ApiInsightItem[]) {
		const uuids = groupedOrphanItems.map((i) => parseOrphanedUuid(i.id)).filter(Boolean);
		if (uuids.length === 0) return;
		actionLoading.add('orphaned-all');
		try {
			await apiDelete('/api/library/unmatched', { fileIds: uuids, deleteFromDisk: true });
			toasts.success(`Deleted ${uuids.length} file${uuids.length === 1 ? '' : 's'}`);
			void refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to delete');
		} finally {
			actionLoading.delete('orphaned-all');
		}
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="4xl" flexContent labelledBy="insight-detail-title">
	<div class="flex min-h-0 flex-1 flex-col">
		<div class="flex items-center justify-between border-b border-base-300 px-6 py-4">
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2">
					<span
						class={`badge border-none badge-sm ${insight ? severityBadgeClass(insight.severity) : ''}`}
					>
						{insight ? insightTypeLabel(insight.insightType) : ''}
					</span>
					{#if insight?.reclaimableBytes}
						<span class="text-xs text-base-content/50">
							{formatBytes(insight.reclaimableBytes)} reclaimable
						</span>
					{/if}
				</div>
				<h3 id="insight-detail-title" class="mt-1 text-lg font-bold text-base-content">
					{insight?.title ?? ''}
				</h3>
				{#if displaySummary}
					<p class="mt-0.5 text-sm text-base-content/70">{displaySummary}</p>
				{/if}
				{#if insight?.insightType === 'missing-from-media-server'}
					<button
						class="btn mt-2 gap-1 btn-outline btn-xs"
						onclick={handleSyncServer}
						disabled={syncingServer}
					>
						{#if syncingServer}
							<span class="loading loading-xs loading-spinner"></span>
						{/if}
						Sync Now
					</button>
				{/if}
			</div>
			<button
				class="btn btn-circle btn-ghost btn-sm"
				onclick={onClose}
				aria-label={m.action_close()}
			>
				<X class="h-4 w-4" />
			</button>
		</div>

		<div class="flex-1 overflow-y-auto px-6 py-4">
			{#if loading}
				<div class="flex items-center justify-center py-16">
					<span class="loading loading-lg loading-dots text-base-content/50"></span>
				</div>
			{:else if error}
				<div class="flex flex-col items-center gap-3 py-12 text-center">
					<AlertTriangle class="h-8 w-8 text-error" />
					<p class="text-sm text-error">{error}</p>
					<button class="btn btn-ghost btn-sm" onclick={fetchItems}>Retry</button>
				</div>
			{:else if items.length === 0}
				<div class="flex items-center justify-center py-12 text-sm text-base-content/40">
					No items found
				</div>
			{:else}
				{#if guidanceText}
					<div
						class="mb-3 flex gap-2 rounded-lg border border-info/20 bg-info/10 p-3 text-sm text-base-content/80"
					>
						<Info class="h-4 w-4 shrink-0 text-info" />
						<p>{guidanceText}</p>
					</div>
				{/if}
				<div class="space-y-1">
					{#each groupedItems as group (group.key)}
						{@const isGroupExpanded = expandedGroupKey === group.key}
						{@const showGroupActions = insight?.insightType === 'orphaned-files'}
						{@const flatItem = group.count === 1 ? group.items[0] : null}
						{@const isFlatExpanded = flatItem !== null && expandedItemId === flatItem.id}
						{@const flatItemLoading = flatItem !== null && actionLoading.has(flatItem.id)}
						<div
							role="button"
							tabindex="0"
							class="w-full cursor-pointer rounded-lg border border-base-300 bg-base-200/50 px-3 py-2.5 text-left transition-colors hover:bg-base-200"
							onclick={() => {
								if (flatItem) {
									expandedItemId = isFlatExpanded ? null : flatItem.id;
								} else {
									expandedGroupKey = isGroupExpanded ? null : group.key;
								}
							}}
							onkeydown={(e) => {
								if (e.key !== 'Enter') return;
								if (flatItem) {
									expandedItemId = isFlatExpanded ? null : flatItem.id;
								} else {
									expandedGroupKey = isGroupExpanded ? null : group.key;
								}
							}}
						>
							<div class="flex items-center gap-3">
								{#if group.kind === 'movie'}
									<Film class="h-4 w-4 shrink-0 text-base-content/40" />
								{:else if group.kind === 'series'}
									<Tv class="h-4 w-4 shrink-0 text-base-content/40" />
								{:else if group.kind === 'episode'}
									<Monitor class="h-4 w-4 shrink-0 text-base-content/40" />
								{:else if group.kind === 'folder'}
									<Folder class="h-4 w-4 shrink-0 text-base-content/40" />
								{:else}
									<File class="h-4 w-4 shrink-0 text-base-content/40" />
								{/if}
								<div class="min-w-0 flex-1">
									<div class="truncate text-sm font-medium text-base-content">
										{group.label}
									</div>
								</div>
								{#if flatItem?.badges}
									{#each flatItem.badges as badge (badge.label + badge.tone)}
										<span class={`badge border badge-sm ${badgeToneColor(badge.tone)}`}>
											{badge.label}
										</span>
									{/each}
								{:else if group.count > 1}
									<span class="badge badge-sm">{group.count}</span>
								{/if}
								{#if flatItem?.sizeBytes}
									<span class="text-xs text-base-content/50">{formatBytes(flatItem.sizeBytes)}</span
									>
								{/if}
								{#if flatItem?.href}
									<a
										href={resolvePath(flatItem.href)}
										class="btn gap-1 btn-ghost btn-xs"
										onclick={(e) => {
											e.stopPropagation();
											onClose();
										}}
									>
										{flatItem.href.startsWith('/discover') ? 'Search to add' : 'Open'}
									</a>
								{/if}
								{#if showGroupActions && !flatItem}
									<button
										class="btn btn-ghost text-error btn-xs"
										onclick={(e) => {
											e.stopPropagation();
											handleDeleteAllOrphaned(group.items);
										}}
										disabled={actionLoading.has('orphaned-all')}
									>
										{#if actionLoading.has('orphaned-all')}
											<span class="loading loading-xs loading-spinner"></span>
										{/if}
										Delete All
									</button>
								{/if}
							</div>
							<!-- Inline remediation for flat (single) items -->
							{#if flatItem && isFlatExpanded && insight}
								<div class="mt-2 border-t border-base-300 pt-2">
									<p class="text-xs text-base-content/70">
										{getRemediation(insight.insightType, flatItem)}
									</p>
									<div class="mt-2 flex gap-1">
										{#if insight.insightType === 'quality-below-cutoff'}
											<button
												class="btn btn-ghost btn-xs"
												onclick={(e) => {
													e.stopPropagation();
													handleAutoSearch(flatItem);
												}}
												disabled={flatItemLoading}
											>
												{#if flatItemLoading}<span class="loading loading-xs loading-spinner"
													></span>{/if}
												<Search class="h-3 w-3" /> Auto
											</button>
										{/if}
										{#if insight.insightType === 'missing-from-media-server'}
											<button
												class="btn btn-ghost btn-xs"
												onclick={(e) => {
													e.stopPropagation();
													handleAutoSearch(flatItem);
												}}
												disabled={flatItemLoading}
											>
												{#if flatItemLoading}<span class="loading loading-xs loading-spinner"
													></span>{/if}
												<Search class="h-3 w-3" /> Auto
											</button>
											<button
												class="btn btn-ghost btn-xs"
												onclick={(e) => {
													e.stopPropagation();
													handleInteractiveSearch(flatItem);
												}}
											>
												Interactive
											</button>
										{/if}
										{#if insight.insightType === 'unplayed'}
											<button
												class="btn btn-ghost btn-xs"
												onclick={(e) => {
													e.stopPropagation();
													handleUnmonitor(flatItem);
												}}
												disabled={flatItemLoading}
											>
												{#if flatItemLoading}<span class="loading loading-xs loading-spinner"
													></span>{/if}
												Unmonitor
											</button>
											<button
												class="btn btn-ghost text-error btn-xs"
												onclick={(e) => {
													e.stopPropagation();
													handleRemoveFromLibrary(flatItem);
												}}
												disabled={flatItemLoading}
											>
												{#if flatItemLoading}<span class="loading loading-xs loading-spinner"
													></span>{/if}
												Remove
											</button>
										{/if}
										{#if insight.insightType === 'broken-paths'}
											<button
												class="btn btn-ghost text-error btn-xs"
												onclick={(e) => {
													e.stopPropagation();
													handleRemoveFromLibrary(flatItem);
												}}
												disabled={flatItemLoading}
											>
												{#if flatItemLoading}<span class="loading loading-xs loading-spinner"
													></span>{/if}
												Remove
											</button>
										{/if}
										{#if insight.insightType === 'orphaned-files'}
											<button
												class="btn btn-ghost text-error btn-xs"
												onclick={(e) => {
													e.stopPropagation();
													handleDeleteOrphaned(flatItem);
												}}
												disabled={flatItemLoading}
											>
												{#if flatItemLoading}<span class="loading loading-xs loading-spinner"
													></span>{/if}
												Delete
											</button>
										{/if}
									</div>
								</div>
							{/if}
						</div>
						<!-- Sub-item list only for grouped items (count > 1) -->
						{#if !flatItem && isGroupExpanded}
							<div class="space-y-1 pl-6">
								{#each group.items as item (item.id)}
									{@const isExpanded = expandedItemId === item.id}
									{@const itemLoading = actionLoading.has(item.id)}
									<div
										role="button"
										tabindex="0"
										class="w-full cursor-pointer rounded-lg border border-base-300 bg-base-200/30 px-3 py-2 text-left transition-colors hover:bg-base-200/50"
										onclick={() => (expandedItemId = isExpanded ? null : item.id)}
										onkeydown={(e) => {
											if (e.key === 'Enter') expandedItemId = isExpanded ? null : item.id;
										}}
									>
										<div class="flex items-center gap-2">
											<Monitor class="h-3.5 w-3.5 shrink-0 text-base-content/40" />
											<div class="min-w-0 flex-1">
												<div class="truncate text-xs font-medium text-base-content">
													{item.title}
												</div>
											</div>
											{#if item.badges}
												{#each item.badges as badge (badge.label + badge.tone)}
													<span class={`badge border badge-sm ${badgeToneColor(badge.tone)}`}>
														{badge.label}
													</span>
												{/each}
											{/if}
											{#if item.sizeBytes}
												<span class="text-xs text-base-content/50"
													>{formatBytes(item.sizeBytes)}</span
												>
											{/if}
											{#if item.href}
												<a
													href={resolvePath(item.href)}
													class="btn btn-ghost btn-xs"
													onclick={(e) => {
														e.stopPropagation();
														onClose();
													}}
												>
													{item.href.startsWith('/discover') ? 'Search to add' : 'Open'}
												</a>
											{/if}
										</div>
										{#if isExpanded && insight}
											<div class="mt-2 border-t border-base-300 pt-2">
												<p class="text-xs text-base-content/70">
													{getRemediation(insight.insightType, item)}
												</p>
												<div class="mt-2 flex gap-1">
													{#if insight.insightType === 'quality-below-cutoff'}
														<button
															class="btn btn-ghost btn-xs"
															onclick={(e) => {
																e.stopPropagation();
																handleAutoSearch(item);
															}}
															disabled={itemLoading}
														>
															{#if itemLoading}<span class="loading loading-xs loading-spinner"
																></span>{/if}
															<Search class="h-3 w-3" /> Auto
														</button>
													{/if}
													{#if insight.insightType === 'missing-from-media-server'}
														<button
															class="btn btn-ghost btn-xs"
															onclick={(e) => {
																e.stopPropagation();
																handleAutoSearch(item);
															}}
															disabled={itemLoading}
														>
															{#if itemLoading}<span class="loading loading-xs loading-spinner"
																></span>{/if}
															<Search class="h-3 w-3" /> Auto
														</button>
														<button
															class="btn btn-ghost btn-xs"
															onclick={(e) => {
																e.stopPropagation();
																handleInteractiveSearch(item);
															}}
														>
															Interactive
														</button>
													{/if}
													{#if insight.insightType === 'unplayed'}
														<button
															class="btn btn-ghost btn-xs"
															onclick={(e) => {
																e.stopPropagation();
																handleUnmonitor(item);
															}}
															disabled={itemLoading}
														>
															{#if itemLoading}<span class="loading loading-xs loading-spinner"
																></span>{/if}
															Unmonitor
														</button>
														<button
															class="btn btn-ghost text-error btn-xs"
															onclick={(e) => {
																e.stopPropagation();
																handleRemoveFromLibrary(item);
															}}
															disabled={itemLoading}
														>
															{#if itemLoading}<span class="loading loading-xs loading-spinner"
																></span>{/if}
															Remove
														</button>
													{/if}
													{#if insight.insightType === 'broken-paths'}
														<button
															class="btn btn-ghost text-error btn-xs"
															onclick={(e) => {
																e.stopPropagation();
																handleRemoveFromLibrary(item);
															}}
															disabled={itemLoading}
														>
															{#if itemLoading}<span class="loading loading-xs loading-spinner"
																></span>{/if}
															Remove
														</button>
													{/if}
													{#if insight.insightType === 'orphaned-files'}
														<button
															class="btn btn-ghost text-error btn-xs"
															onclick={(e) => {
																e.stopPropagation();
																handleDeleteOrphaned(item);
															}}
															disabled={itemLoading}
														>
															{#if itemLoading}<span class="loading loading-xs loading-spinner"
																></span>{/if}
															Delete
														</button>
													{/if}
												</div>
											</div>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					{/each}
				</div>

				{#if totalPages > 1}
					<div class="mt-4 flex items-center justify-between">
						<span class="text-xs text-base-content/40">
							{total} item{total !== 1 ? 's' : ''}
						</span>
						<div class="join">
							<button
								class="btn join-item btn-ghost btn-xs"
								disabled={page <= 1}
								onclick={() => handlePageChange(page - 1)}
							>
								Prev
							</button>
							{#each pageButtons as btn, idx (idx)}
								{@const isActive = btn === page}
								{@const isEllipsis = btn === '...'}
								{#if isEllipsis}
									<button class="btn join-item btn-ghost btn-xs" disabled> ... </button>
								{:else}
									<button
										class="btn join-item btn-ghost btn-xs"
										class:btn-active={isActive}
										onclick={() => handlePageChange(btn)}
									>
										{btn}
									</button>
								{/if}
							{/each}
							<button
								class="btn join-item btn-ghost btn-xs"
								disabled={page >= totalPages}
								onclick={() => handlePageChange(page + 1)}
							>
								Next
							</button>
						</div>
					</div>
				{/if}
			{/if}
		</div>

		<div class="flex items-center justify-between border-t border-base-300 px-6 py-3">
			{#if insight && footerLink}
				<a href={resolvePath(footerLink)} class="link text-sm link-hover">
					View all in {insightTypeLabel(insight.insightType)}
				</a>
			{/if}
			<div class="ml-auto flex items-center gap-2">
				{#if onDismissed}
					<button class="btn btn-ghost btn-sm" onclick={handleDismiss} disabled={dismissing}>
						{#if dismissing}
							<span class="loading loading-sm loading-spinner"></span>
						{/if}
						Dismiss
					</button>
				{/if}
				<button class="btn btn-ghost btn-sm" onclick={onClose}> Close </button>
			</div>
		</div>
	</div>
</ModalWrapper>

{#if searchModalItem}
	{@const id = extractIdFromHref(searchModalItem.href)}
	{@const isMovie = isMovieHref(searchModalItem.href)}
	{@const seasonEp = parseSeasonEpisode(searchModalItem.title)}
	<MediaSearchModal
		open={searchModalOpen}
		movieId={isMovie ? (id ?? undefined) : undefined}
		seriesId={!isMovie ? (id ?? undefined) : undefined}
		season={seasonEp?.season}
		episode={seasonEp?.episode}
		onClose={() => (searchModalOpen = false)}
	/>
{/if}
