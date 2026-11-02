<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Activity, Clapperboard, Tv, Clock, ArrowRight } from '@lucide/svelte';
	import Skeleton from '#lib/components/ui/Skeleton.svelte';
	import { resolvePath } from '#lib/utils/routing.js';
	import { formatBytes } from '#lib/utils/format.js';
	import { getMediaLink, canLinkToMedia } from '#lib/utils/media-link.js';
	import {
		statusConfig,
		getCompactStatusLabel,
		getMobileCompactStatusLabel,
		formatRelativeTime
	} from '#lib/components/activity/activity-display-utils.js';
	import ActivityStatusPopover from '#lib/components/activity/ActivityStatusPopover.svelte';
	import type { UnifiedActivity } from '#lib/types/activity.js';

	interface Props {
		activities: UnifiedActivity[];
		isLoading: boolean;
	}

	let { activities, isLoading }: Props = $props();
</script>

<div class="card bg-base-200">
	<div class="card-body">
		<div class="flex items-center justify-between">
			<h2 class="card-title">
				<Activity class="h-5 w-5" />
				{m.dashboard_recentHistory_title()}
			</h2>
			<a href={resolvePath('/activity?tab=history')} class="btn gap-1 btn-ghost btn-xs">
				{m.dashboard_recentHistory_viewAll()}
				<ArrowRight class="h-3 w-3" />
			</a>
		</div>
		{#if isLoading}
			<div class="-mx-4 overflow-x-auto">
				<table class="table table-xs">
					<thead>
						<tr>
							<th>{m.dashboard_recentHistory_colStatus()}</th>
							<th>{m.dashboard_recentHistory_colMedia()}</th>
							<th>{m.common_size()}</th>
							<th>{m.dashboard_recentHistory_colTime()}</th>
						</tr>
					</thead>
					<tbody>
						{#each Array.from({ length: 6 }, (_, index) => index) as index (index)}
							<tr>
								<td><Skeleton variant="text" class="w-16" /></td>
								<td><Skeleton variant="text" class="w-24" /></td>
								<td><Skeleton variant="text" class="w-10" /></td>
								<td><Skeleton variant="text" class="w-10" /></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else if activities.length > 0}
			<div class="-mx-4 overflow-x-auto">
				<table class="table table-xs">
					<thead>
						<tr>
							<th>{m.dashboard_recentHistory_colStatus()}</th>
							<th>{m.dashboard_recentHistory_colMedia()}</th>
							<th>{m.common_size()}</th>
							<th>{m.dashboard_recentHistory_colTime()}</th>
						</tr>
					</thead>
					<tbody>
						{#each activities as activity (activity.id)}
							{@const config = statusConfig[activity.status] || statusConfig.no_results}
							<tr class="hover">
								<td>
									<ActivityStatusPopover
										{activity}
										compactLabel={getCompactStatusLabel(activity, config.label)}
										mobileCompactLabel={getMobileCompactStatusLabel(activity, config.label)}
									/>
									{#if activity.status === 'downloading' && activity.downloadProgress !== undefined}
										<progress
											class="progress mt-0.5 w-12 progress-info"
											value={activity.downloadProgress}
											max="100"
										></progress>
									{/if}
								</td>
								<td>
									{#if canLinkToMedia(activity)}
										<a
											href={getMediaLink(activity)}
											class="flex items-center gap-1 hover:text-primary"
										>
											{#if activity.mediaType === 'movie'}
												<Clapperboard class="h-3 w-3 shrink-0" />
											{:else}
												<Tv class="h-3 w-3 shrink-0" />
											{/if}
											<span class="max-w-24 truncate text-xs" title={activity.mediaTitle}>
												{activity.mediaTitle}
											</span>
										</a>
									{:else}
										<div class="flex items-center gap-1">
											{#if activity.mediaType === 'movie'}
												<Clapperboard class="h-3 w-3 shrink-0" />
											{:else}
												<Tv class="h-3 w-3 shrink-0" />
											{/if}
											<span class="max-w-24 truncate text-xs" title={activity.mediaTitle}>
												{activity.mediaTitle}
											</span>
										</div>
									{/if}
								</td>
								<td>
									<span class="text-xs text-base-content/70">
										{activity.size ? formatBytes(activity.size) : '-'}
									</span>
								</td>
								<td>
									<span class="text-xs text-base-content/50">
										{formatRelativeTime(activity.startedAt)}
									</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<div class="py-8 text-center text-base-content/50">
				<Clock class="mx-auto h-8 w-8 opacity-50" />
				<p class="mt-2 text-sm">{m.dashboard_recentHistory_noActivity()}</p>
			</div>
		{/if}
	</div>
</div>
