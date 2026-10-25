<script lang="ts">
	import { X } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		title: string;
		onClose: () => void;
	}

	let { title, onClose }: Props = $props();
</script>

<div class="mb-4 flex items-center justify-between">
	<h3 class="text-lg font-bold">{title}</h3>
	<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose} aria-label={m.action_close()}>
		<X class="h-4 w-4" />
	</button>
</div>
