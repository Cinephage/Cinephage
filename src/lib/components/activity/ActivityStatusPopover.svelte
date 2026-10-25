<script lang="ts">
	import { type UnifiedActivity } from '#lib/types/activity.js';
	import { statusConfig, getStatusLabel, isDebridMaterializing } from './activity-display-utils.js';

	interface Props {
		activity: UnifiedActivity;
		compactLabel?: string;
		mobileCompactLabel?: string;
	}

	let { activity, compactLabel, mobileCompactLabel }: Props = $props();

	const config = $derived(statusConfig[activity.status] || statusConfig.no_results);

	const StatusIcon = $derived(config.icon);
</script>

<span class="badge gap-1 whitespace-nowrap {config.variant}">
	<StatusIcon
		class="h-3 w-3 {activity.status === 'downloading' || activity.status === 'searching'
			? 'animate-spin'
			: ''}"
	/>
	{#if activity.status === 'downloading' && activity.downloadProgress !== undefined && !isDebridMaterializing(activity)}
		{activity.downloadProgress}%
	{:else if mobileCompactLabel && compactLabel}
		<span class="sm:hidden">{mobileCompactLabel}</span>
		<span class="hidden sm:inline">{compactLabel}</span>
	{:else if compactLabel}
		{compactLabel}
	{:else}
		{getStatusLabel(activity, config.label)}
	{/if}
</span>
