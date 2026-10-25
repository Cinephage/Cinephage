<script lang="ts">
	import type { UnifiedTask } from '#lib/server/tasks/UnifiedTaskRegistry.js';
	import type { TaskHistoryEntry } from '#lib/types/task.js';
	import * as m from '#lib/paraglide/messages.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import TaskIntervalCell from './TaskIntervalCell.svelte';
	import { formatDuration, formatDisplayDate } from '#lib/utils/format.js';

	interface Props {
		task: UnifiedTask;
		now: number;
		history: TaskHistoryEntry[];
		onRunTask: (taskId: string) => Promise<void>;
		onCancelTask?: (taskId: string) => Promise<void>;
		onToggleEnabled?: (taskId: string, enabled: boolean) => Promise<void>;
		onShowHistory: () => void;
	}

	let { task, now, history, onRunTask, onCancelTask, onToggleEnabled, onShowHistory }: Props =
		$props();

	let isCancelling = $state(false);

	$effect(() => {
		if (!task.isRunning) {
			isCancelling = false;
		}
	});

	const isRunning = $derived(task.isRunning);
	const lastRunStatus = $derived(history.length > 0 ? (history[0]?.status ?? null) : null);

	const liveTimeAgo = $derived.by(() => {
		if (!task.lastRunTime) return 'Never';
		const date = new Date(task.lastRunTime).getTime();
		const diffMs = now - date;
		if (diffMs < 0 || diffMs < 60000) return 'Just now';
		return `${formatDuration(diffMs)} ago`;
	});

	const liveTimeUntil = $derived.by(() => {
		if (!task.nextRunTime) return '—';
		const date = new Date(task.nextRunTime).getTime();
		const diffMs = date - now;
		if (diffMs <= 0) return 'Overdue';
		return `in ${formatDuration(diffMs)}`;
	});

	const isOverdue = $derived(
		task.nextRunTime ? new Date(task.nextRunTime).getTime() <= now : false
	);
	const isImminent = $derived.by(() => {
		if (!task.nextRunTime) return false;
		const diffMs = new Date(task.nextRunTime).getTime() - now;
		return diffMs > 0 && diffMs < 60000;
	});

	// Convert task ID to camelCase for translation lookup
	const camelCaseId = $derived(task.id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()));

	async function runTask() {
		if (isRunning) return;
		try {
			await onRunTask(task.id);
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Task failed');
		}
	}

	async function cancelTask() {
		if (!isRunning || isCancelling || !onCancelTask) return;
		isCancelling = true;
		try {
			await onCancelTask(task.id);
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Failed to cancel task');
		}
	}

	async function toggleEnabled() {
		if (onToggleEnabled) {
			await onToggleEnabled(task.id, !task.enabled);
		}
	}
</script>

<div class="rounded-lg border border-base-300 bg-base-100 p-3">
	<div class="flex items-start justify-between gap-3">
		<div class="min-w-0">
			<div class="truncate font-medium">
				{(m as unknown as Record<string, () => string>)[`task_name_${camelCaseId}`]?.() ??
					task.name}
			</div>
			<div class="mt-1 text-xs break-words text-base-content/60">
				{(m as unknown as Record<string, () => string>)[`task_desc_${camelCaseId}`]?.() ??
					task.description}
			</div>
		</div>
		{#if isRunning}
			<span class="badge gap-1 badge-sm badge-primary">
				<span class="loading loading-xs loading-spinner"></span>
				{m.task_card_running()}
			</span>
		{:else if lastRunStatus === 'failed'}
			<span class="badge badge-sm badge-error">{m.task_card_failed()}</span>
		{:else if lastRunStatus === 'completed'}
			<span class="badge badge-sm badge-success">OK</span>
		{/if}
	</div>

	<div class="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
		{#if task.category === 'scheduled'}
			<div class="text-base-content/60">{m.task_card_interval()}</div>
			<div class="justify-self-end">
				<TaskIntervalCell {task} />
			</div>

			<div class="text-base-content/60">{m.task_card_lastRun()}</div>
			<div class="justify-self-end tabular-nums" title={task.lastRunTime || ''}>{liveTimeAgo}</div>

			<div class="text-base-content/60">{m.task_card_nextRun()}</div>
			<div class="justify-self-end tabular-nums">
				{#if task.isRunning}
					<span class="text-primary">{m.task_card_running()}</span>
				{:else if task.nextRunTime}
					<span
						class="{isOverdue ? 'font-medium text-warning' : ''} {isImminent
							? 'animate-pulse text-success'
							: ''}"
						title={task.nextRunTime
							? formatDisplayDate(task.nextRunTime, {
									month: 'short',
									day: 'numeric',
									hour: 'numeric',
									minute: '2-digit'
								})
							: ''}
					>
						{liveTimeUntil}
					</span>
				{:else}
					<span class="text-base-content/40">—</span>
				{/if}
			</div>
		{:else}
			<div class="text-base-content/60">{m.task_card_type()}</div>
			<div class="justify-self-end">{m.task_card_manual()}</div>

			<div class="text-base-content/60">{m.task_card_lastRun()}</div>
			<div class="justify-self-end tabular-nums" title={task.lastRunTime || ''}>{liveTimeAgo}</div>
		{/if}
	</div>

	<div class="mt-3 flex items-center justify-between gap-2">
		<label class="label cursor-pointer gap-2 p-0">
			<span class="text-xs text-base-content/70">{m.task_card_enabled()}</span>
			<input
				type="checkbox"
				class="toggle toggle-xs"
				checked={task.enabled}
				onchange={toggleEnabled}
				disabled={task.isRunning}
			/>
		</label>

		<div class="flex items-center gap-1">
			{#if isRunning}
				<button
					class="btn gap-1 btn-ghost text-error btn-xs"
					onclick={cancelTask}
					disabled={isCancelling}
				>
					{#if isCancelling}
						<span class="loading loading-xs loading-spinner"></span>
					{:else}
						{m.action_cancel()}
					{/if}
				</button>
			{:else}
				<button class="btn gap-1 btn-primary btn-xs" onclick={runTask} disabled={!task.enabled}>
					{m.action_run()}
				</button>
			{/if}
			<button class="btn gap-1 btn-ghost btn-xs" onclick={onShowHistory}
				>{m.task_card_history()}</button
			>
		</div>
	</div>
</div>
