<script lang="ts">
	import { ArrowLeft, MoreHorizontal } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import type { DetailAction } from './detail-actions.js';

	interface Props {
		backHref: string;
		backLabel: string;
		actions?: DetailAction[];
		menu?: DetailAction[];
	}

	let { backHref, backLabel, actions = [], menu = [] }: Props = $props();

	const TONE: Record<string, string> = {
		success: 'text-success',
		error: 'text-error',
		primary: 'text-primary',
		default: 'text-base-content/55'
	};

	function buttonTone(action: DetailAction): string {
		if (action.emphasis === 'primary') return 'btn-primary';
		if (action.active) return 'btn-ghost ' + TONE[action.tone ?? 'success'];
		return 'btn-ghost';
	}
</script>

<div class="flex items-center justify-between gap-2">
	<a href={resolvePath(backHref)} class="btn gap-1.5 btn-ghost text-base-content/60 btn-sm">
		<ArrowLeft size={16} />
		<span class="sm:inline">{m.library_backTo({ name: backLabel })}</span>
	</a>

	<div class="flex shrink-0 items-center gap-1 sm:gap-2">
		{#each actions as action (action.key)}
			{@const Icon = action.icon}
			{#if action.href}
				<a
					class="btn hidden gap-1.5 btn-ghost btn-sm sm:flex"
					href={action.href}
					target="_blank"
					rel="noreferrer"
				>
					<Icon size={14} />
					{action.label}
				</a>
			{:else if action.iconOnly}
				<button
					class="btn hidden btn-sm sm:flex {buttonTone(action)}"
					title={action.label}
					aria-label={action.label}
					disabled={action.disabled || action.busy}
					onclick={() => action.onSelect?.()}
				>
					{#if action.busy}
						<span class="loading loading-xs loading-spinner"></span>
					{:else}
						<Icon size={16} />
					{/if}
				</button>
			{:else}
				<button
					class="btn hidden gap-1.5 btn-sm sm:flex {buttonTone(action)}"
					disabled={action.disabled || action.busy}
					onclick={() => action.onSelect?.()}
				>
					{#if action.busy}
						<span class="loading loading-xs loading-spinner"></span>
					{:else}
						<Icon size={14} />
					{/if}
					{action.label}
					{#if action.badge}
						<span class="badge badge-sm">{action.badge}</span>
					{/if}
				</button>
			{/if}
		{/each}

		{#if menu.length > 0}
			<div class="dropdown dropdown-end hidden sm:block">
				<button tabindex="0" class="btn btn-ghost btn-sm">
					<MoreHorizontal size={18} />
				</button>
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<ul
					tabindex="0"
					class="menu dropdown-content z-50 w-56 rounded-box border border-base-content/10 bg-base-200 p-2 shadow-lg"
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
