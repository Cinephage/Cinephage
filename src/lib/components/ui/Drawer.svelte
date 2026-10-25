<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import type { Snippet } from 'svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		isOpen: boolean;
		title: string;
		onClose: () => void;
		children: Snippet;
		footer?: Snippet;
	}

	let { isOpen, title, onClose, children, footer }: Props = $props();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onClose();
	}
</script>

{#if isOpen}
	<div
		class="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
		transition:fade={{ duration: 200 }}
		onclick={onClose}
		onkeydown={handleKeydown}
		role="button"
		tabindex="0"
	></div>

	<div
		class="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col bg-base-100 shadow-2xl"
		transition:fly={{ x: '100%', duration: 300, opacity: 1 }}
	>
		<!-- Header -->
		<div class="flex items-center justify-between border-b border-base-200 p-4">
			<h2 class="text-lg font-bold">{title}</h2>
			<button
				class="btn btn-circle btn-ghost btn-sm"
				onclick={onClose}
				aria-label={m.action_close()}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="h-5 w-5"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M6 18L18 6M6 6l12 12"
					/>
				</svg>
			</button>
		</div>

		<!-- Body -->
		<div class="flex-1 overflow-y-auto p-4">
			{@render children()}
		</div>

		<!-- Footer -->
		{#if footer}
			<div class="border-t border-base-200 p-4">
				{@render footer()}
			</div>
		{/if}
	</div>
{/if}
