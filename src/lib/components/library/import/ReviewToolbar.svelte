<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Search, X } from '@lucide/svelte';
	import type { MediaType } from './types.js';

	type QueueMediaFilter = 'all' | MediaType;

	let {
		query = $bindable(''),
		statusFilter = $bindable('pending' as string),
		mediaFilter = $bindable('all' as QueueMediaFilter),
		lockedMediaType = undefined as MediaType | undefined,
		pendingCount = 0,
		readyCount = 0,
		remainingCount = 0,
		skippedCount = 0,
		importedCount = 0
	}: {
		query: string;
		statusFilter: string;
		mediaFilter: QueueMediaFilter;
		lockedMediaType?: MediaType;
		pendingCount: number;
		readyCount: number;
		remainingCount: number;
		skippedCount: number;
		importedCount: number;
	} = $props();
</script>

<div class="rounded-xl border border-base-300 bg-base-100 p-4 sm:p-5">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div>
			<h2 class="text-lg font-semibold">{m.library_import_detectedItems()}</h2>
			<p class="mt-1 text-sm text-base-content/70">
				{m.library_import_detectedItemsHint()}
			</p>
		</div>
		<div class="flex flex-wrap items-center gap-2 text-xs">
			<span class="badge badge-outline"
				>{m.library_import_needsInputCount({ count: pendingCount })}</span
			>
			<span class="badge badge-primary"
				>{m.library_import_selectedCount({ count: remainingCount })}</span
			>
			<span class="badge badge-success"
				>{m.library_import_importedCount({ count: importedCount })}</span
			>
			{#if skippedCount > 0}
				<span class="badge badge-ghost"
					>{m.library_import_skippedCount({ count: skippedCount })}</span
				>
			{/if}
		</div>
	</div>

	<div class="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
		<div class="group relative lg:max-w-sm lg:flex-1">
			<div class="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2">
				<Search
					class="h-4 w-4 text-base-content/40 transition-colors group-focus-within:text-primary"
				/>
			</div>
			<input
				type="text"
				placeholder={m.library_import_searchDetectedItems()}
				class="input w-full rounded-full border-base-content/20 bg-base-200/60 pr-9 pl-10 transition-all duration-200 input-md placeholder:text-base-content/40 hover:bg-base-200 focus:border-primary/50 focus:bg-base-200 focus:ring-1 focus:ring-primary/20 focus:outline-none"
				bind:value={query}
			/>
			{#if query}
				<button
					class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-base-content/40 transition-colors hover:bg-base-300 hover:text-base-content"
					onclick={() => (query = '')}
					aria-label={m.library_import_clearDetectedSearch()}
				>
					<X class="h-3.5 w-3.5" />
				</button>
			{/if}
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<div class="max-w-full scrollbar-none overflow-x-auto">
				<div class="join">
					<button
						type="button"
						class="btn join-item whitespace-nowrap btn-sm {statusFilter === 'pending'
							? 'btn-primary'
							: 'btn-ghost'}"
						disabled={pendingCount === 0}
						onclick={() => (statusFilter = 'pending')}
					>
						{m.library_import_filterNeedsInput()}
					</button>
					<button
						type="button"
						class="btn join-item whitespace-nowrap btn-sm {statusFilter === 'ready'
							? 'btn-primary'
							: 'btn-ghost'}"
						disabled={readyCount === 0}
						onclick={() => (statusFilter = 'ready')}
					>
						{m.library_import_filterReady()}
					</button>
					<button
						type="button"
						class="btn join-item whitespace-nowrap btn-sm {statusFilter === 'skipped'
							? 'btn-primary'
							: 'btn-ghost'}"
						disabled={skippedCount === 0}
						onclick={() => (statusFilter = 'skipped')}
					>
						{m.library_import_filterSkipped()}
					</button>
					<button
						type="button"
						class="btn join-item whitespace-nowrap btn-sm {statusFilter === 'imported'
							? 'btn-primary'
							: 'btn-ghost'}"
						disabled={importedCount === 0}
						onclick={() => (statusFilter = 'imported')}
					>
						{m.library_import_filterImported()}
					</button>
					<button
						type="button"
						class="btn join-item whitespace-nowrap btn-sm {statusFilter === 'all'
							? 'btn-primary'
							: 'btn-ghost'}"
						onclick={() => (statusFilter = 'all')}
					>
						{m.common_all()}
					</button>
				</div>
			</div>
			{#if !lockedMediaType}
				<div class="max-w-full scrollbar-none overflow-x-auto">
					<div class="join">
						<button
							type="button"
							class="btn join-item whitespace-nowrap btn-sm {mediaFilter === 'all'
								? 'btn-primary'
								: 'btn-ghost'}"
							onclick={() => (mediaFilter = 'all')}
						>
							{m.library_import_filterAllMedia()}
						</button>
						<button
							type="button"
							class="btn join-item whitespace-nowrap btn-sm {mediaFilter === 'movie'
								? 'btn-primary'
								: 'btn-ghost'}"
							onclick={() => (mediaFilter = 'movie')}
						>
							{m.common_movies()}
						</button>
						<button
							type="button"
							class="btn join-item whitespace-nowrap btn-sm {mediaFilter === 'tv'
								? 'btn-primary'
								: 'btn-ghost'}"
							onclick={() => (mediaFilter = 'tv')}
						>
							{m.common_tvShows()}
						</button>
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>
