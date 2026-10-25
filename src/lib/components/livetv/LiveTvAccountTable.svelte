<script lang="ts">
	import {
		Settings,
		Trash2,
		ToggleLeft,
		ToggleRight,
		Tv,
		Radio,
		List,
		Globe,
		FlaskConical,
		Loader2,
		Calendar,
		RefreshCw
	} from '@lucide/svelte';
	import type { LiveTvAccount, LiveTvProviderType } from '#lib/types/livetv.js';
	import * as m from '#lib/paraglide/messages.js';
	import { formatDisplayDate } from '#lib/utils/format.js';

	interface Props {
		accounts: LiveTvAccount[];
		onEdit: (account: LiveTvAccount) => void;
		onDelete: (account: LiveTvAccount) => void;
		onToggle: (account: LiveTvAccount) => void;
		onTest: (account: LiveTvAccount) => Promise<void>;
		onSync: (account: LiveTvAccount) => Promise<void>;
		testingId?: string | null;
		syncingId?: string | null;
	}

	let {
		accounts,
		onEdit,
		onDelete,
		onToggle,
		onTest,
		onSync,
		testingId = null,
		syncingId = null
	}: Props = $props();

	function maskMac(mac: string): string {
		const parts = mac.split(':');
		if (parts.length !== 6) return mac;
		return `${parts[0]}:${parts[1]}:${parts[2]}:**:**:**`;
	}

	function getProviderBadge(type: LiveTvProviderType): {
		class: string;
		text: string;
		icon: typeof Tv;
	} {
		switch (type) {
			case 'stalker':
				return { class: 'badge-primary', text: m.livetv_accountTable_providerStalker(), icon: Tv };
			case 'xstream':
				return {
					class: 'badge-secondary',
					text: m.livetv_accountTable_providerXstream(),
					icon: Radio
				};
			case 'm3u':
				return { class: 'badge-accent', text: m.livetv_accountTable_providerM3u(), icon: List };
			case 'cinephage-iptv':
				return { class: 'badge-info', text: 'Cinephage IPTV', icon: Globe };
			default:
				return { class: 'badge-ghost', text: type, icon: Tv };
		}
	}

	function getStatusBadge(account: LiveTvAccount): { class: string; text: string } {
		const errorCode = parseStreamErrorCode(account.lastTestError);
		if (errorCode === '458' || errorCode === 'blocked') {
			return { class: 'badge-error', text: 'Blocked (458)' };
		}
		if (errorCode === '456' || errorCode === '459') {
			return { class: 'badge-warning', text: 'Rate Limited (456)' };
		}
		if (errorCode === '429') {
			return { class: 'badge-warning', text: 'Too Many Requests' };
		}
		if (errorCode === '407') {
			return { class: 'badge-warning', text: 'Proxy Required (407)' };
		}

		if (account.lastTestSuccess === false) {
			return { class: 'badge-error', text: m.livetv_accountTable_statusError() };
		}

		if (account.expiresAt) {
			const expiry = new Date(account.expiresAt);
			const now = new Date();
			const daysUntilExpiry = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

			if (daysUntilExpiry < 0) {
				return { class: 'badge-error', text: m.livetv_accountTable_statusExpired() };
			}
			if (daysUntilExpiry < 30) {
				return {
					class: daysUntilExpiry < 7 ? 'badge-warning' : 'badge-info',
					text: m.livetv_accountTable_daysLeft({ count: daysUntilExpiry })
				};
			}
		}

		return { class: 'badge-success', text: m.livetv_accountTable_statusActive() };
	}

	function parseStreamErrorCode(error: string | null | undefined): string | null {
		if (!error) return null;
		if (/\b458\b/.test(error)) return '458';
		if (/\b456\b/.test(error)) return '456';
		if (/\b459\b/.test(error)) return '459';
		if (/\b429\b/.test(error)) return '429';
		if (/\b407\b/.test(error)) return '407';
		if (/blocked/i.test(error)) return 'blocked';
		if (/rate.?limit/i.test(error)) return '456';
		if (/max.?connection/i.test(error)) return '456';
		return null;
	}

	function getSyncStatusBadge(account: LiveTvAccount): { class: string; text: string } {
		const status = account.syncStatus ?? 'never';

		switch (status) {
			case 'syncing':
				return { class: 'badge-info', text: m.livetv_accountTable_syncingStatus() };
			case 'success':
				return { class: 'badge-success', text: m.livetv_accountTable_syncedStatus() };
			case 'failed':
				return { class: 'badge-error', text: m.livetv_accountTable_failedStatus() };
			case 'never':
			default:
				return { class: 'badge-warning', text: m.livetv_accountTable_neverSynced() };
		}
	}

	function getAccountSubtitle(account: LiveTvAccount): string {
		switch (account.providerType) {
			case 'stalker':
				return account.stalkerConfig?.macAddress
					? maskMac(account.stalkerConfig.macAddress)
					: m.livetv_accountTable_noMac();
			case 'xstream':
				return account.xstreamConfig?.username ?? m.livetv_accountTable_noUsername();
			case 'm3u':
				return account.m3uConfig?.url
					? m.livetv_accountTable_urlSource()
					: m.livetv_accountTable_fileUpload();
			case 'cinephage-iptv': {
				const cinephageCountries = account.cinephageIptvConfig?.countries;
				return cinephageCountries?.length
					? cinephageCountries.slice(0, 3).join(', ') + (cinephageCountries.length > 3 ? '...' : '')
					: '';
			}
			default:
				return '';
		}
	}

	function getProviderUrl(account: LiveTvAccount): string {
		switch (account.providerType) {
			case 'stalker':
				return account.stalkerConfig?.portalUrl ?? '';
			case 'xstream':
				return account.xstreamConfig?.baseUrl ?? '';
			case 'm3u':
				return account.m3uConfig?.url ?? '';
			case 'cinephage-iptv':
				return 'Cinephage API';
			default:
				return '';
		}
	}

	function getProviderLabel(type: LiveTvProviderType): string {
		switch (type) {
			case 'stalker':
				return m.livetv_accountTable_portalLabel();
			case 'xstream':
				return m.livetv_accountTable_serverLabel();
			case 'm3u':
				return m.livetv_accountTable_sourceLabel();
			default:
				return m.livetv_accountTable_sourceLabel();
		}
	}
