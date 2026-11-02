<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { SvelteSet, SvelteMap } from 'svelte/reactivity';
	import type { UICustomFormat, FormatCategory } from '#lib/types/format.js';
	import { FORMAT_CATEGORY_LABELS, FORMAT_CATEGORY_ORDER } from '#lib/types/format.js';
	import {
		Search,
		Filter,
		Lock,
		ChevronDown,
		ChevronRight,
		Plus,
		Edit,
		Trash2,
		Eye,
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
		formats: UICustomFormat[];
		onView: (format: UICustomFormat) => void;
		onEdit: (format: UICustomFormat) => void;
		onCreate: () => void;
		onDelete: (format: UICustomFormat) => void;
	}

	let { formats, onView, onEdit, onCreate, onDelete }: Props = $props();

	// Filter state
	let searchQuery = $state('');
	let filterType = $state<'all' | 'builtin' | 'custom'>('all');
	let filterCategory = $state<FormatCategory | 'all'>('all');
	const expandedCategories = new SvelteSet<FormatCategory>();

	// Filtered formats
	const filteredFormats = $derived(() => {
		let result = formats;

		// Filter by type
		if (filterType === 'builtin') {
			result = result.filter((f) => f.isBuiltIn);
		} else if (filterType === 'custom') {
			result = result.filter((f) => !f.isBuiltIn);
		}

		// Filter by category
		if (filterCategory !== 'all') {
			result = result.filter((f) => f.category === filterCategory);
		}

		// Filter by search
		if (searchQuery) {
			const query = searchQuery.toLowerCase();
			result = result.filter(
				(f) =>
					f.name.toLowerCase().includes(query) ||
					f.description?.toLowerCase().includes(query) ||
					f.tags.some((t) => t.toLowerCase().includes(query))
			);
		}

		return result;
	});

	// Group formats by category
	const groupedFormats = $derived(() => {
		const groups = new SvelteMap<FormatCategory, UICustomFormat[]>();

		for (const format of filteredFormats()) {
			const existing = groups.get(format.category) || [];
			existing.push(format);
			groups.set(format.category, existing);
		}

		// Sort each group by name
		for (const [, list] of groups) {
			list.sort((a, b) => a.name.localeCompare(b.name));
		}

		return groups;
	});

	// Stats
	const stats = $derived(() => {
		const all = filteredFormats();
		return {
			total: all.length,
			builtin: all.filter((f) => f.isBuiltIn).length,
			custom: all.filter((f) => !f.isBuiltIn).length,
			enabled: all.filter((f) => f.enabled).length
		};
	});

	function toggleCategory(category: FormatCategory) {
		if (expandedCategories.has(category)) {
			expandedCategories.delete(category);
		} else {
			expandedCategories.clear();
			expandedCategories.add(category);
		}
	}
</script>

<div class="space-y-4">
	<!-- Header with search and filters -->
	<div class="flex flex-wrap items-center gap-3">
		<!-- Search -->
		<div class="relative flex-1">
			<Search class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/50" />
			<input
				type="text"
				class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-4 pl-9 transition-all duration-200 input-sm placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
				placeholder={m.formats_searchPlaceholder()}
				bind:value={searchQuery}
			/>
		</div>

		<!-- Type filter -->
		<select class="select-bordered select w-full select-sm sm:w-48" bind:value={filterType}>
			<option value="all">{m.formats_allTypes()}</option>
			<option value="builtin">{m.formats_builtin()}</option>
			<option value="custom">{m.formats_custom()}</option>
		</select>

		<!-- Category filter -->
		<select class="select-bordered select w-full select-sm sm:w-48" bind:value={filterCategory}>
			<option value="all">{m.formats_allCategories()}</option>
			{#each FORMAT_CATEGORY_ORDER as cat (cat)}
				<option value={cat}>{FORMAT_CATEGORY_LABELS[cat]}</option>
			{/each}
		</select>

		<!-- Create button -->
		<button type="button" class="btn w-full gap-2 btn-primary btn-sm sm:w-auto" onclick={onCreate}>
			<Plus class="h-4 w-4" />
			{m.formats_createFormat()}
		</button>
	</div>

	<!-- Stats bar -->
	<div class="flex flex-wrap gap-4 text-sm text-base-content/70">
		<span>
			{m.formats_statsTotal({ count: stats().total })}
		</span>
		<span>
			{m.formats_statsBuiltin({ count: stats().builtin })}
		</span>
		<span>
			{m.formats_statsCustom({ count: stats().custom })}
		</span>
		<span>
			{m.formats_statsEnabled({ count: stats().enabled })}
		</span>
	</div>

	<!-- Format list by category -->
	<div class="space-y-2">
		{#each FORMAT_CATEGORY_ORDER as category (category)}
			{@const categoryFormats = groupedFormats().get(category) || []}
			{#if categoryFormats.length > 0}
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

						<span class="badge badge-sm">{categoryFormats.length}</span>
					</button>

					<!-- Category content -->
					{#if expandedCategories.has(category)}
						<div class="border-t border-base-300">
							<div class="divide-y divide-base-200">
								{#each categoryFormats as format (format.id)}
									<div
										class="hover:bg-base-50 flex items-center gap-3 px-4 py-2"
										class:opacity-50={!format.enabled}
									>
										<!-- Built-in indicator -->
										{#if format.isBuiltIn}
											<Lock class="h-3 w-3 text-base-content/40" />
										{:else}
											<div class="w-3"></div>
										{/if}

										<!-- Format info -->
										<div class="min-w-0 flex-1">
											<div class="flex items-center gap-2">
												<span class="truncate font-medium">{format.name}</span>
												{#if !format.enabled}
													<span class="badge badge-ghost badge-sm">{m.formats_badgeDisabled()}</span
													>
												{/if}
											</div>
											{#if format.description}
												<p class="truncate text-xs text-base-content/60">
													{format.description}
												</p>
											{/if}
										</div>

										<!-- Actions -->
										<div class="flex gap-1">
											{#if format.isBuiltIn}
												<button
													type="button"
													class="btn btn-ghost btn-xs"
													onclick={() => onView(format)}
													aria-label={m.formats_ariaViewFormat()}
												>
													<Eye class="h-3.5 w-3.5" />
												</button>
											{:else}
												<button
													type="button"
													class="btn btn-ghost btn-xs"
													onclick={() => onEdit(format)}
													aria-label={m.formats_ariaEditFormat()}
												>
													<Edit class="h-3.5 w-3.5" />
												</button>
												<button
													type="button"
													class="btn btn-ghost text-error btn-xs"
													onclick={() => onDelete(format)}
													aria-label={m.formats_ariaDeleteFormat()}
												>
													<Trash2 class="h-3.5 w-3.5" />
												</button>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			{/if}
		{/each}

		{#if filteredFormats().length === 0}
			<div class="rounded-lg bg-base-200 p-8 text-center">
				<Filter class="mx-auto mb-2 h-8 w-8 text-base-content/40" />
				<p class="text-base-content/60">{m.formats_noMatches()}</p>
			</div>
		{/if}
	</div>
</div>
