<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		ChevronUp,
		ChevronDown,
		Captions,
		GripVertical,
		Loader2,
		FlaskConical,
		ToggleLeft,
		ToggleRight,
		Settings,
		Trash2
	} from '@lucide/svelte';
	import SubtitleProviderRow from './SubtitleProviderRow.svelte';
	import SubtitleProviderStatusBadge from './SubtitleProviderStatusBadge.svelte';
	import type { SubtitleProviderConfig } from '#lib/server/subtitles/types.js';
	import type { ProviderDefinition } from '#lib/server/subtitles/providers/interfaces.js';

	interface SubtitleProviderWithDefinition extends SubtitleProviderConfig {
		definitionName?: string;
		definition?: ProviderDefinition;
	}

	type SortColumn = 'name' | 'priority' | 'enabled';
	type SortDirection = 'asc' | 'desc';

	interface Props {
		providers: SubtitleProviderWithDefinition[];
		selectedIds: Set<string>;
		sort: { column: SortColumn; direction: SortDirection };
		testingIds: Set<string>;
		onSelect: (id: string, selected: boolean) => void;
		onSelectAll: (selected: boolean) => void;
		onSort: (column: SortColumn) => void;
		onEdit: (provider: SubtitleProviderWithDefinition) => void;
		onDelete: (provider: SubtitleProviderWithDefinition) => void;
		onTest: (provider: SubtitleProviderWithDefinition) => void;
		onToggle: (provider: SubtitleProviderWithDefinition) => void;
		onReorder?: (providerIds: string[]) => void;
	}

	let {
		providers,
		selectedIds,
		sort,
		testingIds,
		onSelect,
		onSelectAll,
		onSort,
		onEdit,
		onDelete,
		onTest,
		onToggle,
		onReorder
	}: Props = $props();

	let draggedIndex = $state<number | null>(null);
	let dragOverIndex = $state<number | null>(null);
	let reorderMode = $state(false);

	const allSelected = $derived(
		providers.length > 0 && providers.every((p) => selectedIds.has(p.id))
	);
	const someSelected = $derived(providers.some((p) => selectedIds.has(p.id)) && !allSelected);

	function isSortedBy(column: SortColumn): boolean {
		return sort.column === column;
	}

	function isAscending(): boolean {
		return sort.direction === 'asc';
	}

	function getProviderLabel(provider: SubtitleProviderWithDefinition): string {
		return provider.definitionName ?? provider.definition?.name ?? provider.implementation;
	}

	function getSurfacedFeatures(provider: SubtitleProviderWithDefinition): string[] {
		const features = [...(provider.definition?.features ?? [])];

		if (features.length < 3) {
			if (provider.definition?.supportsHashSearch) {
				features.push(m.subtitleProviders_table_featureHashMatching());
			}
			if (provider.definition?.requiresApiKey || provider.definition?.accessType === 'api-key') {
				features.push(m.subtitleProviders_table_featureApiAccess());
			}
			if (
				provider.definition?.requiresCredentials ||
				provider.definition?.accessType === 'free-account' ||
				provider.definition?.accessType === 'paid' ||
				provider.definition?.accessType === 'vip'
			) {
				features.push(m.subtitleProviders_table_featureAccountAuth());
			}
		}

		const unique = Array.from(new Set(features));
		const defaults = [
			m.subtitleProviders_table_featureSubtitleSearch(),
			m.subtitleProviders_table_featureLanguageMatching(),
			m.subtitleProviders_table_featureProviderApi()
		];
		let idx = 0;
		while (unique.length < 3 && idx < defaults.length) {
			if (!unique.includes(defaults[idx])) {
				unique.push(defaults[idx]);
			}
			idx += 1;
		}

		return unique.slice(0, 3);
	}

	function getCompactFeatureLabel(feature: string): string {
		const normalized = feature.trim();
		const compactMap: Record<string, string> = {
			'No API key required': m.subtitleProviders_table_compactNoApiKey(),
			'API key required': m.subtitleProviders_table_compactApiKey(),
			'Movies & TV subtitles': m.subtitleProviders_table_compactMoviesTv(),
			'Multi-language subtitles': m.subtitleProviders_table_compactMultiLanguage()
		};
		const compact = compactMap[normalized] ?? normalized;
		return compact.length > 16 ? `${compact.slice(0, 15)}...` : compact;
	}

	function handleDragStart(event: DragEvent, index: number) {
		if (!reorderMode) return;
		draggedIndex = index;
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', String(index));
		}
	}

	function handleDragOver(event: DragEvent, index: number) {
		if (!reorderMode || draggedIndex === null) return;
		event.preventDefault();
		dragOverIndex = index;
	}

	function handleDragLeave() {
		dragOverIndex = null;
	}

	function handleDrop(event: DragEvent, dropIndex: number) {
		if (!reorderMode || draggedIndex === null || !onReorder) return;
		event.preventDefault();

		if (draggedIndex !== dropIndex) {
			const newOrder = [...providers];
			const [removed] = newOrder.splice(draggedIndex, 1);
			newOrder.splice(dropIndex, 0, removed);
			onReorder(newOrder.map((p) => p.id));
		}

		draggedIndex = null;
		dragOverIndex = null;
	}

	function handleDragEnd() {
		draggedIndex = null;
		dragOverIndex = null;
	}

	function moveProvider(fromIndex: number, toIndex: number) {
		if (!onReorder || !reorderMode) return;
		if (toIndex < 0 || toIndex >= providers.length || fromIndex === toIndex) return;

		const reordered = [...providers];
		const [moved] = reordered.splice(fromIndex, 1);
		reordered.splice(toIndex, 0, moved);
		onReorder(reordered.map((p) => p.id));
	}

	function toggleReorderMode() {
		if (!onReorder) return;
		reorderMode = !reorderMode;
		draggedIndex = null;
		dragOverIndex = null;
		if (reorderMode) {
			onSort('priority');
		}
	}

	$effect(() => {
		if (!onReorder && reorderMode) {
			reorderMode = false;
			draggedIndex = null;
			dragOverIndex = null;
		}
	});
