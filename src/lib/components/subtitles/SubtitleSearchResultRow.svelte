<script lang="ts">
	import { Download, Check, AlertCircle, Hash, Ear } from '@lucide/svelte';
	import SubtitleBadge from './SubtitleBadge.svelte';

	interface SubtitleResult {
		providerId: string;
		providerName: string;
		providerSubtitleId: string;
		language: string;
		title: string;
		isForced: boolean;
		isHearingImpaired: boolean;
		format: string;
		isHashMatch: boolean;
		matchScore: number;
		downloadCount?: number;
		uploadDate?: string;
	}

	interface Props {
		result: SubtitleResult;
		onDownload: (result: SubtitleResult) => void;
		downloading?: boolean;
		downloaded?: boolean;
		error?: string;
	}

	let { result, onDownload, downloading = false, downloaded = false, error }: Props = $props();

	// Score color based on the normalized 0-100 scale. 70 is the shared
	// DEFAULT_MINIMUM_SCORE: below it a result would not be auto-downloaded.
	const scoreColor = $derived.by(() => {
		if (result.matchScore >= 80) return 'text-success';
		if (result.matchScore >= 70) return 'text-warning';
		return 'text-error';
	});
</script>

<tr class="hover" class:opacity-60={downloaded}>
	<!-- Language -->
	<td>
		<SubtitleBadge
			language={result.language}
			isForced={result.isForced}
			isHearingImpaired={result.isHearingImpaired}
			format={result.format}
			size="md"
		/>
	</td>

	<!-- Title/Release -->
	<td class="max-w-xs">
		<div class="flex flex-col gap-1">
			<span class="truncate text-sm" title={result.title}>{result.title}</span>
			<div class="flex items-center gap-2 text-xs text-base-content/60">
				{#if result.isHashMatch}
					<span class="badge gap-1 badge-xs badge-success">
						<Hash size={10} />
						Hash Match
					</span>
				{/if}
				{#if result.isHearingImpaired}
					<span class="badge gap-1 badge-xs badge-info">
						<Ear size={10} />
						SDH
					</span>
				{/if}
				<span class="uppercase">{result.format}</span>
			</div>
		</div>
	</td>

	<!-- Provider -->
	<td>
		<span class="text-sm">{result.providerName}</span>
	</td>

	<!-- Score -->
	<td>
		<span class="font-mono text-sm {scoreColor}">{result.matchScore}</span>
	</td>

	<!-- Actions -->
	<td>
		{#if downloaded}
			<button class="btn gap-1 btn-sm btn-success" disabled>
				<Check size={14} />
				Downloaded
			</button>
		{:else if error}
			<div class="tooltip tooltip-error" data-tip={error}>
				<button class="btn gap-1 btn-error btn-sm" onclick={() => onDownload(result)}>
					<AlertCircle size={14} />
					Retry
				</button>
			</div>
		{:else}
			<button
				class="btn gap-1 btn-primary btn-sm"
				onclick={() => onDownload(result)}
				disabled={downloading}
			>
				{#if downloading}
					<span class="loading loading-xs loading-spinner"></span>
				{:else}
					<Download size={14} />
				{/if}
				Download
			</button>
		{/if}
	</td>
</tr>
