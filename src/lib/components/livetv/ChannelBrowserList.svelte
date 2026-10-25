<script lang="ts">
	import { Loader2, Tv, Radio, List, Plus, Check } from '@lucide/svelte';
	import type { LiveTvProviderType, CachedChannel } from '#lib/types/livetv.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		channels: CachedChannel[];
		visibleChannels: CachedChannel[];
		selectedIds: Set<string>;
		addingIds: Set<string>;
		loading: boolean;
		isBackupMode: boolean;
		addingBackup: boolean;
		isExcluded: (channelId: string) => boolean;
		isInLineup: (channelId: string) => boolean;
		allVisibleSelected: boolean;
		someVisibleSelected: boolean;
		selectableChannels: CachedChannel[];
		debouncedSearch: string;
		selectedAccountId: string;
		selectedCategoryId: string;
		onToggleSelection: (channelId: string) => void;
		onAddSingleChannel: (channel: CachedChannel) => void;
		onSelectBackup: (channel: CachedChannel) => void;
		onToggleAllVisible: () => void;
	}

	let {
		channels,
		visibleChannels,
		selectedIds,
		addingIds,
		loading,
		isBackupMode,
		addingBackup,
		isExcluded,
		isInLineup,
		allVisibleSelected,
		someVisibleSelected,
		selectableChannels,
		debouncedSearch,
		selectedAccountId,
		selectedCategoryId,
		onToggleSelection,
		onAddSingleChannel,
		onSelectBackup,
		onToggleAllVisible
	}: Props = $props();

	function getCategoryDisplayName(channel: CachedChannel): string {
		if (channel.categoryTitle) return channel.categoryTitle;
		if (channel.m3u?.groupTitle) return channel.m3u.groupTitle;
		return '-';
	}

	function getProviderBadgeInfo(type: LiveTvProviderType) {
		switch (type) {
			case 'stalker':
				return {
					class: 'badge-primary',
					icon: Tv,
					label: m.livetv_channelBrowserModal_providerStalker()
				};
			case 'xstream':
				return {
					class: 'badge-secondary',
					icon: Radio,
					label: m.livetv_channelBrowserModal_providerXstream()
				};
			case 'm3u':
				return {
					class: 'badge-accent',
					icon: List,
					label: m.livetv_channelBrowserModal_providerM3u()
				};
			default:
				return { class: 'badge-ghost', icon: Tv, label: type };
		}
	}
</script>

