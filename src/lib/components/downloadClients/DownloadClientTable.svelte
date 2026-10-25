<script lang="ts">
	import {
		ChevronDown,
		ChevronUp,
		Settings,
		Trash2,
		ToggleLeft,
		ToggleRight,
		Server,
		FlaskConical,
		Loader2
	} from '@lucide/svelte';
	import type { UnifiedClientItem } from '#lib/types/downloadClient.js';
	import DownloadClientStatusBadge from './DownloadClientStatusBadge.svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		clients: UnifiedClientItem[];
		selectedIds: Set<string>;
		onSelect: (id: string, selected: boolean) => void;
		onSelectAll: (selected: boolean) => void;
		onEdit: (client: UnifiedClientItem) => void;
		onDelete: (client: UnifiedClientItem) => void;
		onToggle: (client: UnifiedClientItem) => void;
		sort: {
			column: 'status' | 'name' | 'protocol';
			direction: 'asc' | 'desc';
		};
		onSort: (column: 'status' | 'name' | 'protocol') => void;
		onTest?: (client: UnifiedClientItem) => Promise<void>;
		testingId?: string | null;
	}

	let {
		clients,
		selectedIds,
		onSelect,
		onSelectAll,
		onEdit,
		onDelete,
		onToggle,
		sort,
		onSort,
		onTest,
		testingId = null
	}: Props = $props();

	function getProtocolLabel(implementation: UnifiedClientItem['implementation']): string {
		switch (implementation) {
			case 'sabnzbd':
			case 'nzbget':
				return m.common_usenet();
			case 'realdebrid':
			case 'torbox':
				return m.downloadClient_protocol_debrid();
			default:
				return m.common_torrent();
		}
	}

	function getDownloaderTypeLabel(implementation: UnifiedClientItem['implementation']): string {
		switch (implementation) {
			case 'qbittorrent':
				return m.downloadClient_qbittorrent();
			case 'sabnzbd':
				return m.downloadClient_sabnzbd();
			case 'nzbget':
				return m.downloadClient_nzbget();
			case 'transmission':
				return m.downloadClient_transmission();
			case 'deluge':
				return m.downloadClient_deluge();
			case 'rtorrent':
				return m.downloadClient_rtorrent();
			case 'aria2':
				return m.downloadClient_aria2();
			case 'realdebrid':
				return m.downloadClient_realdebrid();
			case 'torbox':
				return m.downloadClient_torbox();
			default:
				return implementation;
		}
	}

	function isSortedBy(column: 'status' | 'name' | 'protocol'): boolean {
		return sort.column === column;
	}

	function isAscending(): boolean {
		return sort.direction === 'asc';
	}

	function getClientUrl(client: UnifiedClientItem): string {
		const path = client.urlBase ? `/${client.urlBase.replace(/^\/+/, '')}` : '';
		return `${client.useSsl ? 'https' : 'http'}://${client.host}:${client.port}${path}`;
	}

	function isDebrid(client: UnifiedClientItem): boolean {
		return client.implementation === 'realdebrid' || client.implementation === 'torbox';
	}

	/** Debrid clients have a fixed provider API host, no port/SSL/urlBase to compose. */
	function getDebridHost(client: UnifiedClientItem): string {
		return client.host;
	}

	const allSelected = $derived(clients.length > 0 && clients.every((c) => selectedIds.has(c.id)));
	const someSelected = $derived(clients.some((c) => selectedIds.has(c.id)) && !allSelected);
</script>

