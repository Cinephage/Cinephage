<script lang="ts">
	import {
		RefreshCw,
		AlertTriangle,
		Check,
		Info,
		Loader2,
		Clock,
		Database,
		X
	} from '@lucide/svelte';
	import type { EpgStatus } from '#lib/types/livetv.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		status: EpgStatus | null;
		loading: boolean;
		syncingAll: boolean;
		syncingAccountIds: string[];
		cancelRequestedAll: boolean;
		cancelRequestedAccountIds: string[];
		onSync: () => void;
		onSyncAccount: (accountId: string) => void;
		onCancel: () => void;
		onCancelAccount: (accountId: string) => void;
	}

	let {
		status,
		loading,
		syncingAll,
		syncingAccountIds,
		cancelRequestedAll,
		cancelRequestedAccountIds,
		onSync,
		onSyncAccount,
		onCancel,
		onCancelAccount
	}: Props = $props();

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

	function compactMessage(message: string | undefined, maxLength = 140): string {
		if (!message) return m.livetv_epgStatusPanel_unknownError();
		const compact = message.replace(/\s+/g, ' ').trim();
		if (compact.length <= maxLength) return compact;
		return `${compact.slice(0, maxLength - 1)}...`;
	}

	async function handleSyncAccount(accountId: string) {
		await onSyncAccount(accountId);
	}

	async function handleCancel() {
		await onCancel();
	}

	async function handleCancelAccount(accountId: string) {
		await onCancelAccount(accountId);
	}

	const syncingAccountIdSet = $derived(new Set(syncingAccountIds));
	const cancelRequestedAccountIdSet = $derived(new Set(cancelRequestedAccountIds));
	const hasAccountSyncRunning = $derived(syncingAccountIds.length > 0);
	const anySyncing = $derived(syncingAll || hasAccountSyncRunning);

	const accountsWithError = $derived(status?.accounts.filter((a) => a.error).length ?? 0);
	const accountsWithoutEpg = $derived(
		status?.accounts.filter((a) => {
			if (a.hasEpg !== false) return false;
			if (syncingAll) return false;
			return !syncingAccountIdSet.has(a.id);
		}).length ?? 0
	);
	const syncErrors = $derived(
		status?.accounts
			.filter((a) => Boolean(a.error))
			.map((a) => ({
				id: a.id,
				name: a.name,
				message: compactMessage(a.error)
			})) ?? []
	);
	const syncWarnings = $derived(
		status?.accounts
			.filter((a) => {
				if (a.error || a.hasEpg !== false) return false;
				if (syncingAll) return false;
				return !syncingAccountIdSet.has(a.id);
			})
			.map((a) => ({
				id: a.id,
				name: a.name,
				message: m.livetv_epgStatusPanel_noEpgDataMessage()
			})) ?? []
	);
</script>