<div class="flex-1 overflow-auto rounded-lg border border-base-300">
	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="h-8 w-8 animate-spin text-primary" />
		</div>
	{:else if channels.length === 0}
		<div class="flex flex-col items-center justify-center py-12 text-base-content/50">
			<Tv class="mb-4 h-12 w-12" />
			<p>{m.livetv_channelBrowserModal_noChannelsFound()}</p>
			{#if debouncedSearch || selectedAccountId || selectedCategoryId}
				<p class="text-sm">{m.livetv_channelBrowserModal_tryAdjustingFilters()}</p>
			{/if}
		</div>
	{:else if visibleChannels.length === 0}
		<div class="flex flex-col items-center justify-center py-12 text-base-content/50">
			<p class="text-center text-sm">{m.livetv_channelBrowserModal_allChannelsAdded()}</p>
			<p class="text-xs">{m.livetv_channelBrowserModal_tryNextPage()}</p>
		</div>
	{:else}
		<!-- Mobile cards -->
		<div class="space-y-3 p-3 sm:hidden">
			{#each visibleChannels as channel (channel.id)}
				{@const excluded = isExcluded(channel.id)}
				{@const inLineup = isInLineup(channel.id)}
				{@const isSelected = selectedIds.has(channel.id)}
				{@const isAdding = addingIds.has(channel.id)}
				{@const providerBadge = getProviderBadgeInfo(channel.providerType)}
				<div class="rounded-xl bg-base-200 p-3 {excluded ? 'opacity-60' : ''}">
					<div class="flex items-start gap-3">
						{#if !isBackupMode}
							<input
								type="checkbox"
								class="checkbox mt-1 checkbox-sm checkbox-primary"
								checked={isSelected}
								disabled={inLineup}
								onchange={() => onToggleSelection(channel.id)}
							/>
						{/if}
						{#if channel.logo}
							<img src={channel.logo} alt="" class="h-10 w-10 rounded bg-base-200 object-contain" />
						{:else}
							<div class="flex h-10 w-10 items-center justify-center rounded bg-base-200">
								<Tv class="h-4 w-4 text-base-content/30" />
							</div>
						{/if}
						<div class="min-w-0 flex-1">
							<div class="text-sm font-medium wrap-break-word sm:text-base" title={channel.name}>
								{channel.name}
							</div>
							<div class="mt-1 text-xs text-base-content/60">
								{#if channel.number}
									#{channel.number}
									<span class="text-base-content/40">•</span>
								{/if}
								{getCategoryDisplayName(channel)}
								<span class="text-base-content/40">•</span>
								{channel.accountName || '-'}
								<span class="text-base-content/40">•</span>
								<span class="badge {providerBadge.class} gap-1 badge-xs">
									<providerBadge.icon class="h-3 w-3" />
									{providerBadge.label}
								</span>
							</div>
						</div>
						<div class="flex items-center gap-2">
							{#if isBackupMode}
								{#if excluded}
									<span class="badge badge-ghost badge-sm">Primary</span>
								{:else}
									<button
										class="btn btn-ghost btn-xs"
										onclick={() => onSelectBackup(channel)}
										disabled={addingBackup}
									>
										{#if addingBackup}
											<Loader2 class="h-3 w-3 animate-spin" />
										{:else}
											<Plus class="h-3 w-3" />
										{/if}
										{m.livetv_channelBrowserModal_select()}
									</button>
								{/if}
							{:else if inLineup}
								<span class="badge gap-1 badge-ghost badge-sm">
									<Check class="h-3 w-3" />
									{m.livetv_channelBrowserModal_added()}
								</span>
							{:else}
								<button
									class="btn btn-ghost btn-xs"
									onclick={() => onAddSingleChannel(channel)}
									disabled={isAdding}
								>
									{#if isAdding}
										<Loader2 class="h-3 w-3 animate-spin" />
									{:else}
										<Plus class="h-3 w-3" />
									{/if}
									{m.livetv_channelBrowserModal_add()}
								</button>
							{/if}
						</div>
					</div>
				</div>
			{/each}
		</div>

		<!-- Desktop table -->
		<div class="hidden sm:block">
			<table class="table table-sm">
				<thead class="sticky top-0 z-10 bg-base-200">
					<tr>
						{#if !isBackupMode}
							<th class="w-10">
								<input
									type="checkbox"
									class="checkbox checkbox-sm checkbox-primary"
									checked={allVisibleSelected}
									indeterminate={someVisibleSelected}
									disabled={selectableChannels.length === 0}
									onchange={onToggleAllVisible}
								/>
							</th>
						{/if}
						<th>{m.livetv_channelBrowserModal_columnChannel()}</th>
						<th>{m.livetv_channelBrowserModal_columnCategory()}</th>
						<th>{m.livetv_channelBrowserModal_columnAccount()}</th>
						<th>{m.livetv_channelBrowserModal_columnProvider()}</th>
						<th class="w-24">{m.livetv_channelBrowserModal_columnActions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each visibleChannels as channel (channel.id)}
						{@const excluded = isExcluded(channel.id)}
						{@const inLineup = isInLineup(channel.id)}
						{@const isSelected = selectedIds.has(channel.id)}
						{@const isAdding = addingIds.has(channel.id)}
						{@const providerBadge = getProviderBadgeInfo(channel.providerType)}

						<tr class={excluded ? 'bg-base-200/50 opacity-50' : ''}>
							{#if !isBackupMode}
								<td>
									<input
										type="checkbox"
										class="checkbox checkbox-sm checkbox-primary"
										checked={isSelected}
										disabled={inLineup}
										onchange={() => onToggleSelection(channel.id)}
									/>
								</td>
							{/if}
							<td>
								<div class="flex items-center gap-3">
									{#if channel.logo}
										<img
											src={channel.logo}
											alt=""
											class="h-8 w-8 rounded bg-base-200 object-contain"
										/>
									{:else}
										<div class="flex h-8 w-8 items-center justify-center rounded bg-base-200">
											<Tv class="h-4 w-4 text-base-content/30" />
										</div>
									{/if}
									<div>
										<p class="max-w-xs font-medium wrap-break-word" title={channel.name}>
											{channel.name}
										</p>
										{#if channel.number}
											<p class="text-xs text-base-content/50">#{channel.number}</p>
										{/if}
									</div>
								</div>
							</td>
							<td class="text-sm">{getCategoryDisplayName(channel)}</td>
							<td class="text-sm">{channel.accountName || '-'}</td>
							<td>
								<span class="badge {providerBadge.class} gap-1 badge-sm">
									<providerBadge.icon class="h-3 w-3" />
									{providerBadge.label}
								</span>
							</td>
							<td>
								{#if isBackupMode}
									{#if excluded}
										<span class="badge badge-ghost badge-sm"
											>{m.livetv_channelBrowserModal_primary()}</span
										>
									{:else}
										<button
											class="btn btn-ghost btn-xs"
											onclick={() => onSelectBackup(channel)}
											disabled={addingBackup}
										>
											{#if addingBackup}
												<Loader2 class="h-3 w-3 animate-spin" />
											{:else}
												<Plus class="h-3 w-3" />
											{/if}
											{m.livetv_channelBrowserModal_select()}
										</button>
									{/if}
								{:else if inLineup}
									<span class="badge gap-1 badge-ghost badge-sm">
										<Check class="h-3 w-3" />
										{m.livetv_channelBrowserModal_added()}
									</span>
								{:else}
									<button
										class="btn btn-ghost btn-xs"
										onclick={() => onAddSingleChannel(channel)}
										disabled={isAdding}
									>
										{#if isAdding}
											<Loader2 class="h-3 w-3 animate-spin" />
										{:else}
											<Plus class="h-3 w-3" />
										{/if}
										{m.livetv_channelBrowserModal_add()}
									</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
