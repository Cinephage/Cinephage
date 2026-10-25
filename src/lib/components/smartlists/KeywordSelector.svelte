<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Loader2, Plus, X } from '@lucide/svelte';
	import { getSmartListHelpers } from '#lib/api/smartlists.js';

	interface KeywordResult {
		id: number;
		name: string;
	}

	interface SelectedKeyword {
		id: number;
		name: string;
		exclude: boolean;
	}

	interface Props {
		selectedKeywords: SelectedKeyword[];
		onAddKeyword: (keyword: KeywordResult, exclude: boolean) => void;
		onRemoveKeyword: (keywordId: number, exclude: boolean) => void;
	}

	let { selectedKeywords, onAddKeyword, onRemoveKeyword }: Props = $props();

	let query = $state('');
	let results = $state<KeywordResult[]>([]);
	let searching = $state(false);
	let searchTimer: ReturnType<typeof setTimeout>;

	async function searchKeywords() {
		if (query.length < 2) {
			results = [];
			return;
		}
		searching = true;
		try {
			const res = await getSmartListHelpers({ helper: 'keywords', q: query });
			results = Array.isArray(res) ? res : [];
		} finally {
			searching = false;
		}
	}

	function handleInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(searchKeywords, 300);
	}

	function addKeyword(keyword: KeywordResult, exclude: boolean) {
		onAddKeyword(keyword, exclude);
		query = '';
		results = [];
	}
</script>

<div class="form-control">
	<div class="label py-1">
		<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase">
			{m.smartlists_filter_keywords()}
		</span>
	</div>
	<div class="relative">
		<input
			type="text"
			bind:value={query}
			oninput={handleInput}
			placeholder={m.smartlists_filter_keywordsPlaceholder()}
			class="input-bordered input w-full input-sm"
		/>
		{#if searching}
			<Loader2 class="absolute top-2 right-3 h-4 w-4 animate-spin" />
		{/if}
	</div>
	{#if results.length > 0}
		<div class="mt-1 max-h-32 overflow-y-auto rounded-lg border border-base-300 bg-base-100">
			{#each results as keyword (keyword.id)}
				<div class="flex items-center justify-between border-b border-base-200 p-2 last:border-0">
					<span class="text-sm">{keyword.name}</span>
					<div class="flex gap-1">
						<button
							type="button"
							class="btn btn-success btn-xs"
							onclick={() => addKeyword(keyword, false)}
							title={m.smartlists_filter_include()}
						>
							<Plus class="h-3 w-3" />
						</button>
						<button
							type="button"
							class="btn btn-error btn-xs"
							onclick={() => addKeyword(keyword, true)}
							title={m.smartlists_filter_exclude()}
						>
							<X class="h-3 w-3" />
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
	{#if selectedKeywords.length > 0}
		<div class="mt-2 flex flex-wrap gap-1">
			{#each selectedKeywords as kw (kw.id + (kw.exclude ? '-ex' : ''))}
				<span class="badge {kw.exclude ? 'badge-error' : 'badge-success'} gap-1">
					{kw.name}
					<button type="button" onclick={() => onRemoveKeyword(kw.id, kw.exclude)}>
						<X class="h-3 w-3" />
					</button>
				</span>
			{/each}
		</div>
	{/if}
</div>
