<script lang="ts">
	import type { Snippet } from 'svelte';
	import { createFocusTrap, lockBodyScroll } from '#lib/utils/focus.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		onClose: () => void;
		maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl';
		labelledBy?: string;
		describedBy?: string;
		/** When true, modal-box uses flex column layout and children manage their own scrolling */
		flexContent?: boolean;
		/** When true, keep modal under desktop sidebar z-index for in-page settings workflows */
		behindSidebarOnDesktop?: boolean;
		/** Disable global body scroll locking for contexts where shell position must remain fixed */
		lockScroll?: boolean;
		children: Snippet;
	}

	let {
		open,
		onClose,
		maxWidth = 'lg',
		labelledBy,
		describedBy,
		flexContent = false,
		behindSidebarOnDesktop = false,
		lockScroll = true,
		children
	}: Props = $props();

	let modalBoxRef = $state<HTMLElement | null>(null);

	// Fluid max-width classes that scale down on small viewports
	// Uses min() to cap at either the size or viewport-32px (for 16px margin each side)
	const maxWidthClasses: Record<string, string> = {
		sm: 'w-full max-w-[min(24rem,calc(100vw-2rem))]',
		md: 'w-full max-w-[min(28rem,calc(100vw-2rem))]',
		lg: 'w-full max-w-[min(32rem,calc(100vw-2rem))]',
		xl: 'w-full max-w-[min(36rem,calc(100vw-2rem))]',
		'2xl': 'w-full max-w-[min(42rem,calc(100vw-2rem))]',
		'3xl': 'w-full max-w-[min(48rem,calc(100vw-2rem))]',
		'4xl': 'w-full max-w-[min(56rem,calc(100vw-2rem))]',
		'5xl': 'w-full max-w-[min(64rem,calc(100vw-2rem))]'
	};

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onClose();
		}
	}

	// Lock page scroll before the dialog DOM is inserted. lockBodyScroll reads
	// html.clientWidth; in a pre-effect that read hits the page's existing,
	// clean layout instead of forcing a full-page style recalc and layout with
	// the new `.modal-open` node in the document (daisyUI styles :root based on
	// it), and the overflow write is folded into the next frame's layout.
	$effect.pre(() => {
		if (!open || !lockScroll) return;
		return lockBodyScroll();
	});

	// Trap focus once the modal box exists.
	$effect(() => {
		if (!open || !modalBoxRef) return;
		return createFocusTrap(modalBoxRef);
	});
</script>

<svelte:window onkeydown={open ? handleKeydown : undefined} />

{#if open}
	<div
		class="modal-open modal {behindSidebarOnDesktop ? 'modal-under-sidebar' : ''}"
		role="dialog"
		aria-modal="true"
		aria-labelledby={labelledBy}
		aria-describedby={describedBy}
	>
		<div
			bind:this={modalBoxRef}
			class="modal-box max-h-dvh wrap-break-word sm:max-h-[90dvh] {flexContent
				? 'modal-flex-content flex flex-col overflow-hidden'
				: 'overflow-x-hidden overflow-y-auto'} {maxWidthClasses[maxWidth]}"
		>
			{@render children()}
		</div>
		<button
			type="button"
			class="modal-backdrop cursor-default border-none {behindSidebarOnDesktop
				? 'bg-black/50 lg:bg-transparent'
				: 'bg-black/50'}"
			onclick={onClose}
			aria-label={m.ui_modal_closeModal()}
		></button>
	</div>
{/if}

<style>
	/*
	 * On small landscape screens (phones), release the flex lock so the entire modal
	 * scrolls as one unit. This avoids the fixed-header + tiny/inaccessible results
	 * view problem when viewport height < 600px.
	 */
	@media (orientation: landscape) and (max-height: 600px) {
		:global(.modal-flex-content) {
			display: block !important;
			overflow-y: auto !important;
			overflow-x: hidden !important;
		}
		/* Remove flex grow/shrink constraints from all direct children */
		:global(.modal-flex-content > *) {
			flex: none !important;
			min-height: auto !important;
			overflow: visible !important;
		}
	}
</style>
