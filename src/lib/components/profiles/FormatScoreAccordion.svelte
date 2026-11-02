<script lang="ts">
	import { SvelteSet, SvelteMap } from 'svelte/reactivity';
	import type { FormatCategory } from '#lib/types/format.js';
	import type { RequiredFormatEntry } from '#lib/types/profile.js';
	import * as m from '#lib/paraglide/messages.js';
	import {
		FORMAT_CATEGORY_LABELS,
		FORMAT_CATEGORY_ORDER,
		type FormatScoreEntry,
		filterFormatScores,
		countNonZeroScores
	} from '#lib/types/format.js';
	import {
		Search,
		ChevronDown,
		ChevronRight,
		Monitor,
		Users,
		Volume2,
		Sun,
		Tv,
		Minimize2,
		AlertTriangle,
		Ban,
		Sparkles,
		FileCode,
		MoreHorizontal
	} from '@lucide/svelte';

	interface Props {
		formatScores: Map<FormatCategory, FormatScoreEntry[]>;
		requiredFormats?: RequiredFormatEntry[];
		readonly?: boolean;
		onScoreChange: (formatId: string, score: number) => void;
	}

	let { formatScores, requiredFormats = [], readonly = false, onScoreChange }: Props = $props();

	const requiredFormatIds = $derived(new Set(requiredFormats.map((e) => e.id)));

	// UI state
	let searchQuery = $state('');
	const expandedCategories = new SvelteSet<FormatCategory>();

	// Filter scores by search
	const filteredScores = $derived(() => {
		const result = new SvelteMap<FormatCategory, FormatScoreEntry[]>();
		for (const [category, scores] of formatScores) {
			const filtered = filterFormatScores(scores, searchQuery);
			if (filtered.length > 0) {
				result.set(category, filtered);
			}
		}
		return result;
	});

	function toggleCategory(category: FormatCategory) {
		if (expandedCategories.has(category)) {
			expandedCategories.delete(category);
		} else {
			expandedCategories.add(category);
		}
	}

	function expandAll() {
		expandedCategories.clear();
		for (const cat of FORMAT_CATEGORY_ORDER) {
			expandedCategories.add(cat);
		}
	}

	function collapseAll() {
		expandedCategories.clear();
	}

	function handleScoreInput(formatId: string, value: string) {
		const score = parseInt(value, 10);
		if (!isNaN(score)) {
			onScoreChange(formatId, score);
		}
	}
</script>

<div class="space-y-4">
	<!-- Search and expand/collapse -->
	<div class="flex items-center gap-3">
		<div class="group relative flex-1">
			<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
				<Search
					class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
				/>
			</div>
			<input
				type="text"
				class="input w-full rounded-full border-base-content/20 bg-base-200/60 py-2 pr-4 pl-10 text-sm transition-all duration-200 placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
				placeholder={m.profiles_searchFormats()}
				bind:value={searchQuery}
			/>
		</div>

		<div class="flex gap-1">
			<button type="button" class="btn btn-ghost btn-xs" onclick={expandAll}
				>{m.action_expandAll()}</button
			>
			<button type="button" class="btn btn-ghost btn-xs" onclick={collapseAll}
				>{m.action_collapseAll()}</button
			>
		</div>
	</div>

	<!-- Category accordions -->
	<div class="space-y-2">
		{#each FORMAT_CATEGORY_ORDER as category (category)}
			{@const scores = filteredScores().get(category) || []}
			{#if scores.length > 0}
				{@const nonZeroCount = countNonZeroScores(scores)}
				{@const requiredCount = scores.filter((e) => requiredFormatIds.has(e.formatId)).length}
				<div class="rounded-lg border border-base-300 bg-base-100">
					<!-- Category header -->
					<button
						type="button"
						class="flex w-full items-center gap-2 p-3 text-left hover:bg-base-200"
						onclick={() => toggleCategory(category)}
					>
						{#if expandedCategories.has(category)}
							<ChevronDown class="h-4 w-4" />
						{:else}
							<ChevronRight class="h-4 w-4" />
						{/if}

						{#if category === 'resolution'}
							<Monitor class="h-4 w-4 text-primary" />
						{:else if category === 'release_group_tier'}
							<Users class="h-4 w-4 text-primary" />
						{:else if category === 'audio'}
							<Volume2 class="h-4 w-4 text-primary" />
						{:else if category === 'hdr'}
							<Sun class="h-4 w-4 text-primary" />
						{:else if category === 'streaming'}
							<Tv class="h-4 w-4 text-primary" />
						{:else if category === 'micro'}
							<Minimize2 class="h-4 w-4 text-primary" />
						{:else if category === 'low_quality'}
							<AlertTriangle class="h-4 w-4 text-primary" />
						{:else if category === 'banned'}
							<Ban class="h-4 w-4 text-primary" />
						{:else if category === 'enhancement'}
							<Sparkles class="h-4 w-4 text-primary" />
						{:else if category === 'codec'}
							<FileCode class="h-4 w-4 text-primary" />
						{:else}
							<MoreHorizontal class="h-4 w-4 text-primary" />
						{/if}

						<span class="flex-1 font-medium">{FORMAT_CATEGORY_LABELS[category]}</span>

						{#if requiredCount > 0}
							<span class="badge badge-sm badge-warning">{requiredCount} required</span>
						{/if}
						{#if nonZeroCount > 0}
							<span class="badge badge-sm badge-primary"
								>{m.profiles_scoredCount({ count: nonZeroCount })}</span
							>
						{/if}
						<span class="badge badge-sm">{m.profiles_formatCount({ count: scores.length })}</span>
					</button>

					<!-- Category content -->
					{#if expandedCategories.has(category)}
						<div class="border-t border-base-300">
							<div class="max-h-80 divide-y divide-base-200 overflow-y-auto">
								{#each scores as entry (entry.formatId)}
									{@const isRequired = requiredFormatIds.has(entry.formatId)}
									<div class="hover:bg-base-50 flex items-center gap-3 px-4 py-2">
										<!-- Format name -->
										<span class="min-w-0 flex-1 truncate" class:font-medium={entry.score !== 0}>
											{(m as unknown as Record<string, () => string>)[
												`format_${entry.formatId}`
											]?.() || entry.formatName}
										</span>

										{#if isRequired}
											<span class="badge shrink-0 badge-xs badge-warning">required</span>
										{/if}

										<!-- Score input -->
										<input
											type="number"
											class="input-bordered input w-20 text-right font-mono input-xs"
											class:input-primary={entry.score !== 0}
											value={entry.score}
											disabled={readonly}
											oninput={(e) => handleScoreInput(entry.formatId, e.currentTarget.value)}
										/>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			{/if}
		{/each}

		{#if filteredScores().size === 0}
			<div class="rounded-lg bg-base-200 p-8 text-center">
				<Search class="mx-auto mb-2 h-8 w-8 text-base-content/40" />
				<p class="text-base-content/60">{m.profiles_noFormatsMatchSearch()}</p>
			</div>
		{/if}
	</div>
</div>
