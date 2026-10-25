<script lang="ts">
	import { RefreshCw, Calendar, AlertTriangle, Check, Info, Loader2 } from '@lucide/svelte';
	import type { EpgStatus } from '#lib/types/livetv.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		status: EpgStatus | null;
		loading: boolean;
		syncing: boolean;
		onSync: () => void;
	}

	let { status, loading, syncing, onSync }: Props = $props();

	let detailsOpen = $state(false);

	function formatRelativeTime(isoDate: string | null): string {
		if (!isoDate) return m.livetv_epgStatus_never();

		const date = new Date(isoDate);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMins / 60);
		const diffDays = Math.floor(diffHours / 24);

		if (diffMins < 1) return m.livetv_epgStatus_justNow();
		if (diffMins < 60) return m.livetv_epgStatus_minutesAgo({ count: diffMins });
		if (diffHours < 24) return m.livetv_epgStatus_hoursAgo({ count: diffHours });
		return m.livetv_epgStatus_daysAgo({ count: diffDays });
	}

	function formatFutureTime(isoDate: string | null): string {
		if (!isoDate) return m.common_unknown();

		const date = new Date(isoDate);
		const now = new Date();
		const diffMs = date.getTime() - now.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMins / 60);

		if (diffMins < 1) return m.livetv_epgStatus_futureSoon();
		if (diffMins < 60) return m.livetv_epgStatus_futureMinutes({ count: diffMins });
		if (diffHours < 24) return m.livetv_epgStatus_futureHours({ count: diffHours });
		return m.livetv_epgStatus_futureDays({ count: Math.floor(diffHours / 24) });
	}

	// Derive account stats
	const _accountsWithEpg = $derived(status?.accounts.filter((a) => a.hasEpg === true).length ?? 0);
	const accountsWithoutEpg = $derived(
		status?.accounts.filter((a) => a.hasEpg === false).length ?? 0
	);
	const accountsWithError = $derived(status?.accounts.filter((a) => a.error).length ?? 0);
</script>

<div class="card bg-base-200">
	<div class="card-body p-4">
		<!-- Header with title and sync button -->
		<div class="flex items-center justify-between">
			<div class="flex items-center gap-2">
				<Calendar class="h-5 w-5 text-primary" />
				<h3 class="font-semibold">{m.livetv_epgStatus_title()}</h3>
				{#if accountsWithError > 0}
					<div class="badge badge-sm badge-error">
						{m.livetv_epgStatus_errorBadge({ count: accountsWithError })}
					</div>
				{:else if accountsWithoutEpg > 0}
					<div class="badge badge-sm badge-warning">
						{m.livetv_epgStatus_noEpgBadge({ count: accountsWithoutEpg })}
					</div>
				{/if}
			</div>
			<button
				class="btn btn-ghost btn-sm"
				onclick={onSync}
				disabled={syncing || loading}
				title={m.livetv_epgStatus_syncTooltip()}
			>
				{#if syncing}
					<Loader2 class="h-4 w-4 animate-spin" />
					<span class="hidden sm:inline">{m.livetv_epgStatus_syncing()}</span>
				{:else}
					<RefreshCw class="h-4 w-4" />
					<span class="hidden sm:inline">{m.livetv_epgStatus_syncButton()}</span>
				{/if}
			</button>
		</div>

		<!-- Summary stats -->
		{#if loading}
			<div class="flex items-center justify-center py-4">
				<Loader2 class="h-6 w-6 animate-spin text-base-content/40" />
			</div>
		{:else if status}
			<div class="mt-3 grid grid-cols-3 gap-4 text-center">
				<div>
					<div class="text-2xl font-bold">{status.totalPrograms.toLocaleString(undefined)}</div>
					<div class="text-xs text-base-content/60">{m.livetv_epgStatus_programsLabel()}</div>
				</div>
				<div>
					<div class="text-sm font-medium">{formatRelativeTime(status.lastSyncAt)}</div>
					<div class="text-xs text-base-content/60">{m.livetv_epgStatus_lastSyncLabel()}</div>
				</div>
				<div>
					<div class="text-sm font-medium">{formatFutureTime(status.nextSyncAt)}</div>
					<div class="text-xs text-base-content/60">{m.livetv_epgStatus_nextSyncLabel()}</div>
				</div>
			</div>

			<!-- Per-account breakdown (collapsible) -->
			{#if status.accounts && status.accounts.length > 0}
				<div class="collapse mt-3 bg-base-100" class:collapse-open={detailsOpen}>
					<button
						class="collapse-title flex items-center justify-between px-3 py-2 text-sm font-medium"
						onclick={() => (detailsOpen = !detailsOpen)}
					>
						<span>{m.livetv_epgStatus_accountDetails({ count: status.accounts.length })}</span>
						<svg
							class="h-4 w-4 transition-transform"
							class:rotate-180={detailsOpen}
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M19 9l-7 7-7-7"
							/>
						</svg>
					</button>
					<div class="collapse-content px-3 pb-3">
						<div class="space-y-2">
							{#each status.accounts as account (account.id)}
								<div class="flex items-center justify-between text-sm">
									<span class="truncate">{account.name}</span>
									<div class="flex items-center gap-2">
										{#if account.error}
											<div class="tooltip tooltip-left" data-tip={account.error}>
												<AlertTriangle class="h-4 w-4 text-error" />
											</div>
										{:else if account.hasEpg === false}
											<div
												class="tooltip tooltip-left"
												data-tip={m.livetv_epgStatus_noEpgTooltip()}
											>
												<Info class="h-4 w-4 text-warning" />
											</div>
										{:else if account.programCount > 0}
											<Check class="h-4 w-4 text-success" />
										{/if}
										<span class="text-base-content/60"
											>{m.livetv_epgSourcePicker_programsCount({
												count: account.programCount
											})}</span
										>
									</div>
								</div>
							{/each}
						</div>
					</div>
				</div>
			{:else}
				<div class="mt-3 text-center text-sm text-base-content/50">
					{m.livetv_epgStatus_noAccounts()}
				</div>
			{/if}
		{:else}
			<div class="mt-3 text-center text-sm text-base-content/50">
				{m.livetv_epgStatus_unableToLoad()}
			</div>
		{/if}
	</div>
</div>