{#if clients.length === 0}
	<div class="py-12 text-center text-base-content/60">
		<Server class="mx-auto mb-4 h-12 w-12 opacity-40" />
		<p class="text-lg font-medium">{m.settings_integrations_downloadClients_emptyTitle()}</p>
		<p class="mt-1 text-sm">{m.settings_integrations_downloadClients_emptyDescription()}</p>
	</div>
{:else}
	<div class="space-y-3 overflow-x-hidden sm:hidden">
		<div class="rounded-lg border border-base-300/80 bg-base-100 px-3 py-2 shadow-sm">
			<div class="flex items-center justify-between gap-2">
				<label class="flex items-center gap-2 text-xs font-medium">
					<input
						type="checkbox"
						class="checkbox checkbox-sm checkbox-primary"
						checked={allSelected}
						indeterminate={someSelected}
						onchange={(e) => onSelectAll(e.currentTarget.checked)}
					/>
					{m.action_selectAll()}
				</label>
				<span class="text-xs text-base-content/60"
					>{m.common_selected({ count: selectedIds.size })}</span
				>
			</div>
		</div>

		{#each clients as client (client.id)}
			<div
				class="rounded-xl border bg-base-100 p-3 transition-all duration-150 {selectedIds.has(
					client.id
				)
					? 'border-primary/50 ring-1 ring-primary/30'
					: 'border-base-300/80'}"
			>
				<div class="mb-2 flex items-start gap-2.5">
					<input
						type="checkbox"
						class="checkbox checkbox-sm checkbox-primary"
						checked={selectedIds.has(client.id)}
						onchange={(e) => onSelect(client.id, e.currentTarget.checked)}
					/>
					<div class="min-w-0 flex-1">
						<div class="flex items-start justify-between gap-2">
							<button
								class="block min-w-0 flex-1 link truncate text-left text-sm font-bold link-hover"
								onclick={() => onEdit(client)}
							>
								{client.name}
							</button>
							<div class="shrink-0">
								<DownloadClientStatusBadge
									enabled={client.enabled}
									health={client.status?.health}
									consecutiveFailures={client.status?.consecutiveFailures}
									lastFailure={client.status?.lastFailure}
									lastFailureMessage={client.status?.lastFailureMessage}
								/>
							</div>
						</div>
						<div class="mt-1 truncate text-xs text-base-content/60">
							{getDownloaderTypeLabel(client.implementation)}
						</div>
					</div>
				</div>

				<div class="mb-2 flex flex-wrap items-center gap-1.5">
					<span class="badge badge-outline badge-sm">
						{getProtocolLabel(client.implementation)}
					</span>
					{#if isDebrid(client)}<span class="badge badge-ghost badge-sm"
							>{m.common_movies()}: {client.allowMovies === false ? '✗' : '✓'}</span
						>
						<span class="badge badge-ghost badge-sm"
							>{m.common_tvShows()}: {client.allowTv === false ? '✗' : '✓'}</span
						>{:else}<span class="badge badge-ghost badge-sm"
							>{m.common_movies()}: {client.movieCategory ?? '-'}</span
						>
						<span class="badge badge-ghost badge-sm"
							>{m.common_tvShows()}: {client.tvCategory ?? '-'}</span
						>{/if}
				</div>

				<div
					class="mb-3 min-w-0 truncate font-mono text-xs text-base-content/60"
					title={isDebrid(client) ? getDebridHost(client) : getClientUrl(client)}
				>
					{isDebrid(client) ? getDebridHost(client) : getClientUrl(client)}
				</div>

				<div class="grid gap-1.5 {onTest ? 'grid-cols-4' : 'grid-cols-3'}">
					{#if onTest}
						<button
							class="btn btn-ghost btn-xs"
							onclick={() => onTest(client)}
							title={m.action_testConnection()}
							aria-label={m.action_testConnection()}
							disabled={testingId === client.id}
						>
							{#if testingId === client.id}
								<Loader2 class="h-4 w-4 animate-spin" />
							{:else}
								<FlaskConical class="h-4 w-4" />
							{/if}
						</button>
					{/if}
					<button
						class="btn btn-ghost btn-xs"
						onclick={() => onToggle(client)}
						title={client.enabled ? m.action_disable() : m.action_enable()}
						aria-label={client.enabled ? m.aria_disableClient() : m.aria_enableClient()}
						disabled={testingId === client.id}
					>
						{#if client.enabled}
							<ToggleRight class="h-4 w-4 text-success" />
						{:else}
							<ToggleLeft class="h-4 w-4" />
						{/if}
					</button>
					<button
						class="btn btn-ghost btn-xs"
						onclick={() => onEdit(client)}
						title={m.action_edit()}
						aria-label={m.aria_editClient()}
					>
						<Settings class="h-4 w-4" />
					</button>
					<button
						class="btn btn-ghost text-error btn-xs"
						onclick={() => onDelete(client)}
						title={m.action_delete()}
						aria-label={m.aria_deleteClient()}
					>
						<Trash2 class="h-4 w-4" />
					</button>
				</div>
			</div>
		{/each}
	</div>

	<div class="hidden overflow-x-auto sm:block">
		<table class="table table-sm">
			<thead>
				<tr>
					<th class="w-10">
						<input
							type="checkbox"
							class="checkbox checkbox-sm checkbox-primary"
							checked={allSelected}
							indeterminate={someSelected}
							onchange={(e) => onSelectAll(e.currentTarget.checked)}
						/>
					</th>
					<th>
						<button
							class="flex items-center gap-1 hover:text-primary"
							onclick={() => onSort('status')}
						>
							{m.common_status()}
							{#if isSortedBy('status')}
								{#if isAscending()}
									<ChevronUp class="h-3 w-3" />
								{:else}
									<ChevronDown class="h-3 w-3" />
								{/if}
							{/if}
						</button>
					</th>
					<th>
						<button
							class="flex items-center gap-1 hover:text-primary"
							onclick={() => onSort('name')}
						>
							{m.common_name()}
							{#if isSortedBy('name')}
								{#if isAscending()}
									<ChevronUp class="h-3 w-3" />
								{:else}
									<ChevronDown class="h-3 w-3" />
								{/if}
							{/if}
						</button>
					</th>
					<th>{m.settings_integrations_downloadClients_downloaderColumn()}</th>
					<th>
						<button
							class="flex items-center gap-1 hover:text-primary"
							onclick={() => onSort('protocol')}
						>
							{m.common_protocol()}
							{#if isSortedBy('protocol')}
								{#if isAscending()}
									<ChevronUp class="h-3 w-3" />
								{:else}
									<ChevronDown class="h-3 w-3" />
								{/if}
							{/if}
						</button>
					</th>
					<th>{m.common_host()}</th>
					<th>{m.common_categories()}</th>
					<th class="pl-4! text-start">{m.common_actions()}</th>
				</tr>
			</thead>
			<tbody>
				{#each clients as client (client.id)}
					<tr class="hover">
						<td class="w-10">
							<input
								type="checkbox"
								class="checkbox checkbox-sm checkbox-primary"
								checked={selectedIds.has(client.id)}
								onchange={(e) => onSelect(client.id, e.currentTarget.checked)}
							/>
						</td>
						<td>
							<DownloadClientStatusBadge
								enabled={client.enabled}
								health={client.status?.health}
								consecutiveFailures={client.status?.consecutiveFailures}
								lastFailure={client.status?.lastFailure}
								lastFailureMessage={client.status?.lastFailureMessage}
							/>
						</td>
						<td>
							<div class="font-bold">{client.name}</div>
						</td>
						<td>{getDownloaderTypeLabel(client.implementation)}</td>
						<td>
							<span class="badge badge-outline badge-sm"
								>{getProtocolLabel(client.implementation)}</span
							>
						</td>
						<td>
							<div class="font-mono text-sm">
								{isDebrid(client) ? getDebridHost(client) : getClientUrl(client)}
							</div>
						</td>
						<td>
							<div class="flex flex-col gap-1">
								{#if isDebrid(client)}
									<span class="badge badge-ghost badge-sm"
										>{m.common_movies()}: {client.allowMovies === false ? '✗' : '✓'}</span
									>
									<span class="badge badge-ghost badge-sm"
										>{m.common_tvShows()}: {client.allowTv === false ? '✗' : '✓'}</span
									>
								{:else}
									<span class="badge badge-ghost badge-sm"
										>{m.common_movies()}: {client.movieCategory ?? '-'}</span
									>
									<span class="badge badge-ghost badge-sm"
										>{m.common_tvShows()}: {client.tvCategory ?? '-'}</span
									>
								{/if}
							</div>
						</td>
						<td class="pl-4!">
							<div class="flex gap-0">
								{#if onTest}
									<button
										class="btn btn-ghost btn-xs"
										onclick={() => onTest(client)}
										title={m.action_testConnection()}
										disabled={testingId === client.id}
									>
										{#if testingId === client.id}
											<Loader2 class="h-4 w-4 animate-spin" />
										{:else}
											<FlaskConical class="h-4 w-4" />
										{/if}
									</button>
								{/if}
								<button
									class="btn btn-ghost btn-xs"
									onclick={() => onToggle(client)}
									title={client.enabled ? m.action_disable() : m.action_enable()}
									disabled={testingId === client.id}
								>
									{#if client.enabled}
										<ToggleRight class="h-4 w-4 text-success" />
									{:else}
										<ToggleLeft class="h-4 w-4" />
									{/if}
								</button>
								<button
									class="btn btn-ghost btn-xs"
									onclick={() => onEdit(client)}
									title={m.action_editClient()}
								>
									<Settings class="h-4 w-4" />
								</button>
								<button
									class="btn btn-ghost text-error btn-xs"
									onclick={() => onDelete(client)}
									title={m.action_deleteClient()}
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
