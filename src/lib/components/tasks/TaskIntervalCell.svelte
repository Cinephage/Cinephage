<script lang="ts">
	import { tick } from 'svelte';
	import type { UnifiedTask } from '#lib/server/tasks/UnifiedTaskRegistry.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { setTaskInterval } from '#lib/api/tasks.js';

	interface Props {
		task: UnifiedTask;
	}

	let { task }: Props = $props();

	let isEditing = $state(false);
	let editValue = $state(1);
	let isSaving = $state(false);
	let editInput = $state<HTMLInputElement | null>(null);

	function formatInterval(hours: number | null): string {
		if (hours === null) return 'Manual';
		if (hours < 1) return `${Math.round(hours * 60)}m`;
		if (hours < 24) return `${hours}h`;
		return `${Math.round(hours / 24)}d`;
	}

	async function saveInterval() {
		if (!task.intervalEditable) return;
		isSaving = true;
		try {
			await setTaskInterval(task.id, editValue);
			// SSE will push the updated interval and nextRunTime
			isEditing = false;
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : 'Failed to save interval');
		} finally {
			isSaving = false;
		}
	}

	function startEditing() {
		if (!task.intervalEditable) return;
		editValue = task.intervalHours ?? task.defaultIntervalHours ?? 1;
		isEditing = true;
		void tick().then(() => {
			editInput?.focus();
			editInput?.select();
		});
	}

	function cancelEditing() {
		isEditing = false;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			saveInterval();
		} else if (e.key === 'Escape') {
			cancelEditing();
		}
	}
</script>

{#if isEditing}
	<div class="flex flex-col items-start gap-1">
		<div class="flex items-center gap-1 whitespace-nowrap">
			<input
				type="number"
				step="0.25"
				min={task.minIntervalHours ?? 0.25}
				bind:this={editInput}
				bind:value={editValue}
				onkeydown={handleKeydown}
				class="input-bordered input w-16 input-xs"
			/>
			<span class="text-xs">h</span>
		</div>
		<div class="flex items-center gap-1">
			<button
				class="btn btn-square btn-ghost text-success btn-xs"
				onclick={saveInterval}
				disabled={isSaving}
				title="Save"
			>
				{#if isSaving}
					<span class="loading loading-xs loading-spinner"></span>
				{:else}
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<polyline points="20 6 9 17 4 12" />
					</svg>
				{/if}
			</button>
			<button
				class="btn btn-square btn-ghost text-error btn-xs"
				onclick={cancelEditing}
				disabled={isSaving}
				title="Cancel"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<line x1="18" y1="6" x2="6" y2="18" />
					<line x1="6" y1="6" x2="18" y2="18" />
				</svg>
			</button>
		</div>
	</div>
{:else}
	<button
		class="btn btn-ghost px-2 btn-xs {task.intervalEditable ? 'hover:bg-base-300' : ''}"
		onclick={startEditing}
		disabled={!task.intervalEditable}
		title={task.intervalEditable ? 'Click to edit' : 'System task - not editable'}
	>
		<span class="font-medium">{formatInterval(task.intervalHours)}</span>
		{#if task.intervalEditable}
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="ml-1 opacity-50"
			>
				<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
			</svg>
		{/if}
	</button>
{/if}
