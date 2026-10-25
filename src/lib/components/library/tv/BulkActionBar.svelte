<script lang="ts">
	import { X, Download, Loader2, Captions, RefreshCw } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		selectedCount: number;
		searching: boolean;
		subtitleAutoSearching?: boolean;
		subtitleSyncing?: boolean;
		onSearch: () => void;
		onClear: () => void;
		onSubtitleAutoSearch?: () => void;
		onSubtitleSync?: () => void;
	}

	let {
		selectedCount,
		searching,
		subtitleAutoSearching = false,
		subtitleSyncing = false,
		onSearch,
		onClear,
		onSubtitleAutoSearch,
		onSubtitleSync
	}: Props = $props();
</script>

{#if selectedCount > 0}
	<div
		class="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] left-4 z-50 mx-auto max-w-fit"
	>
		<div
			class="flex items-center gap-3 rounded-full border border-base-content/10 bg-base-300 px-4 py-2.5 shadow-xl sm:gap-4 sm:px-6 sm:py-3"
		>
			<span class="text-sm font-medium">
				{m.library_bulkActionBar_episodesSelected({ count: selectedCount })}
			</span>

			<div class="flex items-center gap-2">
				<button class="btn gap-2 btn-primary btn-sm" onclick={onSearch} disabled={searching}>
					{#if searching}
						<Loader2 size={16} class="animate-spin" />
						{m.common_searching()}
					{:else}
						<Download size={16} />
						{m.library_bulkActionBar_searchSelected()}
					{/if}
				</button>

				{#if onSubtitleAutoSearch}
					<button
						class="btn gap-2 btn-secondary btn-sm"
						onclick={onSubtitleAutoSearch}
						disabled={subtitleAutoSearching}
						title={m.library_bulkActionBar_autoDownloadTitle()}
					>
						{#if subtitleAutoSearching}
							<Loader2 size={16} class="animate-spin" />
							{m.common_downloading()}
						{:else}
							<Captions size={16} />
							<span class="hidden sm:inline">{m.library_bulkActionBar_autoDownloadSubs()}</span>
							<span class="sm:hidden">{m.library_bulkActionBar_subsShort()}</span>
						{/if}
					</button>
				{/if}

				{#if onSubtitleSync}
					<button
						class="btn gap-2 btn-outline btn-sm"
						onclick={onSubtitleSync}
						disabled={subtitleSyncing}
						title={m.library_bulkActionBar_syncTitle()}
					>
						{#if subtitleSyncing}
							<Loader2 size={16} class="animate-spin" />
							{m.common_syncing()}
						{:else}
							<RefreshCw size={16} />
							<span class="hidden sm:inline">{m.library_bulkActionBar_syncSubs()}</span>
							<span class="sm:hidden">{m.library_bulkActionBar_syncShort()}</span>
						{/if}
					</button>
				{/if}

				<button
					class="btn btn-circle btn-ghost btn-sm"
					onclick={onClear}
					title={m.action_clearSelection()}
				>
					<X size={16} />
				</button>
			</div>
		</div>
	</div>
{/if}
