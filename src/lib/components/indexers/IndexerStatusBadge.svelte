<script lang="ts">
	import { AlertTriangle, CheckCircle, XCircle } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { formatDisplayDate } from '#lib/utils/format.js';

	interface Props {
		enabled: boolean;
		consecutiveFailures?: number;
		lastFailure?: string;
		disabledUntil?: string;
		disabledReason?: 'consecutive_failures' | 'quota_exceeded' | 'manual';
		lastFailureMessage?: string;
		jackettManaged?: boolean;
	}

	let {
		enabled,
		consecutiveFailures = 0,
		lastFailure,
		disabledUntil,
		disabledReason,
		lastFailureMessage,
		jackettManaged = false
	}: Props = $props();

	const flaresolverrHint = $derived(
		jackettManaged ? ' If FlareSolverr is involved, click Test to reset.' : ''
	);

	const hasFailures = $derived(consecutiveFailures > 0);
	const isAutoDisabled = $derived(!!disabledUntil && new Date(disabledUntil) > new Date());

	const statusInfo = $derived.by(() => {
		if (!enabled) {
			return {
				text: m.settings_indexers_status_disabled(),
				class: 'badge-ghost',
				icon: XCircle,
				tooltip: m.settings_indexers_tooltip_disabled()
			};
		}
		if (isAutoDisabled && disabledReason === 'quota_exceeded') {
			const until = disabledUntil
				? formatDisplayDate(disabledUntil, {
						month: 'short',
						day: 'numeric',
						hour: 'numeric',
						minute: '2-digit'
					})
				: m.common_unknown();
			return {
				text: m.settings_indexers_status_quotaExceeded(),
				class: 'badge-warning',
				icon: AlertTriangle,
				tooltip: m.settings_indexers_tooltip_quotaExceeded({
					until,
					message: lastFailureMessage ?? m.common_unknown()
				})
			};
		}
		if (isAutoDisabled) {
			const until = disabledUntil
				? formatDisplayDate(disabledUntil, {
						month: 'short',
						day: 'numeric',
						hour: 'numeric',
						minute: '2-digit'
					})
				: m.common_unknown();
			return {
				text: m.settings_indexers_status_unhealthy(),
				class: 'badge-error',
				icon: AlertTriangle,
				tooltip:
					m.settings_indexers_tooltip_unhealthy({ until, consecutiveFailures }) + flaresolverrHint
			};
		}
		if (hasFailures) {
			const failureTime = lastFailure
				? formatDisplayDate(lastFailure, {
						month: 'short',
						day: 'numeric',
						hour: 'numeric',
						minute: '2-digit'
					})
				: m.common_unknown();
			return {
				text: m.settings_indexers_status_degraded(),
				class: 'badge-warning',
				icon: AlertTriangle,
				tooltip:
					m.settings_indexers_tooltip_degraded({ consecutiveFailures, failureTime }) +
					flaresolverrHint
			};
		}
		return {
			text: m.settings_indexers_status_healthy(),
			class: 'badge-success',
			icon: CheckCircle,
			tooltip: m.settings_indexers_tooltip_healthy()
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
