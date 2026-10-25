<script lang="ts">
	import { Loader2, Trash2, Clock } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		selectedCount: number;
		loading: boolean;
		onDelete: () => void;
		onPurgeExpired: () => void;
	}

	let { selectedCount, loading, onDelete, onPurgeExpired }: Props = $props();
</script>

<div class="mb-4 rounded-lg bg-base-200 p-3">
	<div class="mb-2 flex items-center justify-between gap-2">
		<span class="text-sm font-medium">{m.blocklist_selected({ selectedCount })}</span>
	</div>

	<div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
		<button class="btn gap-1 btn-ghost text-error btn-sm" onclick={onDelete} disabled={loading}>
			{#if loading}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<Trash2 class="h-4 w-4" />
			{/if}
			{m.blocklist_deleteSelected()}
		</button>

		<button class="btn gap-1 btn-ghost btn-sm" onclick={onPurgeExpired} disabled={loading}>
			{#if loading}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<Clock class="h-4 w-4" />
			{/if}
			{m.blocklist_purgeExpired()}
		</button>
	</div>
</div>
