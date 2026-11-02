<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { CheckCircle, XCircle, Download, Clock } from '@lucide/svelte';

	type Status = 'downloaded' | 'missing' | 'downloading' | 'queued';

	interface Props {
		status: Status;
		qualityText?: string | null;
		size?: 'sm' | 'md' | 'lg';
	}

	let { status, qualityText = null, size = 'md' }: Props = $props();

	const statusConfig = {
		downloaded: {
			icon: CheckCircle,
			color: 'text-success',
			bgColor: 'bg-success/10',
			label: m.common_downloaded()
		},
		missing: {
			icon: XCircle,
			color: 'text-error',
			bgColor: 'bg-error/10',
			label: m.common_missing()
		},
		downloading: {
			icon: Download,
			color: 'text-warning',
			bgColor: 'bg-warning/10',
			label: m.status_downloading()
		},
		queued: {
			icon: Clock,
			color: 'text-info',
			bgColor: 'bg-info/10',
			label: m.status_queued()
		}
	};

	const config = $derived(statusConfig[status]);
	const Icon = $derived(config.icon);

	const sizeClasses = {
		sm: 'text-xs px-2 py-1',
		md: 'text-sm px-3 py-1.5',
		lg: 'text-base px-4 py-2'
	};

	const iconSizes = {
		sm: 12,
		md: 16,
		lg: 20
	};
</script>

<div
	class="inline-flex items-center gap-2 rounded-lg {config.bgColor} {config.color} {sizeClasses[
		size
	]}"
>
	<Icon size={iconSizes[size]} />
	<span class="font-medium">
		{#if status === 'downloaded' && qualityText}
			{qualityText}
		{:else}
			{config.label}
		{/if}
	</span>
</div>
