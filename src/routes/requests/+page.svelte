<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { PageData } from './$types';
	import { onMount } from 'svelte';
	import { Loader2, Check, X, RotateCcw, BadgeCheck, Inbox, Clock, Trash2 } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { SvelteSet } from 'svelte/reactivity';
	import { formatDisplayDateShort } from '#lib/utils/format.js';
	import {
		listRequests,
		getRequestCounts,
		cancelRequest,
		deleteRequest,
		approveRequest,
		declineRequest,
		retryRequest,
		fulfillRequest,
		bulkRequestAction,
		type MediaRequest,
		type RequestCountResponse
	} from '#lib/api/requests.js';
	import RequestStatusBadge from '#lib/components/requests/RequestStatusBadge.svelte';
	import QuotaSummary from '#lib/components/requests/QuotaSummary.svelte';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { ModalHeader, ModalFooter, ConfirmationModal } from '#lib/components/ui/modal/index.js';

	let { data }: { data: PageData } = $props();
	const isAdmin = $derived(data.role === 'admin');

	let loading = $state(true);
	let rows = $state<Array<MediaRequest & { requestedByName?: string | null }>>([]);
	let counts = $state<RequestCountResponse | null>(null);
	// Admins land on the pending queue; viewers on everything they filed.
	// Initial value only — the filter is user-editable afterwards.
	// svelte-ignore state_referenced_locally
	let filter = $state<'all' | 'pending' | 'approved' | 'fulfilled' | 'failed' | 'declined'>(
		data.role === 'admin' ? 'pending' : 'all'
	);
	let mediaFilter = $state<'all' | 'movie' | 'series'>('all');
	let selected = new SvelteSet<string>();
	let showDeclineModal = $state(false);
	let declineTarget = $state<string | 'bulk' | null>(null);
	let declineReason = $state('');
	let acting = $state(false);
	let removeTarget = $state<MediaRequest | null>(null);

	const filters = $derived([
		{ key: 'all', label: m.requests_filterAll() },
		{ key: 'pending', label: m.requests_status_pending() },
		{ key: 'approved', label: m.requests_status_approved() },
		{ key: 'fulfilled', label: m.requests_status_fulfilled() },
		{ key: 'failed', label: m.requests_status_failed() },
		{ key: 'declined', label: m.requests_filterDeclined() }
	] as const);

	async function load() {
		loading = true;
		try {
			const [list, countData] = await Promise.all([
				listRequests({
					filter,
					mediaType: mediaFilter === 'all' ? undefined : mediaFilter,
					take: 100
				}),
				getRequestCounts()
			]);
			rows = list;
			counts = countData;
			selected.clear();
		} catch {
			toasts.error(m.requests_errorLoad());
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void filter;
		void mediaFilter;
		void load();
	});

	onMount(() => {
		// Live refresh: the stream carries a nudge only, so re-fetch on event.
		const source = new EventSource('/api/requests/stream');
		source.addEventListener('requests:refresh', () => {
			void load();
		});
		return () => source.close();
	});

	function toggleSelected(id: string) {
		if (selected.has(id)) {
			selected.delete(id);
		} else {
			selected.add(id);
		}
	}

	function openDecline(id: string | 'bulk') {
		declineTarget = id;
		declineReason = '';
		showDeclineModal = true;
	}

	async function submitDecline() {
		if (!declineReason.trim()) return;
		acting = true;
		try {
			if (declineTarget === 'bulk') {
				const outcomes = await bulkRequestAction([...selected], 'decline', declineReason.trim());
				const ok = outcomes.filter((o) => o.ok).length;
				if (ok > 0) {
					toasts.success(m.requests_bulkDeclined({ count: ok }));
				} else {
					toasts.error(m.requests_errorGeneric());
				}
			} else if (declineTarget) {
				await declineRequest(declineTarget, declineReason.trim());
				toasts.success(m.requests_declined());
			}
			showDeclineModal = false;
			await load();
		} catch {
			toasts.error(m.requests_errorGeneric());
		} finally {
			acting = false;
		}
	}

	async function act(fn: () => Promise<unknown>, successMessage: string) {
		acting = true;
		try {
			await fn();
			toasts.success(successMessage);
			await load();
		} catch (error) {
			const apiError = error as { message?: string };
			toasts.error(apiError.message ?? m.requests_errorGeneric());
		} finally {
			acting = false;
		}
	}

	async function bulkApprove() {
		if (selected.size === 0) return;
		acting = true;
		try {
			const outcomes = await bulkRequestAction([...selected], 'approve');
			const ok = outcomes.filter((o) => o.ok).length;
			if (ok > 0) {
				toasts.success(m.requests_bulkApproved({ count: ok }));
			} else {
				toasts.error(m.requests_errorGeneric());
			}
			await load();
		} catch {
			toasts.error(m.requests_errorGeneric());
		} finally {
			acting = false;
		}
	}

	function scopeSummary(row: MediaRequest): string {
		if (row.mediaType === 'movie') return '';
		const parts: string[] = [];
		if (row.seasons?.length) {
			parts.push(
				m.requests_scopeSeasons({
					seasons: [...(row.seasons ?? [])].sort((a, b) => a - b).join(', ')
				})
			);
		}
		if (row.episodes?.length) {
			parts.push(
				m.requests_scopeEpisodes({
					episodes: (row.episodes ?? [])
						.map((e) => `S${e.seasonNumber}E${e.episodeNumber}`)
						.join(', ')
				})
			);
		}
		return parts.join(' · ');
	}

	function detailHref(row: MediaRequest): string {
		return row.mediaType === 'movie'
			? `/discover/movie/${row.tmdbId}`
			: `/discover/tv/${row.tmdbId}`;
	}

	/** Decided requests can be cleared from the list outright. */
	const isRemovable = (status: MediaRequest['status']): boolean =>
		status === 'declined' ||
		status === 'expired' ||
		status === 'cancelled' ||
		status === 'fulfilled';

	async function confirmRemove() {
		if (!removeTarget) return;
		const target = removeTarget;
		await act(async () => {
			await deleteRequest(target.id);
			removeTarget = null;
		}, m.requests_removed());
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="flex items-center gap-2 text-2xl font-bold">
				<Inbox class="h-8 w-8" />
				{isAdmin ? m.requests_allRequests() : m.requests_myRequests()}
			</h1>
			<p class="text-base-content/70">{m.requests_pageSubtitle()}</p>
		</div>
		{#if isAdmin && counts && counts.counts.pending > 0}
			<span class="badge gap-1.5 font-medium badge-warning">
				<Clock class="h-4 w-4" />
				{m.requests_pendingCount({ count: counts.counts.pending })}
			</span>
		{/if}
	</div>

	{#if !isAdmin && counts}
		<div class="grid gap-2 sm:grid-cols-2">
			<QuotaSummary quota={counts.quota.movie} type="movie" />
			<QuotaSummary quota={counts.quota.tv} type="tv" />
		</div>
	{/if}

	<!-- Awaiting-target hint: these requests park until a writable
	     destination exists; the sweep retries them automatically. -->
	{#if counts && counts.counts.awaiting_target > 0}
		<div
			class="flex items-start gap-2 rounded-xl border border-warning/25 bg-warning/10 px-3.5 py-2.5 text-sm text-warning"
		>
			<Clock class="mt-0.5 h-4 w-4 shrink-0" />
			<span>
				{m.requests_awaitingHint()}
				{m.requests_awaitingTargetHint()}
			</span>
		</div>
	{/if}

	<!-- Toolbar -->
	<div class="flex flex-wrap items-center gap-3">
		<div class="tabs-boxed tabs w-fit">
			{#each filters as f (f.key)}
				<button
					type="button"
					class="tab {filter === f.key ? 'tab-active' : ''}"
					onclick={() => (filter = f.key)}
				>
					{f.label}
				</button>
			{/each}
		</div>
		<select class="select w-34 select-sm" bind:value={mediaFilter}>
			<option value="all">{m.requests_mediaAll()}</option>
			<option value="movie">{m.requests_movies()}</option>
			<option value="series">{m.requests_series()}</option>
		</select>
	</div>

	<!-- Selection toolbar (admin, replaces the floating bulk bar) -->
	{#if isAdmin && selected.size > 0}
		<div class="flex flex-wrap items-center gap-2">
			<span class="text-xs text-base-content/60">
				{m.requests_selectedCount({ count: selected.size })}
			</span>
			<div class="divider mx-1 divider-horizontal h-6"></div>
			<button
				type="button"
				class="btn btn-ghost text-success btn-xs"
				disabled={acting}
				onclick={bulkApprove}
			>
				<Check class="h-3.5 w-3.5" />
				{m.requests_approve()}
			</button>
			<button
				type="button"
				class="btn btn-ghost text-error btn-xs"
				disabled={acting}
				onclick={() => openDecline('bulk')}
			>
				<X class="h-3.5 w-3.5" />
				{m.requests_decline()}
			</button>
			<div class="ml-auto"></div>
			<button type="button" class="btn btn-ghost btn-xs" onclick={() => selected.clear()}>
				{m.action_cancel()}
			</button>
		</div>
	{/if}

	<!-- List -->
	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="h-5 w-5 animate-spin text-base-content/40" />
		</div>
	{:else if rows.length === 0}
		<div class="py-12 text-center text-base-content/60">
			<Inbox class="mx-auto mb-4 h-12 w-12 opacity-40" />
			<p class="text-lg font-medium">{m.requests_empty()}</p>
			<p class="mt-1 text-sm">{m.requests_emptyHint()}</p>
		</div>
	{:else}
		<div class="overflow-x-auto">
			<table class="table table-sm">
				<thead>
					<tr>
						{#if isAdmin}
							<th class="w-10"></th>
						{/if}
						<th>{m.requests_colTitle()}</th>
						<th>{m.requests_colStatus()}</th>
						{#if isAdmin}
							<th>{m.requests_colRequestedBy()}</th>
						{/if}
						<th>{m.requests_colRequested()}</th>
						<th class="w-10"></th>
					</tr>
				</thead>
				<tbody>
					{#each rows as row (row.id)}
						<tr class="hover {selected.has(row.id) ? 'bg-primary/[0.04]' : ''}">
							{#if isAdmin}
								<td class="w-10">
									<input
										type="checkbox"
										class="checkbox checkbox-xs checkbox-primary"
										checked={selected.has(row.id)}
										onchange={() => toggleSelected(row.id)}
										aria-label={row.title}
									/>
								</td>
							{/if}
							<td>
								<div class="flex items-center gap-3">
									<div class="w-8 shrink-0 overflow-hidden rounded">
										{#if row.posterPath}
											<img
												src="https://image.tmdb.org/t/p/w92{row.posterPath}"
												alt=""
												loading="lazy"
												class="aspect-2/3 w-full object-cover"
											/>
										{:else}
											<div
												class="flex aspect-2/3 w-full items-center justify-center bg-base-300 text-base-content/30"
											>
												<Inbox class="h-3.5 w-3.5" />
											</div>
										{/if}
									</div>
									<div class="min-w-0">
										<div class="flex items-center gap-2">
											<a href={detailHref(row)} class="flex items-center gap-2 hover:text-primary">
												<span class="max-w-48 truncate font-medium" title={row.title}>
													{row.title}
												</span>
												{#if row.year}
													<span class="text-base-content/60">({row.year})</span>
												{/if}
											</a>
											{#if row.autoApproved}
												<span class="badge badge-outline badge-xs">{m.requests_autoApproved()}</span
												>
											{/if}
										</div>
										{#if scopeSummary(row)}
											<div class="mt-0.5 text-xs text-base-content/50">{scopeSummary(row)}</div>
										{/if}
										{#if (row.status === 'declined' || row.status === 'expired') && row.declineReason}
											<div class="mt-0.5 text-xs text-base-content/45">
												{m.requests_reason({ reason: row.declineReason })}
											</div>
										{/if}
										{#if row.status === 'failed' && row.failureReason}
											<div class="mt-0.5 text-xs text-error/80">
												{m.requests_reason({ reason: row.failureReason })}
											</div>
										{/if}
									</div>
								</div>
							</td>
							<td><RequestStatusBadge status={row.status} size="xs" /></td>
							{#if isAdmin}
								<td class="text-sm">{row.requestedByName ?? '—'}</td>
							{/if}
							<td class="text-sm whitespace-nowrap text-base-content/60">
								{formatDisplayDateShort(row.createdAt)}
							</td>
							<td class="w-10">
								<div class="flex items-center justify-end gap-0.5">
									{#if isAdmin}
										{#if row.status === 'pending' || row.status === 'awaiting_target' || row.status === 'failed'}
											<button
												type="button"
												class="btn btn-ghost text-success btn-xs"
												disabled={acting}
												title={m.requests_approve()}
												aria-label={m.requests_approve()}
												onclick={() => act(() => approveRequest(row.id), m.requests_approved())}
											>
												<Check class="h-4 w-4" />
											</button>
											<button
												type="button"
												class="btn btn-ghost text-error btn-xs"
												disabled={acting}
												title={m.requests_decline()}
												aria-label={m.requests_decline()}
												onclick={() => openDecline(row.id)}
											>
												<X class="h-4 w-4" />
											</button>
										{/if}
										{#if row.status === 'failed'}
											<button
												type="button"
												class="btn btn-ghost btn-xs"
												disabled={acting}
												title={m.requests_retry()}
												aria-label={m.requests_retry()}
												onclick={() => act(() => retryRequest(row.id), m.requests_retried())}
											>
												<RotateCcw class="h-3.5 w-3.5" />
											</button>
										{/if}
										{#if row.status !== 'fulfilled' && row.status !== 'declined' && row.status !== 'expired' && row.status !== 'cancelled'}
											<button
												type="button"
												class="btn btn-ghost btn-xs"
												disabled={acting}
												title={m.requests_markFulfilledHint()}
												aria-label={m.requests_markFulfilled()}
												onclick={() => act(() => fulfillRequest(row.id), m.requests_fulfilledMsg())}
											>
												<BadgeCheck class="h-4 w-4" />
											</button>
										{/if}
										{#if isRemovable(row.status)}
											<button
												type="button"
												class="btn btn-ghost text-error btn-xs"
												disabled={acting}
												title={m.requests_remove()}
												aria-label={m.requests_remove()}
												onclick={() => (removeTarget = row)}
											>
												<Trash2 class="h-3.5 w-3.5" />
											</button>
										{/if}
									{:else if row.status === 'pending'}
										<button
											type="button"
											class="btn btn-ghost text-error btn-xs"
											disabled={acting}
											title={m.requests_cancelRequest()}
											aria-label={m.requests_cancelRequest()}
											onclick={() =>
												act(
													() => cancelRequest(row.id),
													m.requests_cancelled({ title: row.title })
												)}
										>
											<X class="h-4 w-4" />
										</button>
									{:else if isRemovable(row.status)}
										<button
											type="button"
											class="btn btn-ghost text-error btn-xs"
											disabled={acting}
											title={m.requests_remove()}
											aria-label={m.requests_remove()}
											onclick={() => (removeTarget = row)}
										>
											<Trash2 class="h-3.5 w-3.5" />
										</button>
									{/if}
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<!-- Decline modal -->
<ModalWrapper open={showDeclineModal} onClose={() => (showDeclineModal = false)} maxWidth="md">
	<ModalHeader title={m.requests_declineTitle()} onClose={() => (showDeclineModal = false)} />
	<div class="space-y-3">
		<p class="text-sm text-base-content/60">{m.requests_declineReasonHint()}</p>
		<textarea
			class="textarea-bordered textarea w-full"
			rows="3"
			bind:value={declineReason}
			placeholder={m.requests_declineReasonPlaceholder()}></textarea>
	</div>
	<ModalFooter
		saving={acting}
		saveDisabled={!declineReason.trim()}
		saveLabel={m.requests_decline()}
		onSave={submitDecline}
		onCancel={() => (showDeclineModal = false)}
	/>
</ModalWrapper>

<!-- Remove confirmation -->
<ConfirmationModal
	open={removeTarget !== null}
	title={m.requests_removeTitle()}
	message={removeTarget ? m.requests_removeBody({ title: removeTarget.title }) : ''}
	confirmLabel={m.requests_remove()}
	confirmVariant="error"
	loading={acting}
	onConfirm={confirmRemove}
	onCancel={() => (removeTarget = null)}
/>
