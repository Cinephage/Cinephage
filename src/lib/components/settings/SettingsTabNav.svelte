<script lang="ts">
	import { resolvePath } from '#lib/utils/routing.js';
	import { page } from '$app/state';
	import { ChevronLeft, ChevronRight } from '@lucide/svelte';

	interface NavItem {
		href: string;
		label: string;
		icon: typeof import('@lucide/svelte').Search;
	}

	interface Props {
		navItems: NavItem[];
		ariaLabel?: string;
	}

	let { navItems, ariaLabel }: Props = $props();

	function isActive(href: string): boolean {
		return page.url.pathname.startsWith(href);
	}

	let navScroller = $state<HTMLDivElement | null>(null);
	let canScrollLeft = $state(false);
	let canScrollRight = $state(false);

	function updateScrollIndicators() {
		if (!navScroller) {
			canScrollLeft = false;
			canScrollRight = false;
			return;
		}

		const { scrollLeft, scrollWidth, clientWidth } = navScroller;
		const maxScrollLeft = scrollWidth - clientWidth;
		canScrollLeft = scrollLeft > 4;
		canScrollRight = maxScrollLeft - scrollLeft > 4;
	}

	$effect(() => {
		if (!navScroller) return;

		updateScrollIndicators();

		// On mount, scroll the active nav item into view so it's visible on mobile
		const activeEl = navScroller.querySelector<HTMLElement>('[class*="border-primary"]');
		if (activeEl) {
			activeEl.scrollIntoView({ block: 'nearest', inline: 'center' });
		}

		const scroller = navScroller;
		const onScroll = () => updateScrollIndicators();
		scroller.addEventListener('scroll', onScroll, { passive: true });

		let resizeObserver: ResizeObserver | null = null;
		if (typeof ResizeObserver !== 'undefined') {
			resizeObserver = new ResizeObserver(() => updateScrollIndicators());
			resizeObserver.observe(scroller);
		}

		if (typeof window !== 'undefined') {
			window.addEventListener('resize', onScroll);
		}

		return () => {
			scroller.removeEventListener('scroll', onScroll);
			resizeObserver?.disconnect();
			if (typeof window !== 'undefined') {
				window.removeEventListener('resize', onScroll);
			}
		};
	});
</script>

<div class="sticky top-16 z-40 -mx-4 border-b border-base-300 bg-base-100 sm:mx-0 lg:top-12">
	<div class="relative">
		<div
			bind:this={navScroller}
			class="scrollbar-none overflow-x-auto px-2 sm:px-4 [&::-webkit-scrollbar]:hidden"
		>
			<nav class="-mb-px flex min-w-max items-stretch gap-1 sm:gap-4" aria-label={ariaLabel}>
				{#each navItems as item (item.href)}
					{@const Icon = item.icon}
					<a
						href={resolvePath(item.href)}
						class="flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-3 text-xs font-medium whitespace-nowrap transition-colors sm:gap-2 sm:px-3 sm:text-sm {isActive(
							item.href
						)
							? 'border-primary text-primary'
							: 'border-transparent text-base-content/70 hover:border-base-300 hover:text-base-content'}"
					>
						<Icon class="h-3.5 w-3.5 sm:h-4 sm:w-4" />
						{item.label}
					</a>
				{/each}
			</nav>
		</div>

		{#if canScrollLeft}
			<div
				class="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center pl-1 sm:hidden"
			>
				<div
					class="absolute inset-y-0 left-0 w-9 bg-linear-to-r from-base-100 via-base-100/95 to-transparent"
				></div>
				<div class="relative rounded-full bg-base-200/90 p-0.5 text-base-content/60">
					<ChevronLeft class="h-3.5 w-3.5" />
				</div>
			</div>
		{/if}

		{#if canScrollRight}
			<div
				class="pointer-events-none absolute inset-y-0 right-0 z-10 flex items-center pr-1 sm:hidden"
			>
				<div
					class="absolute inset-y-0 right-0 w-9 bg-linear-to-l from-base-100 via-base-100/95 to-transparent"
				></div>
				<div class="relative rounded-full bg-base-200/90 p-0.5 text-base-content/60">
					<ChevronRight class="h-3.5 w-3.5" />
				</div>
			</div>
		{/if}
	</div>
</div>
