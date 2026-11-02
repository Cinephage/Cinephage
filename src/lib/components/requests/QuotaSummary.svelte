<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Film, Tv } from '@lucide/svelte';
	import type { QuotaStatus } from '#lib/api/requests.js';

	let {
		quota,
		type,
		compact = false
	}: { quota: QuotaStatus; type: 'movie' | 'tv'; compact?: boolean } = $props();

	const unlimited = $derived(quota.limit === null || quota.limit === 0);
	const label = $derived(type === 'movie' ? m.requests_quotaMovie() : m.requests_quotaTv());
	const Icon = $derived(type === 'movie' ? Film : Tv);
	const pct = $derived(
		quota.limit && quota.limit > 0 ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : 0
	);
	const value = $derived(
		unlimited
			? m.requests_quotaUnlimited()
			: m.requests_quotaOf({ used: quota.used, limit: quota.limit ?? 0 })
	);
</script>

{#if compact}
	<span
		class="inline-flex items-center gap-1.5 text-xs {quota.restricted
			? 'text-error'
			: 'text-base-content/70'}"
	>
		<Icon class="h-3.5 w-3.5" />
		<span class="opacity-70">{label}</span>
		<span class="font-medium">{value}</span>
	</span>
{:else}
	<div
		class="rounded-xl border border-base-content/10 bg-base-content/[0.03] px-3.5 py-3 {quota.restricted
			? 'border-error/30'
			: ''}"
	>
		<div class="flex items-center justify-between gap-3">
			<span class="flex items-center gap-2 text-sm text-base-content/70">
				<Icon class="h-4 w-4 opacity-60" />
				{label}
			</span>
			<span
				class="text-sm font-semibold {quota.restricted
					? 'text-error'
					: unlimited
						? 'text-base-content/60'
						: 'text-base-content'}"
			>
				{value}
			</span>
		</div>
		{#if !unlimited}
			<progress
				class="progress mt-2 h-1.5 {quota.restricted ? 'progress-error' : 'progress-primary'}"
				value={pct}
				max="100"
			></progress>
			{#if quota.days}
				<p class="mt-1.5 text-xs text-base-content/45">
					{m.requests_quotaWindow({ days: quota.days })}
				</p>
			{/if}
		{/if}
	</div>
{/if}
