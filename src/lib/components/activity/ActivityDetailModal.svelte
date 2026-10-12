<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		isImportFailedActivity,
		TASK_TYPE_LABELS,
		type UnifiedActivity
	} from '#lib/types/activity.js';
	import { formatBytes } from '#lib/utils/format.js';
	import {
		X,
		Clapperboard,
		Tv,
		Pause,
		Play,
		RotateCcw,
		Trash2,
		Info,
		Folder
	} from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { createFocusTrap, lockBodyScroll } from '#lib/utils/focus.js';
	import { DeleteConfirmationModal } from '#lib/components/ui/modal/index.js';
	import {
		statusConfig,
		getStatusLabel,
		supportsQueuePauseResume,
		formatRelativeTime,
		getResolutionBadge
	} from './activity-display-utils.js';

	interface Props {
		open: boolean;
		activity: UnifiedActivity | null;
		onClose: () => void;
		onPause?: (id: string) => Promise<void>;
		onResume?: (id: string) => Promise<void>;
		onRemove?: (
			id: string,
			options: { deleteFiles: boolean; removeFromLibrary: boolean }
		) => Promise<void>;
		onRetry?: (id: string) => Promise<void>;
	}

	let { open, activity, onClose, onPause, onResume, onRemove, onRetry }: Props = $props();

	let activeTab = $state<'overview'>('overview');
	let actionLoading = $state(false);
	let removeConfirmOpen = $state(false);
	let modalRef = $state<HTMLElement | null>(null);
	let contentRef = $state<HTMLElement | null>(null);
	let cleanupFocusTrap: (() => void) | null = null;
	let cleanupScrollLock: (() => void) | null = null;

	async function handlePause() {
		if (!activity?.queueItemId || !onPause) return;
		actionLoading = true;
		try {
			await onPause(activity.queueItemId);
			toasts.success(m.activity_detail_downloadPaused());
		} catch (error) {
			const message = error instanceof Error ? error.message : m.activity_detail_failedToPause();
			toasts.error(message);
		} finally {
			actionLoading = false;
		}
	}

	async function handleResume() {
		if (!activity?.queueItemId || !onResume) return;
		actionLoading = true;
		try {
			await onResume(activity.queueItemId);
			toasts.success(m.activity_detail_downloadResumed());
		} catch (error) {
			const message = error instanceof Error ? error.message : m.activity_detail_failedToResume();
			toasts.error(message);
		} finally {
			actionLoading = false;
		}
	}

	function requestRemove() {
		if (!activity?.queueItemId || !onRemove || actionLoading) return;
		removeConfirmOpen = true;
	}

	function cancelRemove() {
		if (actionLoading) return;
		removeConfirmOpen = false;
	}

	async function handleRemove(deleteFiles: boolean, removeFromLibrary: boolean) {
		if (!activity?.queueItemId || !onRemove) return;
		actionLoading = true;
		try {
			await onRemove(activity.queueItemId, { deleteFiles, removeFromLibrary });
			toasts.success(
				removeFromLibrary
					? m.toast_library_movieDetail_movieRemoved()
					: m.activity_detail_downloadRemoved()
			);
			removeConfirmOpen = false;
			onClose();
		} catch (error) {
			const message = error instanceof Error ? error.message : m.activity_detail_failedToRemove();
			toasts.error(message);
		} finally {
			actionLoading = false;
		}
	}

	async function handleRetry() {
		if (!activity?.queueItemId || !onRetry) return;
		// Capture stable references before async gap — reactive props can change after await
		const queueItemId = activity.queueItemId;
		const isImportFailed = activity.status === 'failed' && isImportFailedActivity(activity);
		actionLoading = true;
		try {
			await onRetry(queueItemId);
			toasts.success(
				isImportFailed
					? m.activity_detail_importRetryInitiated()
					: m.activity_detail_downloadRetryInitiated()
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : m.activity_detail_failedToRetry();
			toasts.error(message);
		} finally {
			actionLoading = false;
		}
	}

	function isTypingTarget(target: EventTarget | null): boolean {
		const element = target instanceof HTMLElement ? target : null;
		if (!element) return false;
		const tagName = element.tagName;
		return (
			tagName === 'INPUT' ||
			tagName === 'TEXTAREA' ||
			tagName === 'SELECT' ||
			element.isContentEditable ||
			element.closest('[contenteditable="true"]') !== null
		);
	}

	function handleModalKeydown(e: KeyboardEvent) {
		if (!open || !activity) return;

		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
			return;
		}

		if (!contentRef || isTypingTarget(e.target)) return;

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
		if (open && activity && modalRef && !removeConfirmOpen) {
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

	$effect(() => {
		if (!open || !contentRef) return;
		contentRef.scrollTo({ top: 0, behavior: 'auto' });
		activeTab = 'overview';
	});
</script>

{#if activity}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 transition-opacity duration-150 {open
			? 'pointer-events-auto opacity-100'
			: 'pointer-events-none opacity-0'}"
		onclick={onClose}
		role="presentation"
		aria-hidden={!open}
	>
		<div
			bind:this={modalRef}
			class="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-2xl bg-base-100 shadow-2xl"
			onclick={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal={open}
			tabindex={open ? 0 : -1}
			onkeydown={handleModalKeydown}
		>
			<!-- Header -->
			<div class="border-b border-base-200 bg-base-100 p-6">
				<div class="flex items-start justify-between gap-4">
					<div class="flex items-start gap-4">
						<div class="rounded-xl bg-base-200 p-3">
							{#if activity.mediaType === 'movie'}
								<Clapperboard class="h-6 w-6" />
							{:else}
								<Tv class="h-6 w-6" />
							{/if}
						</div>
						<div>
							<h2 class="text-xl font-bold">{activity.mediaTitle}</h2>
							{#if activity.mediaYear}
								<span class="text-base-content/60">({activity.mediaYear})</span>
							{/if}
							{#if activity.releaseTitle}
								<p class="mt-1 text-sm text-base-content/60">{activity.releaseTitle}</p>
							{/if}
						</div>
					</div>
					<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
						<X class="h-5 w-5" />
					</button>
				</div>

				<!-- Status Badge -->
				{#if statusConfig[activity.status]}
					{@const config = statusConfig[activity.status]}
					<div class="mt-4 flex items-center gap-3">
						<span class="badge gap-2 {config.variant} badge-lg">
							<config.icon
								class="h-4 w-4 {activity.status === 'downloading' || activity.status === 'searching'
									? 'animate-spin'
									: ''}"
							/>
							{getStatusLabel(activity)}
							{#if activity.status === 'downloading' && activity.downloadProgress !== undefined}
								({activity.downloadProgress}%)
							{/if}
						</span>
						{#if activity.isUpgrade}
							<span class="badge badge-sm badge-warning">{m.activity_detail_upgrade()}</span>
						{/if}
						<span class="text-sm text-base-content/60">
							{formatRelativeTime(
								activity.status === 'failed' && activity.lastAttemptAt
									? activity.lastAttemptAt
									: activity.status === 'search_error' && activity.lastAttemptAt
										? activity.lastAttemptAt
										: activity.completedAt &&
											  [
													'imported',
													'streaming',
													'removed',
													'rejected',
													'no_results',
													'search_error'
											  ].includes(activity.status)
											? activity.completedAt
											: activity.startedAt
							)}
						</span>
					</div>
				{/if}

				<!-- Queue Actions -->
				{#if activity.queueItemId}
					<div class="mt-4 flex flex-wrap gap-2">
						{#if supportsQueuePauseResume(activity) && (activity.status === 'downloading' || activity.status === 'seeding')}
							<button class="btn btn-ghost btn-sm" onclick={handlePause} disabled={actionLoading}>
								<Pause class="h-4 w-4" />
								{m.action_pause()}
							</button>
						{:else if supportsQueuePauseResume(activity) && activity.status === 'paused'}
							<button class="btn btn-ghost btn-sm" onclick={handleResume} disabled={actionLoading}>
								<Play class="h-4 w-4" />
								{m.action_resume()}
							</button>
						{/if}
						{#if activity.status === 'failed'}
							<button class="btn btn-ghost btn-sm" onclick={handleRetry} disabled={actionLoading}>
								<RotateCcw class="h-4 w-4" />
								{isImportFailedActivity(activity)
									? m.activity_detail_retryImport()
									: m.common_retry()}
							</button>
						{/if}
						<button
							class="btn btn-ghost btn-error btn-sm"
							onclick={requestRemove}
							disabled={actionLoading}
						>
							<Trash2 class="h-4 w-4" />
							{m.action_remove()}
						</button>
					</div>
				{/if}
			</div>

			<!-- Tabs -->
			<div class="tabs-bordered tabs border-b border-base-200 px-6">
				<button
					class="tab gap-2 {activeTab === 'overview' ? 'tab-active' : ''}"
					onclick={() => (activeTab = 'overview')}
				>
					<Info class="h-4 w-4" />
					{m.common_overview()}
				</button>
			</div>

			<!-- Content -->
			<div bind:this={contentRef} class="max-h-[50vh] overflow-y-auto p-6">
				<!-- Overview Tab -->
				{#if activeTab === 'overview'}
					<div class="space-y-6">
						<!-- Basic Info -->
						<div class="grid gap-4 sm:grid-cols-2">
							<div class="space-y-1">
								<span class="text-sm text-base-content/60">{m.activity_detail_mediaType()}</span>
								<p class="font-medium capitalize">{activity.mediaType}</p>
							</div>
							<div class="space-y-1">
								<span class="text-sm text-base-content/60">{m.common_status()}</span>
								<p class="font-medium">{getStatusLabel(activity)}</p>
							</div>
							{#if activity.activitySource === 'monitoring' && activity.taskType}
								<div class="space-y-1">
									<span class="text-sm text-base-content/60">{m.activity_detail_taskType()}</span>
									<p class="font-medium">
										{TASK_TYPE_LABELS[activity.taskType] ?? activity.taskType}
									</p>
								</div>
							{/if}
							<div class="space-y-1">
								<span class="text-sm text-base-content/60">{m.common_size()}</span>
								<p class="font-medium">{formatBytes(activity.size)}</p>
							</div>
							<div class="space-y-1">
								<span class="text-sm text-base-content/60">{m.activity_detail_protocol()}</span>
								<p class="font-medium uppercase">{activity.protocol || '-'}</p>
							</div>
							<div class="space-y-1">
								<span class="text-sm text-base-content/60">{m.activity_detail_indexer()}</span>
								<p class="font-medium">{activity.indexerName || '-'}</p>
							</div>
							<div class="space-y-1">
								<span class="text-sm text-base-content/60">{m.activity_detail_releaseGroup()}</span>
								<p class="font-medium">{activity.releaseGroup || '-'}</p>
							</div>
							{#if activity.transferMode}
								<div class="space-y-1">
									<span class="text-sm text-base-content/60"
										>{m.activity_detail_transferMode()}</span
									>
									<p
										class="font-medium"
										class:text-warning={activity.transferMode === 'copy'}
										title={activity.transferMode === 'copy'
											? m.activity_detail_transferModeCopyWarning()
											: undefined}
									>
										{activity.transferMode === 'hardlink'
											? m.activity_detail_transferModeHardlink()
											: activity.transferMode === 'copy'
												? m.activity_detail_transferModeCopy()
												: activity.transferMode === 'move'
													? m.activity_detail_transferModeMove()
													: m.activity_detail_transferModeSymlink()}
									</p>
								</div>
							{/if}
						</div>

						<!-- Quality -->
						{#if activity.quality}
							<div>
								<span class="text-sm text-base-content/60">{m.common_quality()}</span>
								<div class="mt-1 flex flex-wrap gap-2">
									{#if getResolutionBadge(activity)}
										<span class="badge badge-outline">{getResolutionBadge(activity)}</span>
									{/if}
									{#if activity.quality.source}
										<span class="badge badge-outline">{activity.quality.source}</span>
									{/if}
									{#if activity.quality.codec}
										<span class="badge badge-outline">{activity.quality.codec}</span>
									{/if}
									{#if activity.quality.hdr}
										<span class="badge badge-outline">{activity.quality.hdr}</span>
									{/if}
								</div>
							</div>
						{/if}

						<!-- Import Path -->
						{#if activity.importedPath}
							<div>
								<span class="text-sm text-base-content/60">{m.activity_detail_importedTo()}</span>
								<div class="mt-1 flex items-center gap-2">
									<Folder class="h-4 w-4 text-base-content/40" />
									<code class="text-sm">{activity.importedPath}</code>
								</div>
							</div>
						{/if}

						<!-- Status Reason -->
						{#if activity.statusReason}
							<div>
								<span class="text-sm text-base-content/60">{m.activity_detail_statusReason()}</span>
								<p class="mt-1 text-sm">{activity.statusReason}</p>
							</div>
						{/if}

						<!-- Timeline -->
						{#if activity.timeline.length > 0}
							<div>
								<span class="text-sm text-base-content/60">{m.activity_detail_timeline()}</span>
								<div class="mt-2 space-y-2">
									{#each activity.timeline as event, i (event.timestamp + '-' + i)}
										<div class="flex items-center gap-3">
											<div
												class="flex h-6 w-6 items-center justify-center rounded-full bg-base-200 text-xs"
											>
												{i + 1}
											</div>
											<div class="flex-1">
												<span class="font-medium capitalize">{event.type}</span>
												<span class="text-sm text-base-content/60">
													{formatRelativeTime(event.timestamp)}
												</span>
											</div>
											{#if event.details && (!activity.statusReason || event.details
														.trim()
														.toLowerCase() !== activity.statusReason.trim().toLowerCase())}
												<span class="text-sm text-base-content/60">{event.details}</span>
											{/if}
										</div>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<DeleteConfirmationModal
	open={removeConfirmOpen}
	title={m.activity_detail_removeConfirmTitle()}
	itemName={activity?.releaseTitle || activity?.mediaTitle || ''}
	allowRemoveFromLibrary={activity?.mediaType === 'movie' && !!activity?.mediaId}
	hasFiles
	defaultDeleteFiles
	loading={actionLoading}
	onConfirm={handleRemove}
	onCancel={cancelRemove}
/>