</script>

{#if providers.length === 0}
	<div class="flex flex-col items-center justify-center py-12 text-base-content/50">
		<Captions class="mb-4 h-12 w-12" />
		<p class="text-lg font-medium">{m.subtitleProviders_table_noProvidersTitle()}</p>
		<p class="text-sm">{m.subtitleProviders_table_noProvidersDescription()}</p>
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
					{m.subtitleProviders_table_selectAll()}
				</label>
				<span class="text-xs text-base-content/60"
					>{m.subtitleProviders_table_selectedCount({ count: selectedIds.size })}</span
				>
			</div>

			{#if onReorder}
				<div class="mt-2 border-t border-base-300/70 pt-2">
					<div class="flex items-center justify-between gap-2">
						<div
							class="text-xs font-medium {reorderMode ? 'text-primary' : 'text-base-content/70'}"
						>
							{reorderMode
								? m.subtitleProviders_table_reorderModeActive()
								: m.subtitleProviders_table_priorityReordering()}
						</div>
						<button
							class="btn gap-1 btn-xs {reorderMode ? 'btn-primary' : 'btn-ghost'}"
							onclick={toggleReorderMode}
						>
							<GripVertical class="h-3.5 w-3.5" />
							{reorderMode ? m.subtitleProviders_table_done() : m.subtitleProviders_table_reorder()}
						</button>
					</div>
					<p class="mt-1 text-xs text-base-content/60">
						{reorderMode
							? m.subtitleProviders_table_reorderHint()
							: m.subtitleProviders_table_reorderEnableHint()}
					</p>
				</div>
			{/if}
		</div>

		{#each providers as provider, index (provider.id)}
			<div
				role="listitem"
				class="rounded-xl border bg-base-100 p-3 transition-all duration-150 {selectedIds.has(
					provider.id
				)
					? 'border-primary/50 ring-1 ring-primary/30'
					: 'border-base-300/80'} {dragOverIndex === index
					? 'border-primary/70 bg-primary/5'
					: ''} {draggedIndex === index ? 'opacity-60' : ''}"
				draggable={reorderMode}
				ondragstart={(e) => handleDragStart(e, index)}
				ondragover={(e) => handleDragOver(e, index)}
				ondragleave={handleDragLeave}
				ondrop={(e) => handleDrop(e, index)}
				ondragend={handleDragEnd}
			>
				<div class="mb-2 flex items-start justify-between gap-2">
					<div class="flex min-w-0 items-start gap-2.5">
						{#if reorderMode}
							<div class="mt-0.5 flex h-5 w-5 items-center justify-center">
								<GripVertical class="h-4 w-4 text-base-content/50" />
							</div>
						{:else}
							<input
								type="checkbox"
								class="checkbox checkbox-sm checkbox-primary"
								checked={selectedIds.has(provider.id)}
								onchange={(e) => onSelect(provider.id, e.currentTarget.checked)}
							/>
						{/if}
						<div class="min-w-0">
							<div class="flex flex-wrap items-center gap-2">
								<button class="link text-sm font-bold link-hover" onclick={() => onEdit(provider)}>
									{provider.name}
								</button>
								<SubtitleProviderStatusBadge
									enabled={provider.enabled}
									healthy={provider.consecutiveFailures === 0}
									consecutiveFailures={provider.consecutiveFailures}
									lastError={provider.lastError}
									throttledUntil={provider.throttledUntil}
								/>
							</div>
							<div class="truncate text-xs text-base-content/60">{getProviderLabel(provider)}</div>
						</div>
					</div>
					<div class="flex shrink-0 items-center gap-1">
						{#if reorderMode}
							<button
								class="btn btn-ghost btn-xs"
								onclick={() => moveProvider(index, index - 1)}
								disabled={index === 0}
								title={m.subtitleProviders_table_moveUp()}
								aria-label={m.subtitleProviders_table_moveUp()}
							>
								<ChevronUp class="h-3.5 w-3.5" />
							</button>
							<button
								class="btn btn-ghost btn-xs"
								onclick={() => moveProvider(index, index + 1)}
								disabled={index === providers.length - 1}
								title={m.subtitleProviders_table_moveDown()}
								aria-label={m.subtitleProviders_table_moveDown()}
							>
								<ChevronDown class="h-3.5 w-3.5" />
							</button>
						{/if}
						<span class="badge shrink-0 gap-1 badge-ghost badge-sm">
							{provider.requestsPerMinute}/min
						</span>
						<span class="badge shrink-0 badge-outline badge-sm">{provider.priority}</span>
					</div>
				</div>

				<div class="mb-3 flex flex-wrap items-center gap-1">
					{#each getSurfacedFeatures(provider) as feature (feature)}
						<span class="badge max-w-36 truncate badge-ghost badge-sm" title={feature}>
							{getCompactFeatureLabel(feature)}
						</span>
					{/each}
				</div>

				<div class="grid grid-cols-4 gap-1.5">
					<button
						class="btn btn-ghost btn-xs"
						onclick={() => onTest(provider)}
						disabled={testingIds.has(provider.id) || reorderMode}
						title={m.subtitleProviders_table_testConnection()}
						aria-label={m.subtitleProviders_table_testConnection()}
					>
						{#if testingIds.has(provider.id)}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else}
							<FlaskConical class="h-4 w-4" />
						{/if}
					</button>
					<button
						class="btn btn-ghost btn-xs"
						onclick={() => onToggle(provider)}
						disabled={testingIds.has(provider.id) || reorderMode}
						title={provider.enabled
							? m.subtitleProviders_table_disable()
							: m.subtitleProviders_table_enable()}
						aria-label={provider.enabled
							? m.subtitleProviders_table_disable()
							: m.subtitleProviders_table_enable()}
					>
						{#if provider.enabled}
							<ToggleRight class="h-4 w-4 text-success" />
						{:else}
							<ToggleLeft class="h-4 w-4" />
						{/if}
					</button>
					<button
						class="btn btn-ghost btn-xs"
						onclick={() => onEdit(provider)}
						disabled={reorderMode}
						title={m.subtitleProviders_table_editProvider()}
						aria-label={m.subtitleProviders_table_editProvider()}
					>
						<Settings class="h-4 w-4" />
					</button>
					<button
						class="btn btn-ghost text-error btn-xs"
						onclick={() => onDelete(provider)}
						disabled={reorderMode}
						title={m.subtitleProviders_table_deleteProvider()}
						aria-label={m.subtitleProviders_table_deleteProvider()}
					>
						<Trash2 class="h-4 w-4" />
					</button>
				</div>
			</div>
		{/each}
	</div>

	<div class="hidden overflow-x-auto sm:block">
		{#if onReorder}
			<div class="flex items-center justify-end border-b border-base-300 px-4 py-2">
				<button
					class="btn btn-sm {reorderMode ? 'btn-primary' : 'btn-ghost'}"
					onclick={toggleReorderMode}
				>
					<GripVertical class="h-4 w-4" />
					{reorderMode
						? m.subtitleProviders_table_doneReordering()
						: m.subtitleProviders_table_reorderPriorities()}
				</button>
			</div>
		{/if}

		{#if reorderMode}
			<div class="flex items-center gap-2 bg-info/10 px-4 py-2 text-sm text-info">
				<GripVertical class="h-4 w-4" />
				{m.subtitleProviders_table_dragHint()}
			</div>
		{/if}

		<table class="table table-sm">
			<thead>
				<tr>
					<th class="w-10">
						{#if reorderMode}
							<GripVertical class="mx-auto h-4 w-4 text-base-content/50" />
						{:else}
							<input
								type="checkbox"
								class="checkbox checkbox-sm checkbox-primary"
								checked={allSelected}
								indeterminate={someSelected}
								onchange={(e) => onSelectAll(e.currentTarget.checked)}
							/>
						{/if}
					</th>
					<th class="w-24">
						<button
							class="flex items-center gap-1 hover:text-primary"
							onclick={() => onSort('enabled')}
							disabled={reorderMode}
						>
							{m.subtitleProviders_table_status()}
							{#if isSortedBy('enabled') && !reorderMode}
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
							disabled={reorderMode}
						>
							{m.subtitleProviders_table_name()}
							{#if isSortedBy('name') && !reorderMode}
								{#if isAscending()}
									<ChevronUp class="h-3 w-3" />
								{:else}
									<ChevronDown class="h-3 w-3" />
								{/if}
							{/if}
						</button>
					</th>
					<th>{m.subtitleProviders_table_provider()}</th>
					<th>{m.subtitleProviders_table_features()}</th>
					<th class="text-center">
						<button
							class="mx-auto flex items-center gap-1 hover:text-primary"
							onclick={() => onSort('priority')}
							disabled={reorderMode}
						>
							{m.subtitleProviders_table_priority()}
							{#if isSortedBy('priority') && !reorderMode}
								{#if isAscending()}
									<ChevronUp class="h-3 w-3" />
								{:else}
									<ChevronDown class="h-3 w-3" />
								{/if}
							{/if}
						</button>
					</th>
					<th class="text-center">{m.subtitleProviders_table_rateLimit()}</th>
					<th class="pl-4! text-start">{m.subtitleProviders_table_actions()}</th>
				</tr>
			</thead>
			<tbody>
				{#each providers as provider, index (provider.id)}
					<tr
						class="hover transition-colors {draggedIndex === index
							? 'opacity-70'
							: ''} {dragOverIndex === index ? 'bg-primary/5' : ''}"
						draggable={reorderMode}
						ondragstart={(e) => handleDragStart(e, index)}
						ondragover={(e) => handleDragOver(e, index)}
						ondragleave={handleDragLeave}
						ondrop={(e) => handleDrop(e, index)}
						ondragend={handleDragEnd}
					>
						<td class="w-10">
							{#if reorderMode}
								<div class="flex justify-center">
									<GripVertical class="h-4 w-4 cursor-grab text-base-content/50" />
								</div>
							{:else}
								<input
									type="checkbox"
									class="checkbox checkbox-sm checkbox-primary"
									checked={selectedIds.has(provider.id)}
									onchange={(e) => onSelect(provider.id, e.currentTarget.checked)}
								/>
							{/if}
						</td>
						<SubtitleProviderRow
							{provider}
							testing={testingIds.has(provider.id)}
							{onEdit}
							{onDelete}
							{onTest}
							{onToggle}
						/>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
