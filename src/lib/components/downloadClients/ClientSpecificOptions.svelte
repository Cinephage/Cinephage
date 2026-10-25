<script lang="ts">
	import { Clock, Check } from '@lucide/svelte';
	import type { DownloadClientDefinition } from '#lib/types/downloadClient.js';
	import NntpServerSettings from './forms/NntpServerSettings.svelte';
	import DownloadClientSettings from './forms/DownloadClientSettings.svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		maxConnections: number;
		priority: number;
		movieCategory: string;
		tvCategory: string;
		recentPriority: 'normal' | 'high' | 'force';
		olderPriority: 'normal' | 'high' | 'force';
		initialState: 'start' | 'pause' | 'force';
		sequentialDownload: boolean;
		removeAfterImport: boolean;
		seedRatioLimit: string;
		seedTimeLimit: string;
		downloadPathLocal: string;
		downloadPathRemote: string;
		tempPathLocal: string;
		tempPathRemote: string;
		stalledTimeout: number;
		stalledThreshold: number;
		stalledBlocklist: number;
		saveStalledBehaviorSuccess: boolean;
		isNntpServer: boolean;
		selectedDefinition: DownloadClientDefinition | null;
		usesApiKey: boolean;
		isMountModeClient: boolean;
		onBrowse: (field: 'downloadPathLocal' | 'tempPathLocal') => void;
	}

	let {
		maxConnections = $bindable(),
		priority = $bindable(),
		movieCategory = $bindable(),
		tvCategory = $bindable(),
		recentPriority = $bindable(),
		olderPriority = $bindable(),
		initialState = $bindable(),
		sequentialDownload = $bindable(),
		removeAfterImport = $bindable(),
		seedRatioLimit = $bindable(),
		seedTimeLimit = $bindable(),
		downloadPathLocal = $bindable(),
		downloadPathRemote = $bindable(),
		tempPathLocal = $bindable(),
		tempPathRemote = $bindable(),
		stalledTimeout = $bindable(),
		stalledThreshold = $bindable(),
		stalledBlocklist = $bindable(),
		saveStalledBehaviorSuccess = $bindable(),
		isNntpServer,
		selectedDefinition = null,
		usesApiKey,
		isMountModeClient,
		onBrowse
	}: Props = $props();
</script>

{#if isNntpServer}
	<NntpServerSettings bind:maxConnections bind:priority />
{:else}
	<DownloadClientSettings
		section="categories"
		definition={selectedDefinition}
		bind:movieCategory
		bind:tvCategory
		bind:recentPriority
		bind:olderPriority
		bind:initialState
		bind:sequentialDownload
		bind:removeAfterImport
		bind:seedRatioLimit
		bind:seedTimeLimit
		bind:downloadPathLocal
		bind:downloadPathRemote
		bind:tempPathLocal
		bind:tempPathRemote
		isSabnzbd={usesApiKey}
		isMountMode={isMountModeClient}
		{onBrowse}
	/>
{/if}

<div class="rounded-lg bg-base-200/50 p-3">
	<div class="mb-2 flex items-center gap-1.5">
		<Clock class="h-3.5 w-3.5 text-base-content/50" />
		<span class="text-xs font-semibold text-base-content/70"
			>{m.downloadClientModal_stalledDownloads()}</span
		>
		<span class="badge badge-ghost badge-xs text-[10px]"
			>{m.downloadClientModal_stalledGlobal()}</span
		>
	</div>
	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
		<div class="form-control min-w-0">
			<label class="label px-0 py-1" for="stalled-timeout-modal">
				<span class="label-text text-xs whitespace-nowrap"
					>{m.downloadClientModal_stalledTimeout()}</span
				>
			</label>
			<input
				id="stalled-timeout-modal"
				type="number"
				class="input-bordered input w-full input-sm"
				min="0"
				step="5"
				bind:value={stalledTimeout}
			/>
		</div>
		<div class="form-control min-w-0">
			<label class="label px-0 py-1" for="stalled-threshold-modal">
				<span class="label-text text-xs whitespace-nowrap"
					>{m.downloadClientModal_stalledProgress()}</span
				>
			</label>
			<input
				id="stalled-threshold-modal"
				type="number"
				class="input-bordered input w-full input-sm"
				min="0"
				max="100"
				step="5"
				bind:value={stalledThreshold}
			/>
		</div>
		<div class="form-control min-w-0 sm:col-span-2">
			<label class="label px-0 py-1" for="stalled-blocklist-modal">
				<span class="label-text text-xs whitespace-nowrap"
					>{m.downloadClientModal_stalledBlocklist()}</span
				>
			</label>
			<input
				id="stalled-blocklist-modal"
				type="number"
				class="input-bordered input w-full input-sm"
				min="0"
				step="24"
				bind:value={stalledBlocklist}
			/>
		</div>
	</div>
	{#if saveStalledBehaviorSuccess}
		<p class="mt-1 flex items-center gap-1 text-xs text-success">
			<Check class="h-3 w-3" />
			{m.downloadClientModal_stalledSaved()}
		</p>
	{/if}
	<p class="mt-1 text-xs text-base-content/50">
		{#if stalledTimeout === 0}
			{m.downloadClientModal_stalledDisabled()}
		{:else}
			{m.downloadClientModal_stalledDescription({
				timeout: stalledTimeout,
				threshold: stalledThreshold
			})}
			{#if stalledBlocklist === 0}
				{m.downloadClientModal_stalledBlocklistPermanent()}
			{:else}
				{m.downloadClientModal_stalledBlocklistDescription({ hours: stalledBlocklist })}
			{/if}
		{/if}
	</p>
</div>