</script>

{#if accounts.length === 0}
	<div class="py-12 text-center text-base-content/60">
		<Tv class="mx-auto mb-4 h-12 w-12 opacity-40" />
		<p class="text-lg font-medium">{m.livetv_accountTable_noAccounts()}</p>
		<p class="mt-1 text-sm">{m.livetv_accountTable_addHint()}</p>
	</div>
{:else}
	<!-- Mobile cards -->
	<div class="space-y-3 sm:hidden">
		{#each accounts as account (account.id)}
			{@const status = getStatusBadge(account)}
			{@const syncStatus = getSyncStatusBadge(account)}
			{@const providerBadge = getProviderBadge(account.providerType)}
			{@const providerUrl = getProviderUrl(account)}
			{@const ProviderIcon = providerBadge.icon}
			<div class="rounded-xl border border-base-300 bg-base-100 p-3">
				<div class="mb-3 flex items-start justify-between gap-3">
					<div class="flex min-w-0 items-center gap-3">
						<div
							class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-content"
						>
							<ProviderIcon class="h-5 w-5" />
						</div>
						<div class="min-w-0">
							<div class="truncate text-base font-bold">{account.name}</div>
							<div class="truncate font-mono text-xs opacity-60">{getAccountSubtitle(account)}</div>
						</div>
					</div>
					<span class="badge {providerBadge.class} shrink-0 gap-1 badge-sm">
						<ProviderIcon class="h-3 w-3" />
						{providerBadge.text}
					</span>
				</div>

				<div class="mb-3 space-y-1 text-xs">
					<div class="opacity-60">{getProviderLabel(account.providerType)}</div>
					{#if providerUrl}
						<div class="truncate font-mono text-sm" title={providerUrl}>{providerUrl}</div>
					{:else}
						<div class="opacity-50">-</div>
					{/if}
				</div>

				<div class="mb-3 grid grid-cols-2 gap-2 text-xs">
					<div class="rounded-lg bg-base-200 p-2">
						<div class="mb-1 opacity-60">Channels</div>
						{#if account.channelCount !== null}
							<div class="font-medium">
								{account.channelCount.toLocaleString(undefined)} channels
							</div>
							<div class="opacity-70">
								{account.categoryCount !== null ? `${account.categoryCount} categories` : '-'}
							</div>
						{:else}
							<div class="opacity-50">-</div>
						{/if}
					</div>
					<div class="rounded-lg bg-base-200 p-2">
						<div class="mb-1 opacity-60">Sync</div>
						{#if syncingId === account.id}
							<div class="flex items-center gap-1 font-medium text-info">
								<Loader2 class="h-3 w-3 animate-spin" />
								Syncing...
							</div>
						{:else}
							<div class="font-medium">{syncStatus.text}</div>
						{/if}
						{#if account.lastSyncAt}
							<div class="opacity-70">
								{formatDisplayDate(account.lastSyncAt, {
									month: 'short',
									day: 'numeric',
									hour: 'numeric',
									minute: '2-digit'
								})}
							</div>
						{/if}
					</div>
				</div>

				<div class="mb-3 flex flex-wrap items-center gap-1.5">
					<span class="badge {status.class} badge-sm">{status.text}</span>
					<span class="badge {account.enabled ? 'badge-success' : 'badge-ghost'} badge-sm">
						{account.enabled ? 'Enabled' : 'Disabled'}
					</span>
					{#if account.expiresAt}
						<span class="badge gap-1 badge-ghost badge-sm">
							<Calendar class="h-3 w-3" />
							{formatDisplayDate(account.expiresAt)}
						</span>
					{/if}
					{#if account.lastSyncError}
						<span class="badge badge-sm badge-error" title={account.lastSyncError}>Sync Error</span>
					{/if}
				</div>

				<div class="grid grid-cols-3 gap-2">
					<button
						class="btn btn-ghost btn-sm"
						onclick={() => onSync(account)}
						title="Sync channels"
						disabled={syncingId === account.id || testingId === account.id}
					>
						{#if syncingId === account.id}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else}
							<RefreshCw class="h-4 w-4" />
						{/if}
						Sync
					</button>
					<button
						class="btn btn-ghost btn-sm"
						onclick={() => onTest(account)}
						title="Test connection"
						disabled={testingId === account.id || syncingId === account.id}
					>
						{#if testingId === account.id}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else}
							<FlaskConical class="h-4 w-4" />
						{/if}
						Test
					</button>
					<button
						class="btn btn-ghost btn-sm"
						onclick={() => onToggle(account)}
						title={account.enabled ? 'Disable' : 'Enable'}
					>
						{#if account.enabled}
							<ToggleRight class="h-4 w-4 text-success" />
							Disable
						{:else}
							<ToggleLeft class="h-4 w-4" />
							Enable
						{/if}
					</button>
					<button class="btn btn-ghost btn-sm" onclick={() => onEdit(account)} title="Edit">
						<Settings class="h-4 w-4" />
						Edit
					</button>
					<button
						class="btn btn-ghost text-error btn-sm"
						onclick={() => onDelete(account)}
						title="Delete"
					>
						<Trash2 class="h-4 w-4" />
						Delete
					</button>
				</div>
			</div>
		{/each}
	</div>

	<!-- Desktop table -->
	<div class="hidden overflow-x-auto sm:block">
		<table class="table">
			<thead>
				<tr>
					<th>{m.livetv_accountTable_accountColumn()}</th>
					<th>{m.livetv_accountTable_typeColumn()}</th>
					<th>{m.livetv_accountTable_sourceColumn()}</th>
					<th>{m.livetv_accountTable_channelsColumn()}</th>
					<th>{m.livetv_accountTable_syncColumn()}</th>
					<th>{m.livetv_accountTable_expiresColumn()}</th>
					<th>{m.livetv_accountTable_statusColumn()}</th>
					<th class="text-right">{m.livetv_accountTable_actionsColumn()}</th>
				</tr>
			</thead>
			<tbody>
				{#each accounts as account (account.id)}
					{@const status = getStatusBadge(account)}
					{@const syncStatus = getSyncStatusBadge(account)}
					{@const providerBadge = getProviderBadge(account.providerType)}
					{@const providerUrl = getProviderUrl(account)}
					{@const ProviderIcon = providerBadge.icon}
					<tr class="hover">
						<td>
							<div class="flex items-center gap-3">
								<div class="placeholder avatar">
									<div
										class="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-content"
									>
										<ProviderIcon class="h-5 w-5" />
									</div>
								</div>
								<div>
									<div class="font-bold">{account.name}</div>
									<div class="font-mono text-xs opacity-50">
										{getAccountSubtitle(account)}
									</div>
								</div>
							</div>
						</td>
						<td>
							<span class="badge {providerBadge.class} gap-1 badge-sm">
								<ProviderIcon class="h-3 w-3" />
								{providerBadge.text}
							</span>
						</td>
						<td>
							{#if providerUrl}
								<div class="max-w-xs truncate font-mono text-sm" title={providerUrl}>
									{providerUrl}
								</div>
							{:else}
								<span class="text-sm opacity-50">-</span>
							{/if}
						</td>
						<td>
							{#if account.channelCount !== null}
								<div class="flex flex-col gap-1">
									<span class="badge badge-ghost badge-sm">
										{account.channelCount.toLocaleString(undefined)} channels
									</span>
									{#if account.categoryCount !== null}
										<span class="badge badge-outline badge-sm">
											{account.categoryCount} categories
										</span>
									{/if}
								</div>
							{:else}
								<span class="badge badge-ghost badge-sm">-</span>
							{/if}
						</td>
						<td>
							<div class="flex flex-col gap-1">
								{#if syncingId === account.id}
									<span class="badge gap-1 badge-sm badge-info">
										<Loader2 class="h-3 w-3 animate-spin" />
										Syncing...
									</span>
								{:else}
									<span class="badge {syncStatus.class} badge-sm">{syncStatus.text}</span>
								{/if}
								{#if account.lastSyncAt}
									<span class="text-xs opacity-50"
										>{formatDisplayDate(account.lastSyncAt, {
											month: 'short',
											day: 'numeric',
											hour: 'numeric',
											minute: '2-digit'
										})}</span
									>
								{/if}
								{#if account.lastSyncError}
									<span class="text-xs text-error" title={account.lastSyncError}>Error</span>
								{/if}
							</div>
						</td>
						<td>
							{#if account.expiresAt}
								<div class="flex items-center gap-1">
									<Calendar class="h-3 w-3 opacity-50" />
									<span class="text-sm">{formatDisplayDate(account.expiresAt)}</span>
								</div>
							{:else}
								<span class="text-sm opacity-50">-</span>
							{/if}
						</td>
						<td>
							<div class="flex flex-col gap-1">
								<span class="badge {status.class} badge-sm">{status.text}</span>
								<span class="badge {account.enabled ? 'badge-success' : 'badge-ghost'} badge-sm">
									{account.enabled ? 'Enabled' : 'Disabled'}
								</span>
							</div>
						</td>
						<td>
							<div class="flex justify-end gap-1">
								<button
									class="btn btn-ghost btn-sm"
									onclick={() => onSync(account)}
									title="Sync channels"
									disabled={syncingId === account.id || testingId === account.id}
								>
									{#if syncingId === account.id}
										<Loader2 class="h-4 w-4 animate-spin" />
									{:else}
										<RefreshCw class="h-4 w-4" />
									{/if}
								</button>
								<button
									class="btn btn-ghost btn-sm"
									onclick={() => onTest(account)}
									title="Test connection"
									disabled={testingId === account.id || syncingId === account.id}
								>
									{#if testingId === account.id}
										<Loader2 class="h-4 w-4 animate-spin" />
									{:else}
										<FlaskConical class="h-4 w-4" />
									{/if}
								</button>
								<button
									class="btn btn-ghost btn-sm"
									onclick={() => onToggle(account)}
									title={account.enabled ? 'Disable' : 'Enable'}
								>
									{#if account.enabled}
										<ToggleRight class="h-4 w-4 text-success" />
									{:else}
										<ToggleLeft class="h-4 w-4" />
									{/if}
								</button>
								<button class="btn btn-ghost btn-sm" onclick={() => onEdit(account)} title="Edit">
									<Settings class="h-4 w-4" />
								</button>
								<button
									class="btn btn-ghost text-error btn-sm"
									onclick={() => onDelete(account)}
									title="Delete"
								>
									<Trash2 class="h-4 w-4" />
								</button>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
