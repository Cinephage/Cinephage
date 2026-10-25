<script lang="ts">
	import {
		Loader2,
		RefreshCw,
		Clock3,
		CircleAlert,
		CheckCircle2,
		Zap,
		ChevronDown,
		ChevronRight,
		XCircle
	} from '@lucide/svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { formatDisplayDateShort } from '#lib/utils/format.js';

	interface SubtitleItem {
		id: string;
		language: string;
		format?: string;
		isForced?: boolean;
		isHearingImpaired?: boolean;
		matchScore?: number | null;
		dateAdded?: string | null;
		wasSynced?: boolean;
		syncOffset?: number | null;
		label?: string;
	}

	interface SyncSettings {
		splitPenalty: number;
		noSplits: boolean;
	}

	type BulkSyncStatus = 'idle' | 'syncing' | 'done';
	type SubtitleSyncState = 'pending' | 'syncing' | 'success' | 'error';

	interface Props {
		open: boolean;
		title: string;
		subtitles: SubtitleItem[];
		syncingSubtitleId?: string | null;
		errorMessage?: string | null;
		onClose: () => void;
		onSync: (subtitleId: string, settings: SyncSettings) => void;
		onBulkSync?: (
			subtitleIds: string[],
			settings: SyncSettings,
			onProgress: (result: BulkSyncResult) => void,
			onComplete: () => void
		) => void;
	}

	export interface BulkSyncResult {
		subtitleId: string;
		success: boolean;
		offsetMs: number;
		error?: string;
		index: number;
		total: number;
	}

	let {
		open,
		title,
		subtitles,
		syncingSubtitleId = null,
		errorMessage = null,
		onClose,
		onSync,
		onBulkSync
	}: Props = $props();

	let splitPenalty = $state(7);
	let noSplits = $state(false);

	// Bulk sync state
	let bulkSyncStatus = $state<BulkSyncStatus>('idle');
	let bulkSyncStates = new SvelteMap<string, SubtitleSyncState>();
	let bulkSyncResults = new SvelteMap<string, { offsetMs: number; error?: string }>();
	let bulkSyncProgress = $state({ completed: 0, total: 0 });

	// Group expansion state
	let expandedGroups = new SvelteSet<string>();

	// Group subtitles by episode label
	const groupedSubtitles = $derived.by(() => {
		const groups = new SvelteMap<string, SubtitleItem[]>();

		for (const sub of subtitles) {
			const label = sub.label || 'Unknown';
			const existing = groups.get(label) || [];
			existing.push(sub);
			groups.set(label, existing);
		}

		return groups;
	});

	// Count unsynced subtitles
	const unsyncedCount = $derived(subtitles.filter((s) => !s.wasSynced).length);

	// Reset state when modal opens
	$effect(() => {
		if (open) {
			bulkSyncStatus = 'idle';
			bulkSyncStates.clear();
			bulkSyncResults.clear();
			bulkSyncProgress = { completed: 0, total: 0 };
			// Expand all groups by default
			expandedGroups.clear();
			for (const label of groupedSubtitles.keys()) {
				expandedGroups.add(label);
			}
		}
	});

	function toggleGroup(label: string) {
		if (expandedGroups.has(label)) {
			expandedGroups.delete(label);
		} else {
			expandedGroups.add(label);
		}
	}

	function formatOffset(syncOffset?: number | null): string {
		if (syncOffset === null || syncOffset === undefined) {
			return 'Not synced yet';
		}

		const seconds = syncOffset / 1000;
		const rounded = Math.abs(seconds) >= 10 ? seconds.toFixed(1) : seconds.toFixed(2);
		const prefix = seconds > 0 ? '+' : '';
		return `${prefix}${rounded}s`;
	}

	function handleSync(subtitleId: string) {
		onSync(subtitleId, { splitPenalty, noSplits });
	}

	function handleBulkSync(onlyUnsynced: boolean) {
		if (!onBulkSync) return;

		const ids = onlyUnsynced
			? subtitles.filter((s) => !s.wasSynced).map((s) => s.id)
			: subtitles.map((s) => s.id);

		if (ids.length === 0) return;

		bulkSyncStatus = 'syncing';
		bulkSyncProgress = { completed: 0, total: ids.length };

		// Initialize all as pending
		bulkSyncStates.clear();
		for (const id of ids) {
			bulkSyncStates.set(id, 'pending');
		}
		bulkSyncResults.clear();

		onBulkSync(
			ids,
			{ splitPenalty, noSplits },
			(result: BulkSyncResult) => {
				// Update individual subtitle state directly (SvelteMap is reactive)
				bulkSyncStates.set(result.subtitleId, result.success ? 'success' : 'error');
				bulkSyncResults.set(result.subtitleId, {
					offsetMs: result.offsetMs,
					error: result.error
				});

				bulkSyncProgress = {
					completed: bulkSyncProgress.completed + 1,
					total: bulkSyncProgress.total
				};
			},
			() => {
				bulkSyncStatus = 'done';
			}
		);
	}

	function getSubtitleSyncState(subtitleId: string): SubtitleSyncState | null {
		return bulkSyncStates.get(subtitleId) ?? null;
	}

	function getGroupSyncSummary(subs: SubtitleItem[]): {
		total: number;
		synced: number;
		inProgress: boolean;
	} {
		let synced = 0;
		let inProgress = false;

		for (const sub of subs) {
			const state = getSubtitleSyncState(sub.id);
			if (state === 'syncing') inProgress = true;
			if (state === 'success' || (!state && sub.wasSynced)) synced++;
		}

		return { total: subs.length, synced, inProgress };
	}

	const bulkSyncSuccessCount = $derived(
		[...bulkSyncStates.values()].filter((s) => s === 'success').length
	);
	const bulkSyncErrorCount = $derived(
		[...bulkSyncStates.values()].filter((s) => s === 'error').length
	);
