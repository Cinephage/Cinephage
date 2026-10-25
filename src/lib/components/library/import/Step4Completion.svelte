<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import * as m from '#lib/paraglide/messages.js';
	import { Check, X, ExternalLink, Loader2 } from '@lucide/svelte';

	const MAX_LIBRARY_LINKS = 8;

	interface ExecuteResult {
		success: boolean;
		mediaType: 'movie' | 'tv';
		tmdbId: number;
		libraryId: string;
		importedPath: string;
		importedCount?: number;
		importedPaths?: string[];
	}

	interface ImportedBulkItem {
		title: string;
		year?: number | null;
		mediaType: 'movie' | 'tv';
		libraryId?: string | null;
		href?: string | null;
	}

	let {
		executeError = null,
		executeResult = null,
		bulkImportSummary = null,
		importedBulkItems = [],
		skippedGroupCount = 0,
		remainingGroupCount = 0,
		completionLink = null,
		originLibraryLink = null,
		backgroundProgress = null,
		backgroundCurrentItem = null,
		onTryAgain = () => {},
		onReset = () => {},
		onContinueWithNext = () => {}
	}: {
		executeError: string | null;
		executeResult: ExecuteResult | null;
		bulkImportSummary: { importedGroups: number; failedGroups: number } | null;
		importedBulkItems: ImportedBulkItem[];
		skippedGroupCount: number;
		remainingGroupCount: number;
		completionLink: string | null;
		originLibraryLink: string | null;
		backgroundProgress?: { completed: number; failed: number; total: number } | null;
		backgroundCurrentItem?: string | null;
		onTryAgain: () => void;
		onReset: () => void;
		onContinueWithNext: () => void;
	} = $props();

	const uniqueLibraryLinks = $derived.by(() => {
		if (!importedBulkItems || importedBulkItems.length === 0) return [];
		const seen = new SvelteSet<string>();
		const result: ImportedBulkItem[] = [];
		for (const item of importedBulkItems) {
			const key = item.href ?? item.title;
			if (!seen.has(key)) {
				seen.add(key);
				result.push(item);
			}
		}
		return result;
	});

	const singleLibraryLink = $derived.by(() => {
		if (uniqueLibraryLinks.length === 1 && uniqueLibraryLinks[0].href) {
			return uniqueLibraryLinks[0].href;
		}
		return null;
	});

	const displayedLinks = $derived(uniqueLibraryLinks.slice(0, MAX_LIBRARY_LINKS));
	const hiddenLinkCount = $derived(Math.max(0, uniqueLibraryLinks.length - MAX_LIBRARY_LINKS));
</script>

