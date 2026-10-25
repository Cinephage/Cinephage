<script lang="ts">
	import { X, Loader2, Search, Tv } from '@lucide/svelte';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { getChannelsWithEpg } from '#lib/api/livetv.js';
	import * as m from '#lib/paraglide/messages.js';

	interface ChannelWithEpg {
		id: string;
		accountId: string;
		name: string;
		number: string | null;
		logo: string | null;
		categoryTitle: string | null;
		accountName: string;
		programCount: number;
	}

	interface Props {
		open: boolean;
		excludeChannelId?: string;
		onClose: () => void;
		onSelect: (channelId: string, channel: ChannelWithEpg) => void;
	}

	let { open, excludeChannelId, onClose, onSelect }: Props = $props();

	// Data state
	let channels = $state<ChannelWithEpg[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);

	// Search state
	let searchQuery = $state('');
	let debouncedSearch = $state('');
	let searchDebounceTimer: ReturnType<typeof setTimeout>;

	// Track modal open state for transition detection
	let wasOpen = $state(false);

	// Reset state when modal opens
	$effect(() => {
		const justOpened = open && !wasOpen;
		wasOpen = open;

		if (justOpened) {
			searchQuery = '';
			debouncedSearch = '';
			error = null;
			loadChannels();
		}
	});

	// Debounce search input
	$effect(() => {
		const query = searchQuery;
		clearTimeout(searchDebounceTimer);
		searchDebounceTimer = setTimeout(() => {
			if (debouncedSearch !== query) {
				debouncedSearch = query;
				loadChannels();
			}
		}, 300);
	});

	async function loadChannels() {
		loading = true;
		error = null;

		try {
			const data = (await getChannelsWithEpg()) as { items?: ChannelWithEpg[] };
			// Filter by search query client-side and exclude the target channel
			const filtered = (data.items || []).filter((c: ChannelWithEpg) => c.id !== excludeChannelId);
			if (debouncedSearch) {
				const q = debouncedSearch.toLowerCase();
				channels = filtered.filter(
					(c: ChannelWithEpg) =>
						c.name.toLowerCase().includes(q) || (c.number || '').toLowerCase().includes(q)
				);
			} else {
				channels = filtered;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : m.livetv_epgSourcePicker_failedToLoad();
			channels = [];
		} finally {
			loading = false;
		}
	}

	function handleSelect(channel: ChannelWithEpg) {
		onSelect(channel.id, channel);
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="2xl" labelledBy="epg-source-picker-modal-title">
	<!-- Header -->
	<div class="mb-4 flex items-center justify-between">
		<h3 id="epg-source-picker-modal-title" class="text-lg font-bold">
			{m.livetv_epgSourcePicker_title()}
		</h3>
		<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
			<X class="h-4 w-4" />
		</button>
	</div>

	<p class="mb-4 text-sm text-base-content/60">
		{m.livetv_epgSourcePicker_description()}
	</p>

	<!-- Search -->
	<div class="form-control mb-4">
		<div class="relative">
			<Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/50" />
			<input
				type="text"
				class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-4 pl-10 transition-all duration-200 placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
				placeholder={m.livetv_epgSourcePicker_searchPlaceholder()}
				bind:value={searchQuery}
			/>
		</div>
	</div>

	<!-- Error -->
	{#if error}
		<div class="mb-4 alert alert-error">
			<span>{error}</span>
		</div>
	{/if}

	<!-- Channel list -->
	<div class="max-h-96 overflow-y-auto">
		{#if loading}
			<div class="flex justify-center py-8">
				<Loader2 class="h-6 w-6 animate-spin text-base-content/50" />
			</div>
		{:else if channels.length === 0}
			<div class="py-8 text-center text-base-content/50">
				{#if debouncedSearch}
					{m.livetv_epgSourcePicker_noResults({ query: debouncedSearch })}
				{:else}
					{m.livetv_epgSourcePicker_noChannelsAvailable()}
				{/if}
			</div>
		{:else}
			<div class="space-y-1">
				{#each channels as channel (channel.id)}
					<button
						type="button"
						class="flex w-full items-center gap-3 rounded-lg p-3 transition-colors hover:bg-base-200"
						onclick={() => handleSelect(channel)}
					>
						{#if channel.logo}
							<img src={channel.logo} alt="" class="h-10 w-10 rounded bg-base-300 object-contain" />
						{:else}
							<div class="flex h-10 w-10 items-center justify-center rounded bg-base-300">
								<Tv class="h-5 w-5 text-base-content/30" />
							</div>
						{/if}
						<div class="min-w-0 flex-1 text-left">
							<div class="truncate font-medium">{channel.name}</div>
							<div class="flex items-center gap-2 text-xs text-base-content/50">
								<span>{channel.accountName}</span>
								<span>-</span>
								<span
									>{m.livetv_epgSourcePicker_programsCount({ count: channel.programCount })}</span
								>
							</div>
						</div>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Footer -->
	<div class="modal-action">
		<button class="btn btn-ghost" onclick={onClose}>{m.action_cancel()}</button>
	</div>
</ModalWrapper>
