<script lang="ts">
	import { X, Loader2, StopCircle, CheckCircle2, XCircle, Search } from '@lucide/svelte';
	import { onMount, onDestroy } from 'svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { getWorker, deleteWorker } from '#lib/api/settings.js';
	import * as m from '#lib/paraglide/messages.js';

	interface WorkerState {
		id: string;
		type: string;
		status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
		progress: number;
		createdAt: string;
		startedAt?: string;
		completedAt?: string;
		error?: string;
		metadata: {
			portalId: string;
			portalName: string;
			portalUrl: string;
			scanType: string;
			totalMacs: number;
			testedMacs: number;
			foundMacs: number;
			currentMac?: string;
			rateLimit: number;
			[key: string]: unknown;
		};
	}

	interface Props {
		workerId: string;
		onClose: () => void;
		onComplete: () => void;
	}

	let { workerId, onClose, onComplete }: Props = $props();

	let worker = $state<WorkerState | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let cancelling = $state(false);
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	// Derived values
	const isActive = $derived(worker?.status === 'pending' || worker?.status === 'running');
	const isCompleted = $derived(worker?.status === 'completed');
	const _isFailed = $derived(worker?.status === 'failed');
	const isCancelled = $derived(worker?.status === 'cancelled');

	const progressPercent = $derived(worker?.progress ?? 0);
	const testedCount = $derived(worker?.metadata?.testedMacs ?? 0);
	const totalCount = $derived(worker?.metadata?.totalMacs ?? 0);
	const foundCount = $derived(worker?.metadata?.foundMacs ?? 0);
	const currentMac = $derived(worker?.metadata?.currentMac ?? '');

	const elapsedTime = $derived(() => {
		if (!worker?.startedAt) return '0s';
		const start = new Date(worker.startedAt).getTime();
		const end = worker.completedAt ? new Date(worker.completedAt).getTime() : Date.now();
		const seconds = Math.floor((end - start) / 1000);

		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const remainingSeconds = seconds % 60;
		if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
		const hours = Math.floor(minutes / 60);
		const remainingMinutes = minutes % 60;
		return `${hours}h ${remainingMinutes}m`;
	});

	const estimatedTimeRemaining = $derived(() => {
		if (!worker?.startedAt || testedCount === 0 || !isActive) return null;
		const start = new Date(worker.startedAt).getTime();
		const elapsed = Date.now() - start;
		const rate = testedCount / elapsed;
		const remaining = (totalCount - testedCount) / rate;
		const seconds = Math.floor(remaining / 1000);

		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `~${minutes}m`;
		const hours = Math.floor(minutes / 60);
		return `~${hours}h`;
	});

	onMount(() => {
		fetchWorker();
		pollInterval = setInterval(fetchWorker, 1500);
	});

	onDestroy(() => {
		if (pollInterval) {
			clearInterval(pollInterval);
		}
	});

	async function fetchWorker() {
		try {
			const result = await getWorker(workerId);
			worker = result as unknown as WorkerState;
			loading = false;

			// Stop polling if no longer active
			if (!isActive && pollInterval) {
				clearInterval(pollInterval);
				pollInterval = null;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : m.livetv_portalScanProgress_failedToLoadWorker();
			loading = false;
			if (pollInterval) {
				clearInterval(pollInterval);
				pollInterval = null;
			}
		}
	}

	async function handleCancel() {
		cancelling = true;
		try {
			await deleteWorker(workerId);
			await fetchWorker();
		} catch (e) {
			toasts.error(
				e instanceof Error ? e.message : m.livetv_portalScanProgress_failedToCancelScan()
			);
		} finally {
			cancelling = false;
		}
	}

	function handleViewResults() {
		onComplete();
	}
</script>

<div class="rounded-lg border border-base-300 bg-base-100 p-6">
	<!-- Header -->
	<div class="mb-6 flex items-center justify-between">
		<div class="flex items-center gap-3">
			<div
				class="flex h-10 w-10 items-center justify-center rounded-full {isActive
					? 'bg-primary/10'
					: isCompleted
						? 'bg-success/10'
						: 'bg-error/10'}"
			>
				{#if isActive}
					<Loader2 class="h-5 w-5 animate-spin text-primary" />
				{:else if isCompleted}
					<CheckCircle2 class="h-5 w-5 text-success" />
				{:else if isCancelled}
					<StopCircle class="h-5 w-5 text-warning" />
				{:else}
					<XCircle class="h-5 w-5 text-error" />
				{/if}
			</div>
			<div>
				<h3 class="text-lg font-bold">
					{#if isActive}
						{m.livetv_portalScanProgress_scanningPortal({
							name: worker?.metadata.portalName ?? ''
						})}
					{:else if isCompleted}
						{m.livetv_portalScanProgress_scanComplete()}
					{:else if isCancelled}
						{m.livetv_portalScanProgress_scanCancelled()}
					{:else}
						{m.livetv_portalScanProgress_scanFailed()}
					{/if}
				</h3>
				{#if worker}
					<div class="text-sm text-base-content/60">
						{worker.metadata.portalName}
					</div>
				{/if}
			</div>
		</div>
		<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
			<X class="h-4 w-4" />
		</button>
	</div>

	{#if loading}
		<div class="flex items-center justify-center py-8">
			<Loader2 class="h-6 w-6 animate-spin text-primary" />
		</div>
	{:else if error}
		<div class="alert alert-error">
			<span>{error}</span>
		</div>
	{:else if worker}
		<!-- Progress Bar -->
		<div class="mb-6">
			<div class="mb-2 flex items-center justify-between text-sm">
				<span>{m.livetv_portalScanProgress_progressLabel()}</span>
				<span>{progressPercent.toFixed(1)}%</span>
			</div>
			<progress
				class="progress w-full {isActive
					? 'progress-primary'
					: isCompleted
						? 'progress-success'
						: 'progress-error'}"
				value={progressPercent}
				max="100"
			></progress>
		</div>

		<!-- Stats Grid -->
		<div class="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
			<div class="rounded-lg bg-base-200 p-3 text-center">
				<div class="text-2xl font-bold">{testedCount.toLocaleString(undefined)}</div>
				<div class="text-xs text-base-content/60">{m.livetv_portalScanProgress_tested()}</div>
			</div>
			<div class="rounded-lg bg-base-200 p-3 text-center">
				<div class="text-2xl font-bold">{totalCount.toLocaleString(undefined)}</div>
				<div class="text-xs text-base-content/60">{m.livetv_portalScanProgress_total()}</div>
			</div>
			<div class="rounded-lg bg-success/10 p-3 text-center">
				<div class="text-2xl font-bold text-success">{foundCount}</div>
				<div class="text-xs text-base-content/60">{m.livetv_portalScanProgress_found()}</div>
			</div>
			<div class="rounded-lg bg-base-200 p-3 text-center">
				<div class="text-lg font-medium">{elapsedTime()}</div>
				<div class="text-xs text-base-content/60">{m.livetv_portalScanProgress_elapsed()}</div>
			</div>
		</div>

		<!-- Current MAC -->
		{#if isActive && currentMac}
			<div class="mb-6">
				<div class="text-sm text-base-content/60">
					{m.livetv_portalScanProgress_currentlyTesting({ mac: currentMac })}
				</div>
				<div class="font-mono text-lg">{currentMac}</div>
				{#if estimatedTimeRemaining()}
					<div class="text-sm text-base-content/60">
						{m.livetv_portalScanProgress_timeRemaining()}
						{estimatedTimeRemaining()}
					</div>
				{/if}
			</div>
		{/if}

		<!-- Error message -->
		{#if worker.error}
			<div class="mb-6 alert alert-error">
				<XCircle class="h-5 w-5" />
				<span>{worker.error}</span>
			</div>
		{/if}

		<!-- Scan Details -->
		<div class="mb-6 rounded-lg bg-base-200 p-4">
			<div class="grid grid-cols-2 gap-2 text-sm">
				<div class="text-base-content/60">{m.livetv_portalScanProgress_scanType()}:</div>
				<div class="capitalize">{worker.metadata.scanType}</div>
				<div class="text-base-content/60">{m.livetv_portalScanProgress_rateLimit()}:</div>
				<div>{worker.metadata.rateLimit}ms</div>
				<div class="text-base-content/60">{m.livetv_portalScanProgress_portalUrl()}:</div>
				<div class="truncate">{worker.metadata.portalUrl}</div>
			</div>
		</div>

		<!-- Actions -->
		<div class="flex justify-end gap-2">
			{#if isActive}
				<button class="btn btn-outline btn-error" onclick={handleCancel} disabled={cancelling}>
					{#if cancelling}
						<Loader2 class="h-4 w-4 animate-spin" />
					{:else}
						<StopCircle class="h-4 w-4" />
					{/if}
					{m.livetv_portalScanProgress_cancelScanButton()}
				</button>
			{:else}
				<button class="btn btn-ghost" onclick={onClose}
					>{m.livetv_portalScanProgress_closeButton()}</button
				>
				{#if foundCount > 0}
					<button class="btn btn-primary" onclick={handleViewResults}>
						<Search class="h-4 w-4" />
						{m.livetv_portalScanProgress_viewResults({ count: foundCount })}
					</button>
				{/if}
			{/if}
		</div>
	{/if}
</div>
