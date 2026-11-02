<script lang="ts">
	import { AlertTriangle, CheckCircle, XCircle } from '@lucide/svelte';
	import type { DownloadClientHealth } from '#lib/types/downloadClient.js';
	import * as m from '#lib/paraglide/messages.js';
	import { formatDisplayDate } from '#lib/utils/format.js';

	interface Props {
		enabled: boolean | null;
		health?: DownloadClientHealth;
		consecutiveFailures?: number;
		lastFailure?: string;
		lastFailureMessage?: string;
	}

	let {
		enabled,
		health = 'healthy',
		consecutiveFailures = 0,
		lastFailure,
		lastFailureMessage: _lastFailureMessage
	}: Props = $props();

	const statusInfo = $derived.by(() => {
		if (!enabled) {
			return {
				text: m.common_disabled(),
				class: 'badge-ghost',
				icon: XCircle,
				tooltip: m.settings_integrations_downloadClients_tooltipDisabled()
			};
		}

		if (health === 'failing' || consecutiveFailures >= 3) {
			const failureTime = lastFailure
				? formatDisplayDate(lastFailure, {
						month: 'short',
						day: 'numeric',
						hour: 'numeric',
						minute: '2-digit'
					})
				: m.common_unknown();
			return {
				text: m.status_unhealthy(),
				class: 'badge-error',
				icon: AlertTriangle,
				tooltip: m.settings_integrations_downloadClients_tooltipUnhealthy({
					count: consecutiveFailures,
					time: failureTime
				})
			};
		}

		if (health === 'warning' || consecutiveFailures >= 1) {
			const failureTime = lastFailure
				? formatDisplayDate(lastFailure, {
						month: 'short',
						day: 'numeric',
						hour: 'numeric',
						minute: '2-digit'
					})
				: m.common_unknown();
			return {
				text: m.settings_integrations_downloadClients_statusDegraded(),
				class: 'badge-warning',
				icon: AlertTriangle,
				tooltip: m.settings_integrations_downloadClients_tooltipDegraded({
					count: consecutiveFailures,
					time: failureTime
				})
			};
		}

		return {
			text: m.status_healthy(),
			class: 'badge-success',
			icon: CheckCircle,
			tooltip: m.settings_integrations_downloadClients_tooltipHealthy()
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
