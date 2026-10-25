<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import ModalHeader from '#lib/components/ui/modal/ModalHeader.svelte';
	import {
		TrendingUp,
		TrendingDown,
		Check,
		X,
		AlertCircle,
		ChevronDown,
		ChevronRight
	} from '@lucide/svelte';
	import type { FileScoreResponse } from '#lib/types/score.js';

	interface Props {
		open: boolean;
		onClose: () => void;
		scoreData: FileScoreResponse | null;
	}

	let { open, onClose, scoreData }: Props = $props();

	let showAttributes = $state(false);
	let showFormats = $state(false);

	const breakdownCategories = [
		{ key: 'resolution', label: m.library_scoreDetail_resolution() },
		{ key: 'source', label: m.library_scoreDetail_source() },
		{ key: 'codec', label: m.library_scoreDetail_codec() },
		{ key: 'audio', label: m.library_scoreDetail_audio() },
		{ key: 'hdr', label: m.library_scoreDetail_hdr() },
		{ key: 'streaming', label: m.library_scoreDetail_streaming() },
		{ key: 'releaseGroupTier', label: m.library_scoreDetail_releaseGroup() },
		{ key: 'enhancement', label: m.library_scoreDetail_enhancement() },
		{ key: 'banned', label: m.library_scoreDetail_banned() }
	] as const;

	function formatScore(score: number): string {
		if (score === 0) return '0';
		const prefix = score > 0 ? '+' : '';
		return prefix + score.toLocaleString();
	}

	function getScoreColor(score: number): string {
		if (score > 0) return 'text-success';
		if (score < 0) return 'text-error';
		return 'text-base-content/50';
	}

	function formatAudioAttributes(
		attributes: NonNullable<Props['scoreData']>['attributes']
	): string | null {
		const parts: string[] = [];

		if (attributes.audioCodec && attributes.audioCodec !== 'unknown') {
			parts.push(attributes.audioCodec);
		}
		if (attributes.audioChannels && attributes.audioChannels !== 'unknown') {
			parts.push(attributes.audioChannels);
		}
		if (attributes.hasAtmos) {
			parts.push('atmos');
		}

		return parts.length > 0 ? parts.join(' ') : null;
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="2xl">
	<ModalHeader title={m.library_scoreDetail_title()} {onClose} />

	{#if scoreData}
		<div class="space-y-6">
			<!-- Score Summary -->
			<div class="rounded-lg bg-base-200 p-4">
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-6">
						<div>
							<div class="text-3xl font-bold">
								{scoreData.normalizedScore}
							</div>
							<div class="text-sm text-base-content/70">
								{m.library_scoreDetail_normalizedScore()}
							</div>
							<div class="text-xs text-base-content/50">{m.library_scoreDetail_compareHint()}</div>
						</div>
						<div class="border-l border-base-300 pl-6">
							<div class="text-xl font-medium text-base-content/70">
								{scoreData.scoringResult.totalScore.toLocaleString()}
							</div>
							<div class="text-xs text-base-content/50">{m.library_scoreDetail_rawScore()}</div>
						</div>
					</div>
					<div class="text-right">
						<div class="text-sm font-medium">{scoreData.profileInfo.name}</div>
						<div class="text-xs text-base-content/50">{m.library_scoreDetail_scoringProfile()}</div>
					</div>
				</div>
			</div>

			<!-- Upgrade Status -->
			<div class="rounded-lg border border-base-300 p-4">
				<h4 class="mb-3 font-semibold">{m.library_scoreDetail_upgradeStatus()}</h4>
				<div class="grid gap-3 sm:grid-cols-2">
					<!-- Upgrades Allowed -->
					<div class="flex items-center gap-2">
						{#if scoreData.upgradeStatus.upgradesAllowed}
							<Check size={16} class="text-success" />
							<span class="text-sm">{m.library_scoreDetail_upgradesEnabled()}</span>
						{:else}
							<X size={16} class="text-error" />
							<span class="text-sm">{m.library_scoreDetail_upgradesDisabled()}</span>
						{/if}
					</div>

					<!-- Cutoff Status -->
					<div class="flex items-center gap-2">
						{#if scoreData.upgradeStatus.upgradeUntilScore <= 0}
							<AlertCircle size={16} class="text-info" />
							<span class="text-sm">{m.library_scoreDetail_noCutoff()}</span>
						{:else if scoreData.upgradeStatus.isAtCutoff}
							<TrendingUp size={16} class="text-success" />
							<span class="text-sm">
								{m.library_scoreDetail_atCutoff({
									current: scoreData.upgradeStatus.currentScore.toLocaleString(),
									cutoff: scoreData.upgradeStatus.upgradeUntilScore.toLocaleString()
								})}
							</span>
						{:else}
							<TrendingDown size={16} class="text-warning" />
							<span class="text-sm">
								{m.library_scoreDetail_belowCutoff({
									current: scoreData.upgradeStatus.currentScore.toLocaleString(),
									cutoff: scoreData.upgradeStatus.upgradeUntilScore.toLocaleString()
								})}
							</span>
						{/if}
					</div>

					<!-- Minimum Score -->
					<div class="flex items-center gap-2">
						{#if scoreData.scoringResult.meetsMinimum}
							<Check size={16} class="text-success" />
							<span class="text-sm"
								>{m.library_scoreDetail_meetsMinimum({ min: scoreData.profileInfo.minScore })}</span
							>
						{:else}
							<X size={16} class="text-error" />
							<span class="text-sm"
								>{m.library_scoreDetail_belowMinimum({ min: scoreData.profileInfo.minScore })}</span
							>
						{/if}
					</div>

					<!-- Min Score Increment -->
					<div class="flex items-center gap-2">
						<AlertCircle size={16} class="text-info" />
						<span class="text-sm">
							{m.library_scoreDetail_minUpgradeIncrement({
								value: scoreData.upgradeStatus.minScoreIncrement.toLocaleString()
							})}
						</span>
					</div>
				</div>
			</div>

			<!-- Score Breakdown -->
			<div class="rounded-lg border border-base-300 p-4">
				<h4 class="mb-3 font-semibold">{m.library_scoreDetail_scoreBreakdown()}</h4>
				<div class="overflow-x-auto">
					<table class="table-compact table w-full">
						<thead>
							<tr>
								<th>{m.library_scoreDetail_category()}</th>
								<th class="text-right">{m.library_scoreDetail_score()}</th>
								<th>{m.library_scoreDetail_matchedFormats()}</th>
							</tr>
						</thead>
						<tbody>
							{#each breakdownCategories as { key, label } (key)}
								{@const category = scoreData.scoringResult.breakdown[key]}
								{#if category.formats.length > 0 || category.score !== 0}
									<tr>
										<td class="font-medium">{label}</td>
										<td class="text-right {getScoreColor(category.score)}">
											{formatScore(category.score)}
										</td>
										<td class="text-sm text-base-content/70">
											{category.formats.join(', ') || '-'}
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
						<tfoot>
							<tr class="font-bold">
								<td>{m.library_scoreDetail_total()}</td>
								<td class="text-right">{scoreData.scoringResult.totalScore.toLocaleString()}</td>
								<td></td>
							</tr>
						</tfoot>
					</table>
				</div>
			</div>

			<!-- Matched Formats (Collapsible) -->
			<div class="rounded-lg border border-base-300">
				<button
					type="button"
					class="flex w-full items-center justify-between p-4 text-left hover:bg-base-200"
					onclick={() => (showFormats = !showFormats)}
				>
					<h4 class="font-semibold">
						{m.library_scoreDetail_matchedFormats()} ({scoreData.scoringResult.matchedFormats
							.length})
					</h4>
					{#if showFormats}
						<ChevronDown size={16} />
					{:else}
						<ChevronRight size={16} />
					{/if}
				</button>
				{#if showFormats}
					<div class="border-t border-base-300 p-4">
						<div class="flex flex-wrap gap-2">
							{#each scoreData.scoringResult.matchedFormats as format (format.format.name)}
								<div
									class="badge {format.score >= 0 ? 'badge-outline' : 'badge-outline badge-error'}"
									title="{format.format.category}: {format.score}"
								>
									{format.format.name}
									<span class="ml-1 opacity-70">({formatScore(format.score)})</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</div>

			<!-- Detected Attributes (Collapsible) -->
			<div class="rounded-lg border border-base-300">
				<button
					type="button"
					class="flex w-full items-center justify-between p-4 text-left hover:bg-base-200"
					onclick={() => (showAttributes = !showAttributes)}
				>
					<h4 class="font-semibold">
						{m.library_scoreDetail_detectedAttributes()}
						<span class="ml-2 text-xs font-normal text-base-content/50">
							({m.library_scoreDetail_sourceLabel({ source: scoreData.dataSource })})
						</span>
					</h4>
					{#if showAttributes}
						<ChevronDown size={16} />
					{:else}
						<ChevronRight size={16} />
					{/if}
				</button>
				{#if showAttributes}
					<div class="border-t border-base-300 p-4">
						<div class="grid gap-2 text-sm sm:grid-cols-2">
							<div>
								<span class="text-base-content/50">{m.library_scoreDetail_resolutionLabel()}</span>
								<span class="ml-2">{scoreData.attributes.resolution || m.common_unknown()}</span>
							</div>
							<div>
								<span class="text-base-content/50">{m.library_scoreDetail_sourceLabelShort()}</span>
								<span class="ml-2">{scoreData.attributes.source || m.common_unknown()}</span>
							</div>
							<div>
								<span class="text-base-content/50">{m.library_scoreDetail_codecLabel()}</span>
								<span class="ml-2">{scoreData.attributes.codec || m.common_unknown()}</span>
							</div>
							<div>
								<span class="text-base-content/50">{m.library_scoreDetail_audioLabel()}</span>
								<span class="ml-2"
									>{formatAudioAttributes(scoreData.attributes) || m.common_unknown()}</span
								>
							</div>
							<div>
								<span class="text-base-content/50">{m.library_scoreDetail_hdrLabel()}</span>
								<span class="ml-2">{scoreData.attributes.hdr || m.library_scoreDetail_none()}</span>
							</div>
							<div>
								<span class="text-base-content/50">{m.library_scoreDetail_releaseGroupLabel()}</span
								>
								<span class="ml-2">{scoreData.attributes.releaseGroup || m.common_unknown()}</span>
							</div>
							{#if scoreData.attributes.streamingService}
								<div>
									<span class="text-base-content/50"
										>{m.library_scoreDetail_streamingServiceLabel()}</span
									>
									<span class="ml-2">{scoreData.attributes.streamingService}</span>
								</div>
							{/if}
							{#if scoreData.attributes.edition}
								<div>
									<span class="text-base-content/50">{m.library_scoreDetail_editionLabel()}</span>
									<span class="ml-2">{scoreData.attributes.edition}</span>
								</div>
							{/if}
							<div>
								<span class="text-base-content/50">{m.library_scoreDetail_remuxLabel()}</span>
								<span class="ml-2"
									>{scoreData.attributes.isRemux ? m.common_yes() : m.common_no()}</span
								>
							</div>
							<div>
								<span class="text-base-content/50">{m.library_scoreDetail_repackLabel()}</span>
								<span class="ml-2">
									{scoreData.attributes.isRepack
										? m.library_scoreDetail_repack()
										: scoreData.attributes.isProper
											? m.library_scoreDetail_proper()
											: m.common_no()}
								</span>
							</div>
						</div>
						{#if scoreData.sceneName}
							<div class="mt-3 border-t border-base-300 pt-3">
								<div class="text-xs text-base-content/50">
									{m.library_scoreDetail_sceneNameLabel()}
								</div>
								<div class="mt-1 font-mono text-xs break-all">{scoreData.sceneName}</div>
							</div>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Rejection Status -->
			{#if scoreData.scoringResult.isBanned || scoreData.scoringResult.sizeRejected || scoreData.scoringResult.protocolRejected}
				<div class="rounded-lg border border-error bg-error/10 p-4">
					<h4 class="mb-2 font-semibold text-error">{m.library_scoreDetail_rejectionStatus()}</h4>
					{#if scoreData.scoringResult.isBanned}
						<div class="text-sm">
							<span class="font-medium">{m.library_scoreDetail_bannedLabel()}</span>
							{scoreData.scoringResult.bannedReasons.join(', ')}
						</div>
					{/if}
					{#if scoreData.scoringResult.sizeRejected}
						<div class="text-sm">
							<span class="font-medium">{m.library_scoreDetail_sizeRejectedLabel()}</span>
							{scoreData.scoringResult.sizeRejectionReason}
						</div>
					{/if}
					{#if scoreData.scoringResult.protocolRejected}
						<div class="text-sm">
							<span class="font-medium">{m.library_scoreDetail_protocolRejectedLabel()}</span>
							{scoreData.scoringResult.protocolRejectionReason}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{:else}
		<div class="py-8 text-center text-base-content/50">{m.library_scoreDetail_noData()}</div>
	{/if}
</ModalWrapper>
