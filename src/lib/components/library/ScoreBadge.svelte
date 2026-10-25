<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { TrendingUp, TrendingDown, Minus, Loader2 } from '@lucide/svelte';

	interface Props {
		score: number | null;
		isAtCutoff?: boolean;
		upgradesAllowed?: boolean;
		loading?: boolean;
		size?: 'sm' | 'md' | 'lg';
		onclick?: () => void;
	}

	let {
		score,
		isAtCutoff = false,
		upgradesAllowed = true,
		loading = false,
		size = 'md',
		onclick
	}: Props = $props();

	const sizeClasses = {
		sm: 'badge-xs text-xs gap-0.5',
		md: 'badge-sm text-xs gap-1',
		lg: 'badge-md text-sm gap-1'
	};

	const iconSize = {
		sm: 10,
		md: 12,
		lg: 14
	};

	const badgeClass = $derived.by(() => {
		if (loading) return 'badge-ghost';
		if (!upgradesAllowed) return 'badge-ghost opacity-60';
		if (isAtCutoff) return 'badge-success';
		return 'badge-warning';
	});

	const tooltipText = $derived.by(() => {
		if (loading) return m.library_scoreBadge_loadingScore();
		if (!upgradesAllowed) return m.library_scoreBadge_upgradesDisabled();
		if (isAtCutoff) return m.library_scoreBadge_atCutoff();
		return m.library_scoreBadge_belowCutoff();
	});
</script>

{#if score !== null || loading}
	<button
		type="button"
		class="badge {badgeClass} {sizeClasses[
			size
		]} cursor-pointer transition-all hover:brightness-110"
		{onclick}
		title={tooltipText}
	>
		{#if loading}
			<Loader2 size={iconSize[size]} class="animate-spin" />
			<span>...</span>
		{:else}
			{#if !upgradesAllowed}
				<Minus size={iconSize[size]} />
			{:else if isAtCutoff}
				<TrendingUp size={iconSize[size]} />
			{:else}
				<TrendingDown size={iconSize[size]} />
			{/if}
			<span>{score?.toLocaleString()}</span>
		{/if}
	</button>
{/if}
