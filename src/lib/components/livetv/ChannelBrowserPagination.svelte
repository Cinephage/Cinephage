<script lang="ts">
	import { ChevronLeft, ChevronRight } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		page: number;
		totalPages: number;
		loading: boolean;
		onPrevious: () => void;
		onNext: () => void;
	}

	let { page, totalPages, loading, onPrevious, onNext }: Props = $props();
</script>

{#if totalPages > 1}
	<div class="mt-4 flex items-center justify-center gap-2">
		<button class="btn btn-ghost btn-sm" disabled={page === 1 || loading} onclick={onPrevious}>
			<ChevronLeft class="h-4 w-4" />
			{m.livetv_channelBrowserModal_previous()}
		</button>
		<span class="text-sm">
			{m.livetv_channelBrowserModal_pageOf({ page, totalPages })}
		</span>
		<button class="btn btn-ghost btn-sm" disabled={page === totalPages || loading} onclick={onNext}>
			{m.livetv_channelBrowserModal_next()}
			<ChevronRight class="h-4 w-4" />
		</button>
	</div>
{/if}
