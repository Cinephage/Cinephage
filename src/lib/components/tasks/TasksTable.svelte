<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { UnifiedTask } from '#lib/server/tasks/UnifiedTaskRegistry.js';
	import type { TaskHistoryEntry } from '#lib/types/task.js';
	import TaskTableRow from './TaskTableRow.svelte';
	import TaskCard from './TaskCard.svelte';
	import TaskHistoryModal from './TaskHistoryModal.svelte';

	interface Props {
		tasks: UnifiedTask[];
		taskHistory: Record<string, TaskHistoryEntry[]>;
		onRunTask: (taskId: string) => Promise<void>;
		onCancelTask?: (taskId: string) => Promise<void>;
		onToggleEnabled?: (taskId: string, enabled: boolean) => Promise<void>;
	}

	let { tasks, taskHistory, onRunTask, onCancelTask, onToggleEnabled }: Props = $props();

	// Group tasks by category
	const scheduledTasks = $derived(tasks.filter((t) => t.category === 'scheduled'));
	const maintenanceTasks = $derived(tasks.filter((t) => t.category === 'maintenance'));

	// Track expanded sections
	let scheduledExpanded = $state(true);
	let maintenanceExpanded = $state(true);

	// History modal state
	let selectedTask: UnifiedTask | null = $state(null);
	let showHistoryModal = $state(false);
	let now = $state(Date.now());

	$effect(() => {
		const interval = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(interval);
	});

	function openHistory(task: UnifiedTask) {
		selectedTask = task;
		showHistoryModal = true;
	}

	function closeHistory() {
		showHistoryModal = false;
		selectedTask = null;
	}
</script>

<div class="space-y-4">
	<!-- Scheduled Tasks Section -->
	{#if scheduledTasks.length > 0}
		<div class="overflow-hidden rounded-lg bg-base-200">
			<button
				class="flex w-full items-center justify-between bg-base-300 px-3 py-2.5 transition-colors hover:bg-base-300/80 sm:px-4 sm:py-3"
				onclick={() => (scheduledExpanded = !scheduledExpanded)}
			>
				<div class="flex items-center gap-3">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="text-primary"
					>
						<circle cx="12" cy="12" r="10" />
						<polyline points="12 6 12 12 16 14" />
					</svg>
					<span class="font-semibold">{m.task_table_scheduledTasks()}</span>
					<span class="badge badge-ghost badge-sm">{scheduledTasks.length}</span>
				</div>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="20"
					height="20"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="transition-transform {scheduledExpanded ? 'rotate-180' : ''}"
				>
					<polyline points="6 9 12 15 18 9" />
				</svg>
			</button>

			{#if scheduledExpanded}
				<div class="space-y-2 p-3 md:hidden">
					{#each scheduledTasks as task (task.id)}
						<TaskCard
							{task}
							{now}
							history={taskHistory[task.id] ?? []}
							{onRunTask}
							{onCancelTask}
							{onToggleEnabled}
							onShowHistory={() => openHistory(task)}
						/>
					{/each}
				</div>
				<div class="hidden overflow-x-auto md:block">
					<table class="table w-full table-fixed table-zebra">
						<thead>
							<tr>
								<th>{m.task_table_colTask()}</th>
								<th class="w-20">{m.task_table_colInterval()}</th>
								<th class="w-28">{m.task_table_colLastRun()}</th>
								<th class="w-28">{m.task_table_colNextRun()}</th>
								<th class="w-16">{m.task_table_colStatus()}</th>
								<th class="w-20"></th>
							</tr>
						</thead>
						<tbody>
							{#each scheduledTasks as task (task.id)}
								<TaskTableRow
									{task}
									{now}
									history={taskHistory[task.id] ?? []}
									{onRunTask}
									{onCancelTask}
									{onToggleEnabled}
									onShowHistory={() => openHistory(task)}
								/>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Maintenance Tasks Section -->
	{#if maintenanceTasks.length > 0}
		<div class="overflow-hidden rounded-lg bg-base-200">
			<button
				class="flex w-full items-center justify-between bg-base-300 px-3 py-2.5 transition-colors hover:bg-base-300/80 sm:px-4 sm:py-3"
				onclick={() => (maintenanceExpanded = !maintenanceExpanded)}
			>
				<div class="flex items-center gap-3">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="text-secondary"
					>
						<path
							d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
						/>
					</svg>
					<span class="font-semibold">{m.task_table_maintenanceTasks()}</span>
					<span class="badge badge-ghost badge-sm">{maintenanceTasks.length}</span>
				</div>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="20"
					height="20"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="transition-transform {maintenanceExpanded ? 'rotate-180' : ''}"
				>
					<polyline points="6 9 12 15 18 9" />
				</svg>
			</button>

			{#if maintenanceExpanded}
				<div class="space-y-2 p-3 md:hidden">
					{#each maintenanceTasks as task (task.id)}
						<TaskCard
							{task}
							{now}
							history={taskHistory[task.id] ?? []}
							{onRunTask}
							{onCancelTask}
							{onToggleEnabled}
							onShowHistory={() => openHistory(task)}
						/>
					{/each}
				</div>
				<div class="hidden overflow-x-auto md:block">
					<table class="table w-full table-fixed table-zebra">
						<thead>
							<tr>
								<th>{m.task_table_colTask()}</th>
								<th class="w-20">{m.task_table_colType()}</th>
								<th class="w-28">{m.task_table_colLastRun()}</th>
								<th class="w-16">{m.task_table_colStatus()}</th>
								<th class="w-20"></th>
							</tr>
						</thead>
						<tbody>
							{#each maintenanceTasks as task (task.id)}
								<TaskTableRow
									{task}
									{now}
									history={taskHistory[task.id] ?? []}
									{onRunTask}
									{onCancelTask}
									{onToggleEnabled}
									onShowHistory={() => openHistory(task)}
								/>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Empty State -->
	{#if tasks.length === 0}
		<div class="card bg-base-200">
			<div class="card-body items-center py-12 text-center">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="48"
					height="48"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="mb-4 text-base-content/30"
				>
					<circle cx="12" cy="12" r="10" />
					<polyline points="12 6 12 12 16 14" />
				</svg>
				<h3 class="text-lg font-semibold">{m.task_table_noTasks()}</h3>
				<p class="text-base-content/60">{m.task_table_noTasksConfigured()}</p>
			</div>
		</div>
	{/if}
</div>

<!-- History Modal -->
{#if showHistoryModal && selectedTask}
	<TaskHistoryModal
		task={selectedTask}
		history={taskHistory[selectedTask.id] ?? []}
		onClose={closeHistory}
	/>
{/if}
