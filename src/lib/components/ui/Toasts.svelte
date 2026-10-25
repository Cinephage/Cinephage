<script lang="ts">
	import { resolvePath } from '#lib/utils/routing.js';
	import { toasts, type ToastType } from '#lib/stores/toast.svelte.js';
	import { CheckCircle, XCircle, AlertCircle, Info, X } from '@lucide/svelte';
	import { fly } from 'svelte/transition';
	import * as m from '#lib/paraglide/messages.js';

	const icons: Record<ToastType, typeof CheckCircle> = {
		success: CheckCircle,
		error: XCircle,
		warning: AlertCircle,
		info: Info
	};

	const alertClasses: Record<ToastType, string> = {
		success: 'alert-success',
		error: 'alert-error',
		warning: 'alert-warning',
		info: 'alert-info'
	};
</script>

<!-- Toast Container - Fixed position, centered on mobile, right-aligned on desktop -->
<div
	class="toast toast-center z-2000 sm:toast-end"
	style="bottom: max(1rem, env(safe-area-inset-bottom))"
	aria-live="polite"
>
	{#each toasts.toasts as toast (toast.id)}
		{@const Icon = icons[toast.type]}
		<div
			class="alert w-full shadow-lg sm:max-w-sm {alertClasses[toast.type]}"
			role="alert"
			transition:fly={{ x: 100, duration: 300 }}
		>
			<Icon class="h-5 w-5 shrink-0" />
			<div class="flex-1">
				<p class="font-medium">{toast.message}</p>
				{#if toast.description}
					<p class="text-sm opacity-80">{toast.description}</p>
				{/if}
			</div>
			<div class="flex items-center gap-2">
				{#if toast.action}
					{#if toast.action.href}
						<a href={resolvePath(toast.action.href)} class="btn btn-ghost btn-xs">
							{toast.action.label}
						</a>
					{:else if toast.action.onClick}
						<button class="btn btn-ghost btn-xs" onclick={toast.action.onClick}>
							{toast.action.label}
						</button>
					{/if}
				{/if}
				<button
					class="btn btn-circle btn-ghost btn-xs"
					onclick={() => toasts.dismiss(toast.id)}
					aria-label={m.ui_toasts_dismiss()}
				>
					<X class="h-4 w-4" />
				</button>
			</div>
		</div>
	{/each}
</div>
