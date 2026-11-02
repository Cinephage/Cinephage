<script lang="ts">
	import { Loader2, CheckCircle, XCircle, Trash2, FlaskConical } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		selectedCount: number;
		loading: boolean;
		onEnable: () => void;
		onDisable: () => void;
		onDelete: () => void;
		onTestAll: () => void;
	}

	let { selectedCount, loading, onEnable, onDisable, onDelete, onTestAll }: Props = $props();
</script>

<div class="mb-4 rounded-lg bg-base-200 p-3">
	<div class="mb-2 flex items-center justify-between gap-2">
		<span class="text-sm font-medium">{m.common_selected({ count: selectedCount })}</span>
	</div>

	<div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
		<button class="btn gap-1 btn-ghost btn-sm" onclick={onEnable} disabled={loading}>
			{#if loading}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<CheckCircle class="h-4 w-4" />
			{/if}
			{m.action_enable()}
		</button>

		<button class="btn gap-1 btn-ghost btn-sm" onclick={onDisable} disabled={loading}>
			{#if loading}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<XCircle class="h-4 w-4" />
			{/if}
			{m.action_disable()}
		</button>

		<button class="btn gap-1 btn-ghost btn-sm" onclick={onTestAll} disabled={loading}>
			{#if loading}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<FlaskConical class="h-4 w-4" />
			{/if}
			{m.action_test()}
		</button>

		<button class="btn gap-1 btn-ghost text-error btn-sm" onclick={onDelete} disabled={loading}>
			{#if loading}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<Trash2 class="h-4 w-4" />
			{/if}
			{m.common_delete()}
		</button>
	</div>
</div>