<div class="space-y-6">
	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="h-8 w-8 animate-spin text-primary" />
		</div>
	{:else if status}
		<!-- Summary cards -->
		<div class="grid gap-4 sm:grid-cols-3">
			<div class="card bg-base-200">
				<div class="card-body p-4">
					<div class="flex items-center gap-3">
						<div class="rounded-lg bg-primary/10 p-2">
							<Database class="h-5 w-5 text-primary" />
						</div>
						<div>
							<div class="text-2xl font-bold">{status.totalPrograms.toLocaleString(undefined)}</div>
							<div class="text-sm text-base-content/60">
								{m.livetv_epgStatusPanel_totalPrograms({ count: status.totalPrograms })}
							</div>
						</div>
					</div>
				</div>
			</div>

			<div class="card bg-base-200">
				<div class="card-body p-4">
					<div class="flex items-center gap-3">
						<div class="rounded-lg bg-success/10 p-2">
							<Check class="h-5 w-5 text-success" />
						</div>
						<div>
							<div class="text-lg font-bold">{formatRelativeTime(status.lastSyncAt)}</div>
							<div class="text-sm text-base-content/60">{m.livetv_epgStatusPanel_lastSync()}</div>
						</div>
					</div>
				</div>
			</div>

			<div class="card bg-base-200">
				<div class="card-body p-4">
					<div class="flex items-center gap-3">
						<div class="rounded-lg bg-info/10 p-2">
							<Clock class="h-5 w-5 text-info" />
						</div>
						<div>
							<div class="text-lg font-bold">{formatFutureTime(status.nextSyncAt)}</div>
							<div class="text-sm text-base-content/60">{m.livetv_epgStatusPanel_nextSync()}</div>
						</div>
					</div>
				</div>
			</div>
		</div>

		{#if syncErrors.length > 0 || syncWarnings.length > 0}
			<div class="space-y-2">
				{#if syncErrors.length > 0}
					<div class="alert alert-error">
						<AlertTriangle class="h-5 w-5 shrink-0" />
						<div class="min-w-0 space-y-1">
							<div class="font-medium">
								{#if syncErrors.length === 1}
									{m.livetv_epgStatusPanel_errorTitle({ count: syncErrors.length })}
								{:else}
									{m.livetv_epgStatusPanel_errorTitlePlural({ count: syncErrors.length })}
								{/if}
							</div>
							<div class="space-y-1 text-sm">
								{#each syncErrors.slice(0, 3) as issue (issue.id)}
									<div class="truncate">
										<span class="font-medium">{issue.name}:</span>
										{issue.message}
									</div>
								{/each}
								{#if syncErrors.length > 3}
									<div class="text-xs opacity-80">
										{m.livetv_epgStatusPanel_moreAccountIssues({ count: syncErrors.length - 3 })}
									</div>
								{/if}
							</div>
						</div>
					</div>
				{/if}

				{#if syncWarnings.length > 0}
					<div class="alert alert-warning">
						<Info class="h-5 w-5 shrink-0" />
						<div class="min-w-0 space-y-1">
							<div class="font-medium">
								{#if syncWarnings.length === 1}
									{m.livetv_epgStatusPanel_warningTitle({ count: syncWarnings.length })}
								{:else}
									{m.livetv_epgStatusPanel_warningTitlePlural({ count: syncWarnings.length })}
								{/if}
							</div>
							<div class="space-y-1 text-sm">
								{#each syncWarnings.slice(0, 3) as issue (issue.id)}
									<div class="truncate">
										<span class="font-medium">{issue.name}:</span>
										{issue.message}
									</div>
								{/each}
								{#if syncWarnings.length > 3}
									<div class="text-xs opacity-80">
										{m.livetv_epgStatusPanel_moreAccountWarnings({
											count: syncWarnings.length - 3
										})}
									</div>
								{/if}
							</div>
						</div>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Sync all button -->
		<div class="flex items-center justify-between">
			<div class="flex items-center gap-2">
				<h3 class="font-semibold">{m.livetv_epgStatusPanel_accountsHeading()}</h3>
				{#if accountsWithError > 0}
					<div class="badge badge-sm badge-error">
						{m.livetv_epgStatus_errorBadge({ count: accountsWithError })}
					</div>
				{/if}
				{#if accountsWithoutEpg > 0}
					<div class="badge badge-sm badge-warning">
						{m.livetv_epgStatus_noEpgBadge({ count: accountsWithoutEpg })}
					</div>
				{/if}
			</div>
			<div class="flex items-center gap-2">
				{#if anySyncing}
					<button
						class="btn btn-outline btn-error btn-sm"
						onclick={handleCancel}
						disabled={cancelRequestedAll}
					>
						{#if cancelRequestedAll}
							<Loader2 class="h-4 w-4 animate-spin" />
							{m.livetv_epgStatusPanel_cancelling()}
						{:else}
							<X class="h-4 w-4" />
							{m.livetv_epgStatusPanel_cancelSync()}
						{/if}
					</button>
				{/if}
				<button class="btn btn-primary btn-sm" onclick={onSync} disabled={anySyncing}>
					{#if syncingAll}
						<Loader2 class="h-4 w-4 animate-spin" />
						{m.livetv_epgStatusPanel_syncingAll()}
					{:else if hasAccountSyncRunning}
						<Loader2 class="h-4 w-4 animate-spin" />
						{m.livetv_epgStatusPanel_syncInProgress()}
					{:else}
						<RefreshCw class="h-4 w-4" />
						{m.livetv_epgStatusPanel_syncAll()}
					{/if}
				</button>
			</div>
		</div>

		<!-- Account list -->
		{#if status.accounts && status.accounts.length > 0}
			<div class="space-y-2">
				{#each status.accounts as account (account.id)}
					{@const isAccountSyncing = syncingAll || syncingAccountIdSet.has(account.id)}
					{@const isCancelRequested =
						cancelRequestedAll || cancelRequestedAccountIdSet.has(account.id)}
					<div class="card bg-base-200">
						<div class="card-body flex-row items-center justify-between p-4">
							<div class="flex items-center gap-4">
								<div class="flex items-center gap-2">
									{#if isAccountSyncing}
										<Loader2 class="h-5 w-5 animate-spin text-primary" />
									{:else if account.error}
										<div class="tooltip" data-tip={account.error}>
											<AlertTriangle class="h-5 w-5 text-error" />
										</div>
									{:else if account.hasEpg === false}
										<div class="tooltip" data-tip={m.livetv_epgStatus_noEpgTooltip()}>
											<Info class="h-5 w-5 text-warning" />
										</div>
									{:else if account.programCount > 0}
										<Check class="h-5 w-5 text-success" />
									{:else}
										<div class="h-5 w-5"></div>
									{/if}
									<span class="font-medium">{account.name}</span>
								</div>
								<div class="text-sm text-base-content/60">
									{account.programCount.toLocaleString(undefined)} programs
								</div>
								{#if account.lastEpgSyncAt}
									<div class="text-sm text-base-content/50">
										{m.livetv_epgStatusPanel_syncedRelative({
											time: formatRelativeTime(account.lastEpgSyncAt)
										})}
									</div>
								{/if}
							</div>
							<button
								class="btn btn-ghost btn-sm"
								onclick={() =>
									isAccountSyncing
										? handleCancelAccount(account.id)
										: handleSyncAccount(account.id)}
								disabled={isAccountSyncing ? isCancelRequested : anySyncing}
								title={isAccountSyncing
									? isCancelRequested
										? m.livetv_epgStatusPanel_cancelRequestedTooltip()
										: m.livetv_epgStatusPanel_cancelAccountTooltip()
									: anySyncing
										? m.livetv_epgStatusPanel_syncRunningTooltip()
										: m.livetv_epgStatusPanel_syncAccountTooltip()}
							>
								{#if isAccountSyncing}
									{#if isCancelRequested}
										<Loader2 class="h-4 w-4 animate-spin" />
									{:else}
										<X class="h-4 w-4" />
									{/if}
								{:else}
									<RefreshCw class="h-4 w-4" />
								{/if}
							</button>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="py-8 text-center text-base-content/50">
				{m.livetv_epgStatusPanel_noAccounts()}
			</div>
		{/if}
	{:else}
		<div class="py-8 text-center text-base-content/50">{m.livetv_epgStatus_unableToLoad()}</div>
	{/if}
</div>
