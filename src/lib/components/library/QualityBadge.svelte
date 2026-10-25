<script lang="ts">
	import type { QualityInfo, MediaInfo } from '#lib/types/library.js';
	import { getQualityDisplay, getHdrDisplay } from '#lib/types/library.js';

	interface Props {
		quality: QualityInfo | null;
		mediaInfo?: MediaInfo | null;
		size?: 'sm' | 'md' | 'lg';
	}

	let { quality, mediaInfo = null, size = 'md' }: Props = $props();

	function sanitizeBadgeValue(value: string | null | undefined): string | null {
		if (!value) return null;
		const trimmed = value.trim();
		if (!trimmed) return null;

		const normalized = trimmed.toLowerCase();
		if (normalized === 'unknown' || normalized === 'n/a' || normalized === 'na') {
			return null;
		}

		return trimmed;
	}

	const qualityText = $derived(sanitizeBadgeValue(getQualityDisplay(quality)));
	const hdrText = $derived(getHdrDisplay(mediaInfo));
	const sourceText = $derived(sanitizeBadgeValue(quality?.source));

	const sizeClasses = {
		sm: 'badge-xs text-xs',
		md: 'badge-sm text-xs',
		lg: 'badge-md text-sm'
	};
</script>

{#if qualityText || hdrText || sourceText}
	<div class="flex items-center gap-1">
		{#if qualityText}
			<span class="badge badge-primary {sizeClasses[size]}">{qualityText}</span>
		{/if}
		{#if sourceText}
			<span class="badge badge-secondary {sizeClasses[size]}">{sourceText}</span>
		{/if}
		{#if hdrText}
			<span class="badge badge-accent {sizeClasses[size]}">{hdrText}</span>
		{/if}
	</div>
{/if}
