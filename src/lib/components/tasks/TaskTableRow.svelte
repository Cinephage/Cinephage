<script lang="ts">
	import { History } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type { UnifiedTask } from '#lib/server/tasks/UnifiedTaskRegistry.js';
	import type { TaskHistoryEntry } from '#lib/types/task.js';
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

	// Reset cancelling state when task stops running
	$effect(() => {
		if (!task.isRunning) {
			isCancelling = false;
		}
	});

	// Derive isRunning from the task prop (single source of truth from parent's taskMap)
	const isRunning = $derived(task.isRunning);

	// Derived state for last run status (value, not function)
	const lastRunStatus = $derived(history.length > 0 ? (history[0]?.status ?? null) : null);

	// Live-computed "time ago" string that updates every second
	const liveTimeAgo = $derived.by(() => {
		if (!task.lastRunTime) return 'Never';
		const date = new Date(task.lastRunTime).getTime();
		const diffMs = now - date;
		if (diffMs < 0) return 'Just now';
		if (diffMs < 60000) return 'Just now';
		return `${formatDuration(diffMs)} ago`;
	});

	// Live-computed "time until" string that updates every second
	const liveTimeUntil = $derived.by(() => {
		if (!task.nextRunTime) return '—';
		const date = new Date(task.nextRunTime).getTime();
		const diffMs = date - now;
		if (diffMs <= 0) return 'Overdue';
		return `in ${formatDuration(diffMs)}`;
	});

	// Whether the next run is overdue
	const isOverdue = $derived(
		task.nextRunTime ? new Date(task.nextRunTime).getTime() <= now : false
	);

	// Whether the next run is imminent (< 1 minute)
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

<tr class="group hover:bg-base-200/50 {task.isRunning ? 'bg-primary/5' : ''}">
	<!-- Task Name -->
	<td class="max-w-0">
		<div class="flex items-center gap-3">
			<div class="min-w-0 flex-1">
				<div class="truncate font-medium">
					{(m as unknown as Record<string, () => string>)[`task_name_${camelCaseId}`]?.() ??
						task.name}
				</div>
				<div class="text-sm text-base-content/60">
					{(m as unknown as Record<string, () => string>)[`task_desc_${camelCaseId}`]?.() ??
						task.description}
				</div>
			</div>
			{#if task.isRunning}
				<span class="badge gap-1 badge-sm badge-primary">
					<span class="loading loading-xs loading-spinner"></span>
					{m.task_row_running()}
				</span>
			{:else if lastRunStatus === 'completed'}
				<span class="badge badge-sm badge-success">OK</span>
			{:else if lastRunStatus === 'failed'}
				<span class="badge badge-sm badge-error">{m.task_row_failed()}</span>
			{/if}
		</div>
	</td>

	{#if task.category === 'scheduled'}
		<!-- Interval -->
		<td>
			<TaskIntervalCell {task} />
		</td>

		<!-- Last Run -->
		<td
			class="text-sm whitespace-nowrap tabular-nums"
			title={task.lastRunTime
				? formatDisplayDate(task.lastRunTime, {
						month: 'short',
						day: 'numeric',
						hour: 'numeric',
						minute: '2-digit'
					})
				: ''}
		>
			{liveTimeAgo}
		</td>

		<!-- Next Run -->
		<td class="text-sm whitespace-nowrap tabular-nums">
			{#if task.isRunning}
				<span class="text-primary">{m.task_row_running()}</span>
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
		</td>
	{:else}
		<!-- Type -->
		<td class="text-sm text-base-content/60">{m.task_row_manual()}</td>

		<!-- Last Run -->
		<td
			class="text-sm whitespace-nowrap tabular-nums"
			title={task.lastRunTime
				? formatDisplayDate(task.lastRunTime, {
						month: 'short',
						day: 'numeric',
						hour: 'numeric',
						minute: '2-digit'
					})
				: ''}
		>
			{liveTimeAgo}
		</td>
	{/if}

	<!-- Status (Enabled/Disabled) -->
	<td>
		<label class="swap swap-rotate">
			<input
				type="checkbox"
				class="toggle toggle-sm"
				checked={task.enabled}
				onchange={toggleEnabled}
				disabled={task.isRunning}
			/>
		</label>
	</td>

	<!-- Actions -->
	<td>
		<div class="flex items-center gap-1">
			{#if isRunning}
				<button
					class="btn btn-square btn-ghost text-error btn-xs"
					onclick={cancelTask}
					disabled={isCancelling}
					title={m.action_cancel()}
				>
					{#if isCancelling}
						<span class="loading loading-xs loading-spinner"></span>
					{:else}
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
						</svg>
					{/if}
				</button>
			{:else}
				<button
					class="btn btn-square btn-ghost btn-xs"
					onclick={runTask}
					disabled={!task.enabled}
					title={m.task_table_runNow()}
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<polygon points="5 3 19 12 5 21 5 3" />
					</svg>
				</button>
			{/if}

			<button
				class="btn btn-square btn-ghost btn-xs"
				onclick={onShowHistory}
				title={m.task_table_viewHistory()}
			>
				<History class="h-4 w-4" />
			</button>
		</div>
	</td>
</tr>
