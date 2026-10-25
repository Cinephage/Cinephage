<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { CheckCircle, XCircle, Loader2 } from '@lucide/svelte';

	type Status = 'idle' | 'searching' | 'success' | 'failed';

	interface Props {
		status: Status;
		releaseName?: string | null;
		error?: string | null;
		size?: 'xs' | 'sm' | 'md';
	}

	let { status, releaseName = null, error = null, size = 'sm' }: Props = $props();

	const iconSizes = {
		xs: 12,
		sm: 14,
		md: 16
	};

	function getMobileErrorMessage(message: string | null): string {
		const text = message?.trim();
		if (!text) return m.library_autoSearch_searchFailed();

		if (text.includes('Cinephage Library indexer is disabled')) {
			return m.library_autoSearch_indexerDisabled();
		}

		if (text.includes('Streamer profile requires the Cinephage Library indexer')) {
			return m.library_autoSearch_streamerRequiresIndexer();
		}

		if (text.includes('Cinephage Library indexer has automatic search disabled')) {
			return m.library_autoSearch_enableAutoSearch();
		}

		if (text.length > 72) {
			return `${text.slice(0, 69)}...`;
		}

		return text;
	}

	const mobileErrorTip = $derived.by(() => getMobileErrorMessage(error));
</script>

{#if status === 'searching'}
	<div class="tooltip" data-tip={m.common_searching()}>
		<Loader2 size={iconSizes[size]} class="animate-spin text-primary" />
	</div>
{:else if status === 'success'}
	<div class="tooltip" data-tip={releaseName || m.library_autoSearch_releaseGrabbed()}>
		<CheckCircle size={iconSizes[size]} class="text-success" />
	</div>
{:else if status === 'failed'}
	<div
		class="tooltip tooltip-bottom tooltip-error before:max-w-[14rem] before:text-left before:text-xs before:break-words before:whitespace-normal sm:hidden"
		data-tip={mobileErrorTip}
	>
		<XCircle size={iconSizes[size]} class="text-error" />
	</div>
	<div
		class="tooltip tooltip-left hidden tooltip-error before:max-w-80 before:text-left before:break-words before:whitespace-normal sm:block"
		data-tip={error || m.library_autoSearch_searchFailed()}
	>
		<XCircle size={iconSizes[size]} class="text-error" />
	</div>
{/if}
