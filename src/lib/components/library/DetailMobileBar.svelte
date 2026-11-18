<script lang="ts">
	import { MoreHorizontal } from '@lucide/svelte';
	import type { DetailAction } from './detail-actions.js';

	interface Props {
		actions?: DetailAction[];
		menu?: DetailAction[];
	}

	let { actions = [], menu = [] }: Props = $props();

	const TONE: Record<string, string> = {
		success: 'text-success',
		error: 'text-error',
		primary: 'text-primary',
		default: 'text-base-content/55'
	};

	function tone(action: DetailAction): string {
		if (action.busy) return 'text-primary/40';
		return TONE[action.active ? (action.tone ?? 'success') : (action.tone ?? 'default')] ?? TONE.default;
	}
</script>

{#if actions.length > 0 || menu.length > 0}
	<div
		class="fixed right-0 bottom-0 left-0 z-40 border-t border-base-content/6 bg-base-100/75 backdrop-blur-xl sm:hidden"
		style="padding-bottom: env(safe-area-inset-bottom)"
	>
		<div class="flex items-stretch justify-around">
			{#each actions as action (action.key)}
				{@const Icon = action.icon}
				<button
					class="flex flex-1 flex-col items-center gap-1 py-3 transition-colors {tone(action)}"
					disabled={action.disabled || action.busy}
					onclick={() => action.onSelect?.()}
				>
					{#if action.busy}
						<span class="loading loading-xs loading-spinner"></span>
					{:else}
						<Icon size={20} />
					{/if}
					<span class="text-[10px] tracking-wide">{action.compactLabel ?? action.label}</span>
				</button>
			{/each}

			{#if menu.length > 0}
				<div class="dropdown dropdown-end dropdown-top flex flex-1">
					<button
						tabindex="0"
						class="flex flex-1 flex-col items-center gap-1 py-3 text-error/60 transition-colors active:text-error"
					>
						<MoreHorizontal size={20} />
						<span class="text-[10px] tracking-wide">More</span>
					</button>
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<ul
						tabindex="0"
						class="menu dropdown-content z-50 mb-2 w-52 rounded-box border border-base-content/10 bg-base-200 p-2 shadow-lg"
					>
						{#each menu as entry (entry.key)}
							{@const MenuIcon = entry.icon}
							<li>
								{#if entry.href}
									<a href={entry.href} target="_blank" rel="noreferrer">
										<MenuIcon size={16} />
										{entry.label}
									</a>
								{:else}
									<button
										class={entry.tone === 'error' ? 'text-error' : ''}
										disabled={entry.disabled || entry.busy}
										onclick={() => entry.onSelect?.()}
									>
										<MenuIcon size={16} />
										{entry.label}
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	</div>
{/if}