</script>

<ModalWrapper {open} {onClose} maxWidth="4xl" labelledBy="subtitle-sync-modal-title">
	<div class="mb-4 flex items-center justify-between gap-4">
		<div>
			<h3 id="subtitle-sync-modal-title" class="text-lg font-bold">Subtitle Sync</h3>
			<p class="text-sm text-base-content/60">{title}</p>
		</div>
		<button class="btn btn-ghost btn-sm" onclick={onClose}>Close</button>
	</div>

	{#if errorMessage}
		<div class="mb-4 alert alert-error">
			<CircleAlert size={16} />
			<span>{errorMessage}</span>
		</div>
	{/if}

	<!-- Sync Settings -->
	<div class="mb-4 rounded-lg border border-base-300 bg-base-200/40 p-4">
		<h4 class="mb-3 text-sm font-semibold">Sync Settings</h4>

		<div class="space-y-3">
			<!-- No-splits toggle -->
			<label class="flex cursor-pointer items-center gap-3">
				<input type="checkbox" class="toggle toggle-primary toggle-sm" bind:checked={noSplits} />
				<div>
					<span class="text-sm font-medium">Offset only (fast)</span>
					<p class="text-xs text-base-content/60">
						Apply a constant time shift without introducing splits. Much faster.
					</p>
				</div>
				{#if noSplits}
					<Zap size={14} class="ml-auto text-warning" />
				{/if}
			</label>

			<!-- Split penalty slider (hidden when noSplits is on) -->
			{#if !noSplits}
				<div>
					<div class="mb-1 flex items-center justify-between">
						<label for="split-penalty" class="text-sm font-medium">Split Penalty</label>
						<span class="font-mono text-sm text-base-content/70">{splitPenalty}</span>
					</div>
					<input
						id="split-penalty"
						type="range"
						class="range w-full range-primary range-xs"
						min="0"
						max="30"
						step="1"
						bind:value={splitPenalty}
					/>
					<div class="mt-1 flex justify-between text-xs text-base-content/50">
						<span>More splits</span>
						<span>5-20 recommended</span>
						<span>Fewer splits</span>
					</div>
				</div>
			{/if}
		</div>
	</div>

	<!-- Bulk Sync Actions -->
	{#if onBulkSync && subtitles.length > 1}
		<div class="mb-4 flex flex-wrap items-center gap-2">
			<button
				class="btn gap-2 btn-primary btn-sm"
				onclick={() => handleBulkSync(false)}
				disabled={bulkSyncStatus === 'syncing' || syncingSubtitleId !== null}
			>
				{#if bulkSyncStatus === 'syncing'}
					<Loader2 size={14} class="animate-spin" />
					Syncing {bulkSyncProgress.completed}/{bulkSyncProgress.total}...
				{:else}
					<RefreshCw size={14} />
					Sync All ({subtitles.length})
				{/if}
			</button>

			{#if unsyncedCount > 0 && unsyncedCount !== subtitles.length}
				<button
					class="btn gap-2 btn-outline btn-primary btn-sm"
					onclick={() => handleBulkSync(true)}
					disabled={bulkSyncStatus === 'syncing' || syncingSubtitleId !== null}
				>
					<RefreshCw size={14} />
					Sync Unsynced ({unsyncedCount})
				</button>
			{/if}

			{#if bulkSyncStatus === 'done'}
				<div class="flex items-center gap-2 text-sm">
					{#if bulkSyncSuccessCount > 0}
						<span class="flex items-center gap-1 text-success">
							<CheckCircle2 size={14} />
							{bulkSyncSuccessCount} synced
						</span>
					{/if}
					{#if bulkSyncErrorCount > 0}
						<span class="flex items-center gap-1 text-error">
							<XCircle size={14} />
							{bulkSyncErrorCount} failed
						</span>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Progress bar during bulk sync -->
		{#if bulkSyncStatus === 'syncing'}
			<div class="mb-4">
				<progress
					class="progress w-full progress-primary"
					value={bulkSyncProgress.completed}
					max={bulkSyncProgress.total}
				></progress>
			</div>
		{/if}
	{/if}

	{#if subtitles.length === 0}
		<div
			class="rounded-lg border border-dashed border-base-300 bg-base-200/60 p-8 text-center text-sm text-base-content/60"
		>
			No downloaded subtitle files are available for sync yet.
		</div>
	{:else if groupedSubtitles.size === 1}
		<!-- Single episode - no need for grouping, show flat list -->
		<div class="space-y-3">
			{#each subtitles as subtitle (subtitle.id)}
				{@const syncState = getSubtitleSyncState(subtitle.id)}
				{@const syncResult = bulkSyncResults.get(subtitle.id)}
				<div
					class="rounded-lg border border-base-300 bg-base-100 p-4"
					class:border-success={syncState === 'success'}
					class:border-error={syncState === 'error'}
				>
					<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<div class="space-y-2">
							<div class="flex flex-wrap items-center gap-2">
								<span class="badge badge-outline">{subtitle.language.toUpperCase()}</span>
								{#if subtitle.format}
									<span class="badge badge-ghost">{subtitle.format.toUpperCase()}</span>
								{/if}
								{#if subtitle.isForced}
									<span class="badge badge-soft badge-secondary">Forced</span>
								{/if}
								{#if subtitle.isHearingImpaired}
									<span class="badge badge-soft badge-info">HI</span>
								{/if}
								{#if syncState === 'success' || (!syncState && subtitle.wasSynced)}
									<span class="badge badge-soft badge-accent">
										<CheckCircle2 size={12} />
										Synced
									</span>
								{/if}
								{#if syncState === 'error'}
									<span class="badge badge-soft badge-error">
										<XCircle size={12} />
										Failed
									</span>
								{/if}
							</div>

							<div class="grid gap-1 text-sm text-base-content/70">
								<div class="flex items-center gap-2">
									<Clock3 size={14} class="text-base-content/50" />
									<span>
										Offset: {syncResult
											? syncResult.offsetMs !== 0
												? formatOffset(syncResult.offsetMs)
												: formatOffset(subtitle.syncOffset)
											: formatOffset(subtitle.syncOffset)}
									</span>
								</div>
								{#if syncState === 'error' && syncResult?.error}
									<div class="text-error">{syncResult.error}</div>
								{/if}
								<div>Added: {formatDisplayDateShort(subtitle.dateAdded)}</div>
								{#if subtitle.matchScore !== null && subtitle.matchScore !== undefined}
									<div>Match score: {subtitle.matchScore}</div>
								{/if}
							</div>
						</div>

						<button
							class="btn gap-2 btn-primary btn-sm"
							onclick={() => handleSync(subtitle.id)}
							disabled={syncingSubtitleId === subtitle.id ||
								syncState === 'syncing' ||
								bulkSyncStatus === 'syncing'}
						>
							{#if syncingSubtitleId === subtitle.id || syncState === 'syncing'}
								<Loader2 size={14} class="animate-spin" />
								Syncing
							{:else}
								<RefreshCw size={14} />
								Re-sync
							{/if}
						</button>
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<!-- Multiple episodes - group by episode label -->
		<div class="space-y-2">
			{#each [...groupedSubtitles] as [label, groupSubs] (label)}
				{@const isExpanded = expandedGroups.has(label)}
				{@const summary = getGroupSyncSummary(groupSubs)}
				<div class="overflow-hidden rounded-lg border border-base-300 bg-base-100">
					<!-- Group header -->
					<button
						class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-base-200/50"
						onclick={() => toggleGroup(label)}
					>
						{#if isExpanded}
							<ChevronDown size={16} class="shrink-0 text-base-content/50" />
						{:else}
							<ChevronRight size={16} class="shrink-0 text-base-content/50" />
						{/if}

						<span class="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>

						<div class="flex shrink-0 items-center gap-2">
							<span class="badge badge-ghost badge-sm">
								{groupSubs.length} sub{groupSubs.length !== 1 ? 's' : ''}
							</span>
							{#if summary.synced === summary.total}
								<span class="badge badge-xs badge-success">All synced</span>
							{:else if summary.synced > 0}
								<span class="badge badge-xs badge-primary">{summary.synced}/{summary.total}</span>
							{/if}
							{#if summary.inProgress}
								<Loader2 size={14} class="animate-spin text-primary" />
							{/if}
						</div>
					</button>

					<!-- Group content -->
					{#if isExpanded}
						<div class="space-y-2 border-t border-base-300 p-3">
							{#each groupSubs as subtitle (subtitle.id)}
								{@const syncState = getSubtitleSyncState(subtitle.id)}
								{@const syncResult = bulkSyncResults.get(subtitle.id)}
								<div
									class="rounded-lg border border-base-200 bg-base-200/30 p-3"
									class:border-success={syncState === 'success'}
									class:border-error={syncState === 'error'}
								>
									<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
										<div class="flex flex-wrap items-center gap-2">
											<span class="badge badge-outline badge-sm">
												{subtitle.language.toUpperCase()}
											</span>
											{#if subtitle.format}
												<span class="badge badge-ghost badge-sm">
													{subtitle.format.toUpperCase()}
												</span>
											{/if}
											{#if subtitle.isForced}
												<span class="badge badge-soft badge-sm badge-secondary">Forced</span>
											{/if}
											{#if subtitle.isHearingImpaired}
												<span class="badge badge-soft badge-sm badge-info">HI</span>
											{/if}
											{#if syncState === 'success' || (!syncState && subtitle.wasSynced)}
												<span class="badge badge-soft badge-sm badge-accent">
													<CheckCircle2 size={10} />
													Synced
												</span>
											{/if}
											{#if syncState === 'error'}
												<span class="badge badge-soft badge-sm badge-error">
													<XCircle size={10} />
													Failed
												</span>
											{/if}

											<span class="text-xs text-base-content/50">
												{syncResult
													? syncResult.offsetMs !== 0
														? formatOffset(syncResult.offsetMs)
														: formatOffset(subtitle.syncOffset)
													: formatOffset(subtitle.syncOffset)}
											</span>
										</div>

										<button
											class="btn gap-1 btn-primary btn-xs"
											onclick={() => handleSync(subtitle.id)}
											disabled={syncingSubtitleId === subtitle.id ||
												syncState === 'syncing' ||
												bulkSyncStatus === 'syncing'}
										>
											{#if syncingSubtitleId === subtitle.id || syncState === 'syncing'}
												<Loader2 size={12} class="animate-spin" />
												Syncing
											{:else}
												<RefreshCw size={12} />
												Re-sync
											{/if}
										</button>
									</div>
									{#if syncState === 'error' && syncResult?.error}
										<p class="mt-1 text-xs text-error">{syncResult.error}</p>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</ModalWrapper>
