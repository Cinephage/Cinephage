<script lang="ts">
	/**
	 * Automatic-search retry panel.
	 *
	 * Self-fetching, like ActivityUnmatchedCard: the tab it lives on owns the
	 * queue/history fetch pipeline and this has nothing to do with it.
	 */
	import { onMount } from 'svelte';
	import { Pause, Play, RotateCw, Search } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { toasts } from '#lib/stores/toast.svelte.js';

	interface RetryItem {
		ownerType: 'movie' | 'episode';
		ownerId: string;
		kind: string;
		status: string;
		attempts: number;
		maxAttempts: number;
		lastOutcome: string | null;
		lastAttemptAt: string | null;
		nextAttemptAt: string | null;
		lastIndexerName: string | null;
		indexersQueried: number;
		pauseReason: string | null;
		title: string;
	}

	interface RetryPolicy {
		maxAttempts: number;
		minDelayHours: number;
		backoffMultiplier: number;
		maxDelayHours: number;
		paused: boolean;
		newEpisodeMaxAttempts: number;
	}

	let loading = $state(true);
	let busy = $state<string | null>(null);
	let items = $state<RetryItem[]>([]);
	let policy = $state<RetryPolicy | null>(null);

	async function load(): Promise<void> {
		loading = true;
		try {
			const response = await fetch('/api/monitoring/searches');
			const body = await response.json();
			if (!response.ok || !body.success) throw new Error(body.error ?? 'Request failed');
			items = body.items;
			policy = body.policy;
		} catch {
			toasts.error(m.searchRetries_loadFailed());
		} finally {
			loading = false;
		}
	}

	async function post(body: Record<string, unknown>, key: string): Promise<void> {
		busy = key;
		try {
			const response = await fetch('/api/monitoring/searches', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!response.ok) throw new Error('Request failed');
			await load();
		} catch {
			toasts.error(m.searchRetries_actionFailed());
		} finally {
			busy = null;
		}
	}

	function toggleAll(): void {
		if (!policy) return;
		void post({ action: policy.paused ? 'resume-all' : 'pause-all' }, 'all');
	}

	function toggleItem(item: RetryItem): void {
		const paused = item.status === 'paused';
		void post(
			{
				action: paused ? 'resume' : 'pause',
				ownerType: item.ownerType,
				ownerId: item.ownerId,
				kind: item.kind
			},
			`${item.ownerType}:${item.ownerId}:${item.kind}`
		);
	}

	function when(iso: string | null): string {
		if (!iso) return '—';
		const date = new Date(iso);
		return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
	}

	const kindLabel: Record<string, string> = {
		missing: 'Missing',
		upgrade: 'Upgrade',
		cutoff: 'Cutoff',
		new_episode: 'New episode'
	};

	onMount(load);
</script>

<div class="flex flex-col gap-4">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="flex items-center gap-2 text-sm">
			<Search class="h-4 w-4 text-base-content/60" />
			<span class="text-base-content/60">
				{#if policy?.paused}
					{m.searchRetries_paused()}
				{:else}
					{m.searchRetries_running()}
				{/if}
			</span>
			{#if policy}
				<span class="badge badge-ghost badge-sm">
					{policy.maxAttempts} × {policy.minDelayHours}h → {policy.maxDelayHours}h
				</span>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			<button class="btn btn-ghost btn-sm" onclick={() => void load()} disabled={loading}>
				<RotateCw class="h-4 w-4" />
				{m.searchRetries_refresh()}
			</button>
			<button
				class="btn btn-sm {policy?.paused ? 'btn-success' : 'btn-warning'}"
				onclick={toggleAll}
				disabled={!policy || busy === 'all'}
			>
				{#if policy?.paused}
					<Play class="h-4 w-4" />
					{m.searchRetries_resumeAll()}
				{:else}
					<Pause class="h-4 w-4" />
					{m.searchRetries_pauseAll()}
				{/if}
			</button>
		</div>
	</div>

	{#if loading}
		<div class="flex justify-center py-12">
			<span class="loading loading-spinner loading-md"></span>
		</div>
	{:else if items.length === 0}
		<div class="rounded-box border border-base-300 px-4 py-12 text-center text-sm text-base-content/60">
			{m.searchRetries_empty()}
		</div>
	{:else}
		<div class="overflow-x-auto rounded-box border border-base-300">
			<table class="table table-sm">
				<thead>
					<tr>
						<th>{m.searchRetries_media()}</th>
						<th>{m.searchRetries_kind()}</th>
						<th>{m.searchRetries_status()}</th>
						<th class="text-right">{m.searchRetries_attempts()}</th>
						<th>{m.searchRetries_next()}</th>
						<th>{m.searchRetries_lastOutcome()}</th>
						<th>{m.searchRetries_indexer()}</th>
						<th class="text-right">{m.searchRetries_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each items as item (item.ownerType + item.ownerId + item.kind)}
						<tr>
							<td class="max-w-xs truncate font-medium" title={item.title}>{item.title}</td>
							<td>{kindLabel[item.kind] ?? item.kind}</td>
							<td>
								<span
									class="badge badge-sm {item.status === 'exhausted'
										? 'badge-error'
										: item.status === 'paused'
											? 'badge-warning'
											: 'badge-ghost'}"
									title={item.pauseReason ?? ''}
								>
									{item.status}
								</span>
							</td>
							<td class="text-right tabular-nums">{item.attempts}/{item.maxAttempts}</td>
							<td class="whitespace-nowrap text-xs">{when(item.nextAttemptAt)}</td>
							<td class="text-xs">{item.lastOutcome ?? '—'}</td>
							<td class="text-xs">
								{item.lastIndexerName ??
									(item.indexersQueried ? `${item.indexersQueried} queried` : '—')}
							</td>
							<td class="text-right">
								<button
									class="btn btn-ghost btn-xs"
									onclick={() => toggleItem(item)}
									disabled={busy === `${item.ownerType}:${item.ownerId}:${item.kind}`}
								>
									{#if item.status === 'paused'}
										<Play class="h-3 w-3" />
										{m.searchRetries_resume()}
									{:else}
										<Pause class="h-3 w-3" />
										{m.searchRetries_pause()}
									{/if}
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
