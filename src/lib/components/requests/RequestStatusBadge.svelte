<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		Clock,
		Hourglass,
		CheckCircle2,
		XCircle,
		TimerOff,
		Ban,
		PackageCheck
	} from '@lucide/svelte';
	import type { RequestStatus } from '#lib/api/requests.js';

	let { status, size = 'sm' }: { status: RequestStatus; size?: 'xs' | 'sm' } = $props();

	const config = $derived.by(() => {
		switch (status) {
			case 'pending':
				return {
					icon: Clock,
					label: m.requests_status_pending(),
					cls: 'bg-warning/15 text-warning border-warning/30'
				};
			case 'approved':
				return {
					icon: CheckCircle2,
					label: m.requests_status_approved(),
					cls: 'bg-info/15 text-info border-info/30'
				};
			case 'awaiting_target':
				return {
					icon: Hourglass,
					label: m.requests_status_awaiting_target(),
					cls: 'bg-warning/10 text-warning border-warning/25'
				};
			case 'failed':
				return {
					icon: XCircle,
					label: m.requests_status_failed(),
					cls: 'bg-error/15 text-error border-error/30'
				};
			case 'declined':
				return {
					icon: Ban,
					label: m.requests_status_declined(),
					cls: 'bg-base-content/5 text-base-content/50 border-base-content/15'
				};
			case 'expired':
				return {
					icon: TimerOff,
					label: m.requests_status_expired(),
					cls: 'bg-base-content/5 text-base-content/50 border-base-content/15'
				};
			case 'cancelled':
				return {
					icon: Ban,
					label: m.requests_status_cancelled(),
					cls: 'bg-base-content/5 text-base-content/50 border-base-content/15'
				};
			case 'fulfilled':
				return {
					icon: PackageCheck,
					label: m.requests_status_fulfilled(),
					cls: 'bg-success/15 text-success border-success/30'
				};
		}
	});

	const Icon = $derived(config.icon);
</script>

<span
	class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium {config.cls} {size ===
	'xs'
		? 'text-xs'
		: 'text-sm'}"
>
	<Icon class={size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5'} strokeWidth={2.25} />
	{config.label}
</span>
