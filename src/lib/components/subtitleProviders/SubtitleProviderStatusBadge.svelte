<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { AlertCircle, CheckCircle, XCircle, Clock } from '@lucide/svelte';
	import { formatDisplayDate } from '#lib/utils/format.js';

	interface Props {
		enabled: boolean;
		healthy: boolean;
		consecutiveFailures: number;
		lastError?: string;
		throttledUntil?: string;
	}

	let { enabled, healthy, consecutiveFailures, lastError, throttledUntil }: Props = $props();

	const isThrottled = $derived(throttledUntil && new Date(throttledUntil) > new Date());

	const statusInfo = $derived.by(() => {
		if (!enabled) {
			return {
				text: m.subtitleProviders_status_disabled(),
				class: 'badge-ghost',
				icon: XCircle,
				tooltip: m.subtitleProviders_status_disabledTooltip()
			};
		}
		if (isThrottled) {
			const until = throttledUntil
				? formatDisplayDate(throttledUntil, {
						month: 'short',
						day: 'numeric',
						hour: 'numeric',
						minute: '2-digit'
					})
				: 'unknown time';
			return {
				text: m.subtitleProviders_status_throttled(),
				class: 'badge-warning',
				icon: Clock,
				tooltip: lastError
					? m.subtitleProviders_status_throttledUntil({ error: lastError, time: until })
					: m.subtitleProviders_status_throttledOnly({ time: until })
			};
		}
		if (!healthy || consecutiveFailures > 0) {
			return {
				text: m.subtitleProviders_status_unhealthy(),
				class: 'badge-error',
				icon: AlertCircle,
				tooltip: lastError
					? m.subtitleProviders_status_consecutiveFailures({
							count: consecutiveFailures,
							error: lastError
						})
					: m.subtitleProviders_status_failuresOnly({ count: consecutiveFailures })
			};
		}
		return {
			text: m.subtitleProviders_status_healthy(),
			class: 'badge-success',
			icon: CheckCircle,
			tooltip: m.subtitleProviders_status_healthyTooltip()
		};
	});

	const Icon = $derived(statusInfo.icon);
</script>

<div class="tooltip tooltip-right" data-tip={statusInfo.tooltip}>
	<div class="badge gap-1 {statusInfo.class}">
		<Icon class="h-3 w-3" />
		<span class="text-xs">{statusInfo.text}</span>
	</div>
</div>
