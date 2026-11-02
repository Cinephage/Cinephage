<script lang="ts">
	import { X, Search, Layers, RefreshCw, Trash2 } from '@lucide/svelte';
	import { createFocusTrap, lockBodyScroll } from '#lib/utils/focus.js';

	interface CollectionResult {
		id: number;
		name: string;
		poster_path: string | null;
		backdrop_path: string | null;
		overview: string;
	}

	interface Props {
		open: boolean;
		/** Required when onPicked is not provided (standalone save mode). */
		movieId?: string;
		currentCollectionId: number | null;
		currentCollectionName: string | null;
		onClose: () => void;
		/** Standalone mode: saves to API and calls onUpdated. */
		onUpdated?: (collectionId: number | null, collectionName: string | null) => void;
		/** Picker mode: skips API call, passes selection back to parent. */
		onPicked?: (collectionId: number | null, collectionName: string | null) => void;
	}

	let {
		open,
		movieId,
		currentCollectionId,
		currentCollectionName,
		onClose,
		onUpdated,
		onPicked
	}: Props = $props();

	let query = $state('');
	let results = $state<CollectionResult[]>([]);
	let searching = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);
	let modalRef = $state<HTMLElement | null>(null);
	let searchInputRef = $state<HTMLInputElement | null>(null);
	let cleanupFocusTrap: (() => void) | null = null;
	let cleanupScrollLock: (() => void) | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		if (!open) {
			query = '';
			results = [];
			error = null;
		}
	});

	$effect(() => {
		if (open && modalRef) {
			cleanupScrollLock = lockBodyScroll();
			cleanupFocusTrap = createFocusTrap(modalRef);
			searchInputRef?.focus();
		}
		return () => {
			if (cleanupFocusTrap) {
				cleanupFocusTrap();
				cleanupFocusTrap = null;
			}
			if (cleanupScrollLock) {
				cleanupScrollLock();
				cleanupScrollLock = null;
			}
		};
	});

	function handleQueryInput() {
		if (debounceTimer) clearTimeout(debounceTimer);
		const q = query.trim();
		if (!q) {
			results = [];
			return;
		}
		debounceTimer = setTimeout(() => doSearch(q), 350);
	}

	async function doSearch(q: string) {
		searching = true;
		error = null;
		try {
			const res = await fetch(`/api/tmdb/collection/search?q=${encodeURIComponent(q)}`);
			if (!res.ok) throw new Error(await res.text());
			results = await res.json();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Search failed';
		} finally {
			searching = false;
		}
	}

	async function selectCollection(col: CollectionResult) {
		await applyCollection(col.id, col.name);
	}

	async function clearCollection() {
		await applyCollection(null, null);
	}

	async function applyCollection(collectionId: number | null, collectionName: string | null) {
		if (onPicked) {
			onPicked(collectionId, collectionName);
			onClose();
			return;
		}

		saving = true;
		error = null;
		try {
			const res = await fetch(`/api/library/movies/${movieId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tmdbCollectionId: collectionId, collectionName })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error ?? 'Failed to update collection');
			}
			onUpdated?.(collectionId, collectionName);
			onClose();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save';
		} finally {
			saving = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
	}
</script>

{#if open}
	<div class="fixed inset-0 z-50 bg-black/50" onclick={onClose} role="presentation"></div>

	<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
		<div
			bind:this={modalRef}
			class="pointer-events-auto flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl bg-base-100 shadow-2xl"
			onclick={(e) => e.stopPropagation()}
			onkeydown={handleKeydown}
			role="dialog"
			aria-modal="true"
			aria-labelledby="collection-picker-title"
			tabindex="0"
		>
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-base-300 p-4">
				<div class="flex items-center gap-3">
					<Layers class="h-5 w-5 text-primary" />
					<h2 id="collection-picker-title" class="text-lg font-semibold">Set Collection</h2>
				</div>
				<button class="btn btn-square btn-ghost btn-sm" onclick={onClose} aria-label="Close">
					<X class="h-5 w-5" />
				</button>
			</div>

			<!-- Content -->
			<div class="flex flex-1 flex-col gap-3 overflow-hidden p-4">
				<!-- Current collection -->
				{#if currentCollectionName}
					<div
						class="flex items-center justify-between rounded-lg border border-base-300 bg-base-200 px-3 py-2 text-sm"
					>
						<div class="flex min-w-0 items-center gap-2">
							<Layers class="h-4 w-4 shrink-0 text-primary" />
							<span class="truncate font-medium">{currentCollectionName}</span>
							<span class="badge shrink-0 badge-ghost badge-xs">current</span>
						</div>
						<button
							type="button"
							class="btn ml-2 shrink-0 btn-ghost text-error btn-xs"
							disabled={saving}
							onclick={clearCollection}
							title="Remove collection assignment"
						>
							<Trash2 class="h-3.5 w-3.5" />
							Clear
						</button>
					</div>
				{/if}

				<!-- Search input -->
				<div class="form-control relative">
					<Search
						class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-base-content/40"
					/>
					{#if searching}
						<RefreshCw
							class="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin text-base-content/40"
						/>
					{/if}
					<input
						type="text"
						placeholder="Search TMDB collections..."
						class="input-bordered input w-full pr-9 pl-9"
						bind:this={searchInputRef}
						bind:value={query}
						oninput={handleQueryInput}
					/>
				</div>

				{#if error}
					<div class="alert py-2 text-sm alert-error">{error}</div>
				{/if}

				<!-- Results -->
				<div class="min-h-0 flex-1 overflow-y-auto">
					{#if results.length === 0 && query.trim() && !searching}
						<p class="py-8 text-center text-sm text-base-content/50">No collections found</p>
					{:else if results.length === 0 && !query.trim()}
						<p class="py-8 text-center text-sm text-base-content/50">
							Type to search for a collection
						</p>
					{:else}
						<ul class="space-y-2">
							{#each results as col (col.id)}
								{@const isCurrent = col.id === currentCollectionId}
								<li>
									<button
										type="button"
										class="flex w-full items-center gap-3 rounded-lg border border-base-300 bg-base-100 p-2 text-left transition-colors hover:border-primary hover:bg-base-200 disabled:opacity-50"
										class:border-primary={isCurrent}
										class:bg-base-200={isCurrent}
										disabled={saving}
										onclick={() => selectCollection(col)}
									>
										<div class="h-16 w-11 shrink-0 overflow-hidden rounded bg-base-300">
											{#if col.poster_path}
												<img
													src="https://image.tmdb.org/t/p/w92{col.poster_path}"
													alt={col.name}
													class="h-full w-full object-cover"
													loading="lazy"
												/>
											{:else}
												<div class="flex h-full w-full items-center justify-center">
													<Layers class="h-5 w-5 text-base-content/20" />
												</div>
											{/if}
										</div>
										<div class="min-w-0 flex-1">
											<p class="truncate text-sm font-medium">{col.name}</p>
											{#if col.overview}
												<p class="mt-0.5 line-clamp-2 text-xs text-base-content/60">
													{col.overview}
												</p>
											{/if}
										</div>
										{#if isCurrent}
											<span class="badge shrink-0 badge-sm badge-primary">current</span>
										{/if}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</div>

			<!-- Footer -->
			<div class="border-t border-base-300 p-4">
				<button class="btn w-full btn-ghost" onclick={onClose}>Cancel</button>
			</div>
		</div>
	</div>
{/if}