{#if executeError}
	<div class="rounded-xl border border-error/40 bg-error/5 p-5">
		<div class="flex items-start gap-3">
			<div class="mt-0.5 rounded-full bg-error/20 p-2">
				<X class="h-5 w-5 text-error" />
			</div>
			<div class="min-w-0 flex-1">
				<h2 class="text-xl font-semibold">{m.library_import_importFailed()}</h2>
				<p class="mt-1 text-sm text-base-content/80">
					{executeError}
				</p>
				<div class="mt-4 flex flex-wrap gap-2">
					<button class="btn btn-primary btn-sm" onclick={onTryAgain}>
						{m.library_import_tryAgain()}
					</button>
					{#if originLibraryLink}
						<a class="btn btn-outline btn-sm" href={originLibraryLink}
							>{m.library_import_backToLibraryItem()}</a
						>
					{/if}
				</div>
			</div>
		</div>
	</div>
{:else if executeResult || bulkImportSummary}
	<div class="rounded-xl border border-success/40 bg-success/5 p-5">
		<div class="flex items-start gap-3">
			<div class="mt-0.5 rounded-full bg-success/20 p-2">
				<Check class="h-5 w-5 text-success" />
			</div>
			<div class="min-w-0 flex-1">
				<h2 class="text-xl font-semibold">{m.library_import_importComplete()}</h2>
				{#if bulkImportSummary}
					<p class="mt-1 text-sm text-base-content/80">
						{#if bulkImportSummary.failedGroups > 0}
							{m.library_import_bulkImportedWithFailures({
								imported: bulkImportSummary.importedGroups,
								failed: bulkImportSummary.failedGroups
							})}
						{:else}
							{m.library_import_bulkImportedSuccess({
								imported: bulkImportSummary.importedGroups
							})}
						{/if}
					</p>
					{#if skippedGroupCount > 0}
						<p class="mt-1 text-sm text-base-content/70">
							{m.library_import_bulkSkippedItems({ count: skippedGroupCount })}
						</p>
					{/if}
				{:else if executeResult}
					<p class="mt-1 text-sm text-base-content/80">
						{executeResult.importedCount && executeResult.importedCount > 1
							? m.library_import_filesImportedPlural({ count: executeResult.importedCount })
							: m.library_import_fileImportedSingular()}
					</p>
				{/if}

				{#if executeResult}
					<div class="mt-3 rounded-lg bg-base-100 p-3 text-sm break-all">
						<div>
							<span class="text-base-content/60">{m.library_import_importedPathLabel()}</span>
							{executeResult.importedPath}
						</div>
					</div>
				{/if}

				<!-- Library links for bulk imports -->
				{#if bulkImportSummary && uniqueLibraryLinks.length > 0}
					{#if singleLibraryLink}
						<!-- all items belong to the same library entry -->
					{:else}
						<!-- multiple libraries - show a compact list -->
						<div class="mt-3 rounded-lg bg-base-100 p-3">
							<p class="mb-2 text-xs font-medium text-base-content/60">
								{m.library_import_importedItems()}
							</p>
							<div class="space-y-1">
								{#each displayedLinks as item (item.href ?? item.title)}
									{#if item.href}
										<a
											href={item.href}
											class="flex items-center gap-1.5 rounded px-1 py-0.5 text-sm text-primary hover:underline"
										>
											<ExternalLink class="h-3 w-3 shrink-0" />
											<span class="truncate">{item.title}{item.year ? ` (${item.year})` : ''}</span>
										</a>
									{:else}
										<span class="block truncate px-1 py-0.5 text-sm text-base-content/70">
											{item.title}{item.year ? ` (${item.year})` : ''}
										</span>
									{/if}
								{/each}
								{#if hiddenLinkCount > 0}
									<p class="px-1 pt-1 text-xs text-base-content/50">
										{m.library_import_andNMore({ count: hiddenLinkCount })}
									</p>
								{/if}
							</div>
						</div>
					{/if}
				{/if}

				<div class="mt-4 flex flex-wrap gap-2">
					<!-- Single-entry "View in Library" (single import OR bulk all-same-library) -->
					{#if singleLibraryLink && bulkImportSummary}
						<a class="btn btn-primary btn-sm" href={singleLibraryLink}>
							{m.library_import_viewInLibrary()}
						</a>
					{:else if completionLink}
						<a class="btn btn-primary btn-sm" href={completionLink}>
							{bulkImportSummary
								? m.library_import_viewLastImported()
								: m.library_import_viewInLibrary()}
						</a>
					{/if}
					{#if remainingGroupCount > 0}
						<button class="btn btn-outline btn-sm" onclick={onContinueWithNext}>
							{m.library_import_importNextDetected({ count: remainingGroupCount })}
						</button>
					{/if}
					<button class="btn btn-ghost btn-sm" onclick={onReset}
						>{m.library_import_importAnother()}</button
					>
				</div>
			</div>
		</div>
	</div>
{:else}
	<!-- Reached step 4 with nothing to show yet: a background import (single or
	     bulk) was just started and hasn't reported completion through its poll.
	     Show its live progress. -->
	<div class="rounded-xl border border-base-300 bg-base-100 p-5">
		<div class="flex items-start gap-3">
			<div class="mt-0.5 rounded-full bg-primary/10 p-2">
				<Loader2 class="h-5 w-5 animate-spin text-primary" />
			</div>
			<div class="min-w-0 flex-1">
				<h2 class="text-xl font-semibold">{m.library_import_backgroundRunningHeading()}</h2>
				{#if backgroundProgress}
					{@const progressPct =
						backgroundProgress.total > 0
							? ((backgroundProgress.completed + backgroundProgress.failed) /
									backgroundProgress.total) *
								100
							: 0}
					<p class="mt-1 text-sm text-base-content/80">
						{m.library_import_backgroundProgressCount({
							completed: backgroundProgress.completed,
							total: backgroundProgress.total
						})}
					</p>
					{#if backgroundCurrentItem}
						<p class="mt-0.5 truncate text-xs text-base-content/60">
							{m.activity_importJobsCardCurrentItem({ name: backgroundCurrentItem })}
						</p>
					{/if}
					<progress class="progress mt-2 w-full progress-primary" value={progressPct} max={100}
					></progress>
				{/if}
				<div class="mt-4 flex flex-wrap gap-2">
					<button class="btn btn-ghost btn-sm" onclick={onReset}>
						{m.library_import_importAnother()}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}
