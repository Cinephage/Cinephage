<script lang="ts">
	import { Search } from '@lucide/svelte';
	import type { LiveTvAccount, LiveTvCategory } from '#lib/types/livetv.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		accounts: LiveTvAccount[];
		categories: LiveTvCategory[];
		selectedAccountId: string;
		selectedCategoryId: string;
		searchQuery: string;
		onAccountChange: (accountId: string) => void;
		onCategoryChange: (categoryId: string) => void;
		onSearchInput: (value: string) => void;
	}

	let {
		accounts,
		categories,
		selectedAccountId,
		selectedCategoryId,
		searchQuery,
		onAccountChange,
		onCategoryChange,
		onSearchInput
	}: Props = $props();
</script>

<div class="mb-4 flex flex-wrap items-center gap-3">
	<select
		class="select-bordered select w-full select-sm sm:w-48"
		value={selectedAccountId}
		onchange={(e) => onAccountChange(e.currentTarget.value)}
	>
		<option value="">{m.livetv_channelBrowserModal_allAccounts()}</option>
		{#each accounts as account (account.id)}
			<option value={account.id}>
				{account.name}
				{#if account.channelCount}({account.channelCount.toLocaleString(undefined)}){/if}
			</option>
		{/each}
	</select>

	<select
		class="select-bordered select w-full select-sm sm:w-48"
		value={selectedCategoryId}
		onchange={(e) => onCategoryChange(e.currentTarget.value)}
		disabled={!selectedAccountId}
	>
		<option value="">{m.livetv_channelBrowserModal_allCategories()}</option>
		{#each categories as category (category.id)}
			<option value={category.id}>
				{category.title}
				({category.channelCount})
			</option>
		{/each}
	</select>

	<div class="relative flex-1">
		<Search
			class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/40"
		/>
		<input
			type="text"
			placeholder={m.livetv_channelBrowserModal_searchPlaceholder()}
			class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-4 pl-9 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
			value={searchQuery}
			oninput={(e) => onSearchInput(e.currentTarget.value)}
		/>
	</div>
</div>
