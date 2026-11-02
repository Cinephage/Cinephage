<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { SvelteSet } from 'svelte/reactivity';
	import { X, RefreshCw, CheckCircle, AlertTriangle, ArrowRight, Film, Tv } from '@lucide/svelte';
	import type { RenamePreviewResult } from '#lib/server/library/naming/RenamePreviewService.js';
	import { createFocusTrap, lockBodyScroll } from '#lib/utils/focus.js';
	import { mediaTypeLabel, type MediaType } from '#lib/utils/media-type.js';
	import {
		getMovieRenamePreview,
		getSeriesRenamePreview,
		executeRename
	} from '#lib/api/settings.js';
	import { chunkFileIds } from '#lib/library/naming/batch-rename.js';
	import type { RenameExecuteResult } from '#lib/library/naming/types.js';

	interface Props {
		open: boolean;
		mediaType: MediaType;
		mediaId: string;
		mediaTitle: string;
		onClose: () => void;
		onRenamed: () => void;
	}

	let { open, mediaType, mediaId, mediaTitle, onClose, onRenamed }: Props = $props();

	// State
	let loading = $state(false);
	let executing = $state(false);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let success = $state<string | null>(null);
	let preview = $state<RenamePreviewResult | null>(null);
	const selectedIds = new SvelteSet<string>();
	let modalRef = $state<HTMLElement | null>(null);
	let contentRef = $state<HTMLElement | null>(null);
	let cleanupFocusTrap: (() => void) | null = null;
	let cleanupScrollLock: (() => void) | null = null;

	// Load preview when modal opens
	$effect(() => {
		if (open) {
			loadPreview();
		} else {
			// Reset state when closed
			preview = null;
			selectedIds.clear();
			error = null;
			success = null;
		}
	});

	async function loadPreview() {
		loading = true;
		error = null;

		try {
			const previewResult = (mediaType === 'movie'
				? await getMovieRenamePreview(mediaId)
				: await getSeriesRenamePreview(mediaId)) as unknown as RenamePreviewResult | null;

			preview = previewResult;

			// Auto-select all "will change" items
			selectedIds.clear();
			for (const item of previewResult?.willChange || []) {
				selectedIds.add(item.fileId);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : m.library_renamePreview_failedToLoad();
		} finally {
			loading = false;
		}
	}

	async function refreshMetadata() {
		refreshing = true;
		error = null;
		try {
			const res = await fetch(`/api/library/movies/${mediaId}/refresh`, { method: 'POST' });
			if (!res.ok) throw new Error(await res.text());
			await loadPreview();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to refresh metadata';
		} finally {
			refreshing = false;
		}
	}

	async function executeRenames() {
		if (selectedIds.size === 0) return;

		executing = true;
		error = null;
		success = null;

		let totalSucceeded = 0;
		let totalFailed = 0;
		const failedErrorMessages: string[] = [];
		const collectedWarnings: string[] = [];

		try {
			// The server caps fileIds at 500 per request, so execute chunks
			// sequentially and aggregate the per-chunk results.
			const chunks = chunkFileIds(Array.from(selectedIds));

			for (const chunk of chunks) {
				const response = await executeRename(chunk, mediaType === 'movie' ? 'movie' : 'episode');

				if (!response.success) {
					throw new Error(response.error || m.library_renamePreview_failedToExecute());
				}

				const result = response as unknown as RenameExecuteResult;
				totalSucceeded += result.succeeded ?? 0;
				totalFailed += result.failed ?? 0;

				if (result.warnings?.length) {
					collectedWarnings.push(...result.warnings);
				}

				// Get specific error messages from failed results
				const failedResults = result.results?.filter((r) => !r.success) || [];
				const errorMessages = failedResults
					.map((r) => r.error)
					.filter((e): e is string => Boolean(e));
				failedErrorMessages.push(...errorMessages);
			}

			if (totalSucceeded > 0) {
				success =
					collectedWarnings.length > 0
						? `${m.library_renamePreview_renamedCount({ count: totalSucceeded })} (${collectedWarnings.join(', ')})`
						: m.library_renamePreview_renamedCount({ count: totalSucceeded });
				onRenamed();

				if (totalFailed === 0) {
					setTimeout(() => {
						onClose();
					}, 1500);
				}
			}

			if (totalFailed > 0) {
				if (failedErrorMessages.length > 0) {
					error = m.library_renamePreview_failedWithErrors({
						count: totalFailed,
						errors: failedErrorMessages.join(', ')
					});
				} else {
					error = m.library_renamePreview_failedCount({ count: totalFailed });
				}
			}
		} catch (e) {
			const chunkError = e instanceof Error ? e.message : m.library_renamePreview_failedToExecute();
			if (totalSucceeded > 0) {
				// Chunks before the failure already renamed files on disk — surface
				// the partial success alongside the chunk error.
				onRenamed();
				success = m.library_renamePreview_renamedCount({ count: totalSucceeded });
			}
			error = chunkError;
		} finally {
			executing = false;
		}
	}

	function toggleSelect(fileId: string) {
		if (selectedIds.has(fileId)) {
			selectedIds.delete(fileId);
		} else {
			selectedIds.add(fileId);
		}
	}

	function isInteractiveTarget(target: EventTarget | null): boolean {
		const element = target instanceof HTMLElement ? target : null;
		if (!element) return false;
		return (
			element.closest(
				'button, a[href], input, textarea, select, [role="button"], [role="checkbox"], [role="switch"], [role="tab"], [contenteditable="true"]'
			) !== null
		);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!open) return;

		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
			return;
		}

		if (!contentRef || isInteractiveTarget(e.target)) return;

		const pageStep = Math.max(Math.floor(contentRef.clientHeight * 0.9), 120);

		if (e.key === ' ') {
			e.preventDefault();
			contentRef.scrollBy({ top: e.shiftKey ? -pageStep : pageStep, behavior: 'smooth' });
			return;
		}

		if (e.key === 'PageDown') {
			e.preventDefault();
			contentRef.scrollBy({ top: pageStep, behavior: 'smooth' });
			return;
		}

		if (e.key === 'PageUp') {
			e.preventDefault();
			contentRef.scrollBy({ top: -pageStep, behavior: 'smooth' });
			return;
		}

		if (e.key === 'Home') {
			e.preventDefault();
			contentRef.scrollTo({ top: 0, behavior: 'smooth' });
			return;
		}

		if (e.key === 'End') {
			e.preventDefault();
			contentRef.scrollTo({ top: contentRef.scrollHeight, behavior: 'smooth' });
		}
	}

	$effect(() => {
		if (open && modalRef) {
			cleanupScrollLock = lockBodyScroll();
			cleanupFocusTrap = createFocusTrap(modalRef);
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

	// Computed
	const hasChanges = $derived((preview?.totalWillChange || 0) > 0);
	const allItems = $derived([
		...(preview?.willChange || []),
		...(preview?.alreadyCorrect || []),
		...(preview?.collisions || []),
		...(preview?.errors || [])
	]);
</script>

{#if open}
	<!-- Backdrop -->
	<div class="fixed inset-0 z-50 bg-black/50" onclick={onClose} role="presentation"></div>

	<!-- Modal -->
	<div class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
		<div
			bind:this={modalRef}
			class="pointer-events-auto flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl bg-base-100 shadow-2xl"
			onclick={(e) => e.stopPropagation()}
			onkeydown={handleKeydown}
			role="dialog"
			aria-modal="true"
			aria-labelledby="modal-title"
			tabindex="0"
		>
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-base-300 p-4">
				<div class="flex items-center gap-3">
					{#if mediaType === 'movie'}
						<Film class="h-5 w-5 text-primary" />
					{:else}
						<Tv class="h-5 w-5 text-secondary" />
					{/if}
					<div>
						<h2 id="modal-title" class="text-lg font-semibold">
							{m.library_renamePreview_title()}
						</h2>
						<p class="text-sm text-base-content/60">{mediaTitle}</p>
					</div>
				</div>
				<button
					class="btn btn-square btn-ghost btn-sm"
					onclick={onClose}
					aria-label={m.action_close()}
				>
					<X class="h-5 w-5" />
				</button>
			</div>

			<!-- Content -->
			<div bind:this={contentRef} class="flex-1 overflow-y-auto p-4">
				{#if loading}
					<div class="flex items-center justify-center py-10">
						<RefreshCw class="h-6 w-6 animate-spin text-primary" />
					</div>
				{:else if error || success}
					{#if error}
						<div class="mb-4 alert alert-error">
							<AlertTriangle class="h-5 w-5" />
							<span>{error}</span>
						</div>
					{/if}
					{#if success}
						<div class="alert alert-success">
							<CheckCircle class="h-5 w-5" />
							<span>{success}</span>
						</div>
					{/if}
				{:else if preview}
					<!-- Summary -->
					<div class="mb-4 flex gap-4 text-sm">
						<span class="badge badge-info"
							>{m.library_renamePreview_willChange({ count: preview.totalWillChange })}</span
						>
						<span class="badge badge-success"
							>{m.library_renamePreview_correct({ count: preview.totalAlreadyCorrect })}</span
						>
						{#if preview.totalCollisions > 0}
							<span class="badge badge-warning"
								>{m.library_renamePreview_collisions({ count: preview.totalCollisions })}</span
							>
						{/if}
						{#if preview.totalErrors > 0}
							<span class="badge badge-error"
								>{m.library_renamePreview_errors({ count: preview.totalErrors })}</span
							>
						{/if}
					</div>

					{#if preview.missingCollectionData}
						<div class="mb-4 alert alert-warning">
							<AlertTriangle class="h-4 w-4 shrink-0" />
							<div class="min-w-0 flex-1 text-sm">
								<p class="font-medium">No collection data</p>
								<p class="text-warning-content/80">
									Your folder template uses <code class="font-mono">{'{Collection}'}</code> but this movie
									has no collection data - paths may be incorrect. Refresh metadata to fetch it from TMDB.
								</p>
							</div>
							<button
								type="button"
								class="btn btn-sm btn-warning"
								disabled={refreshing}
								onclick={refreshMetadata}
							>
								{#if refreshing}
									<RefreshCw class="h-3 w-3 animate-spin" />
									Refreshing...
								{:else}
									<RefreshCw class="h-3 w-3" />
									Refresh Metadata
								{/if}
							</button>
						</div>
					{/if}

					{#if preview.totalFiles === 0}
						<div class="py-10 text-center text-base-content/60">
							{m.library_renamePreview_noFilesFound({ type: mediaTypeLabel(mediaType) })}.
						</div>
					{:else if !hasChanges}
						<div class="py-10 text-center text-base-content/60">
							<CheckCircle class="mx-auto mb-2 h-8 w-8 text-success" />
							{m.library_renamePreview_allCorrect()}
						</div>
					{:else}
						<!-- File List -->
						<div class="space-y-2">
							{#each allItems as item (item.fileId)}
								{#if item.status === 'will_change'}
									<div
										class="card cursor-pointer bg-base-200"
										class:ring-2={selectedIds.has(item.fileId)}
										class:ring-primary={selectedIds.has(item.fileId)}
										onclick={() => toggleSelect(item.fileId)}
										onkeydown={(e) => e.key === 'Enter' && toggleSelect(item.fileId)}
										role="checkbox"
										aria-checked={selectedIds.has(item.fileId)}
										tabindex="0"
									>
										<div class="card-body p-3">
											<div class="flex items-start gap-3">
												<input
													type="checkbox"
													class="checkbox mt-1 checkbox-sm checkbox-primary"
													checked={selectedIds.has(item.fileId)}
													onclick={(e) => e.stopPropagation()}
													onchange={() => toggleSelect(item.fileId)}
												/>
												<div class="min-w-0 flex-1">
													<div class="space-y-1 text-sm">
														<div class="flex items-center gap-2">
															<code
																class="rounded bg-base-300 px-1.5 py-0.5 text-xs break-all text-error"
																>{item.currentParentPath}/{item.currentRelativePath}</code
															>
														</div>
														<div class="flex items-center gap-2">
															<ArrowRight class="h-3 w-3 shrink-0 text-base-content/40" />
															<code
																class="rounded bg-base-300 px-1.5 py-0.5 text-xs break-all text-success"
																>{item.newParentPath}/{item.newRelativePath}</code
															>
														</div>
													</div>
													{#if item.error}
														<div class="mt-1 text-xs text-error">{item.error}</div>
													{/if}
												</div>
												<div class="shrink-0">
													<span class="badge badge-sm badge-info"
														>{m.library_renamePreview_change()}</span
													>
												</div>
											</div>
										</div>
									</div>
								{:else}
									<div
										class="card bg-base-200"
										class:opacity-50={item.status === 'already_correct'}
									>
										<div class="card-body p-3">
											<div class="flex items-start gap-3">
												<div class="min-w-0 flex-1">
													{#if item.status === 'collision'}
														<div class="space-y-1 text-sm">
															<div class="flex items-center gap-2">
																<code
																	class="rounded bg-base-300 px-1.5 py-0.5 text-xs break-all text-error"
																	>{item.currentRelativePath}</code
																>
															</div>
															<div class="flex items-center gap-2">
																<ArrowRight class="h-3 w-3 shrink-0 text-base-content/40" />
																<code
																	class="rounded bg-base-300 px-1.5 py-0.5 text-xs break-all text-success"
																	>{item.newRelativePath}</code
																>
															</div>
														</div>
													{:else}
														<code class="rounded bg-base-300 px-1.5 py-0.5 text-xs break-all"
															>{item.currentParentPath}/{item.currentRelativePath}</code
														>
													{/if}
													{#if item.error}
														<div class="mt-1 text-xs text-error">{item.error}</div>
													{/if}
												</div>
												<div class="shrink-0">
													{#if item.status === 'already_correct'}
														<span class="badge badge-sm badge-success"
															>{m.library_renamePreview_correctBadge()}</span
														>
													{:else if item.status === 'collision'}
														<span class="badge badge-sm badge-warning"
															>{m.library_renamePreview_collisionBadge()}</span
														>
													{:else if item.status === 'error'}
														<span class="badge badge-sm badge-error"
															>{m.library_renamePreview_errorBadge()}</span
														>
													{/if}
												</div>
											</div>
										</div>
									</div>
								{/if}
							{/each}
						</div>
					{/if}
				{/if}
			</div>

			<!-- Footer -->
			<div class="flex items-center justify-between border-t border-base-300 p-4">
				<button class="btn btn-ghost" onclick={onClose}>{m.action_cancel()}</button>
				<button
					class="btn gap-2 btn-primary"
					onclick={executeRenames}
					disabled={executing || selectedIds.size === 0}
				>
					{#if executing}
						<RefreshCw class="h-4 w-4 animate-spin" />
						{m.library_renamePreview_renaming()}
					{:else}
						<CheckCircle class="h-4 w-4" />
						{m.action_rename()} ({selectedIds.size})
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}
