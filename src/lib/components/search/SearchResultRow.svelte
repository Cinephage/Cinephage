<script lang="ts">
	import {
		Download,
		ExternalLink,
		Loader2,
		Check,
		X,
		Play,
		ChevronDown,
		ChevronUp,
		Calendar,
		HardDrive,
		ArrowUpCircle,
		ArrowDownCircle,
		Ban
	} from '@lucide/svelte';
	import { getContext } from 'svelte';
	import { formatBytes } from '#lib/utils/format.js';
	import type { ScoreComponents } from '#lib/server/quality/types.js';
	import * as m from '#lib/paraglide/messages.js';

	export interface Release {
		guid: string;
		title: string;
		downloadUrl: string;
		magnetUrl?: string;
		infoHash?: string;
		size: number;
		seeders?: number;
		leechers?: number;
		publishDate: string | Date;
		indexerId: string;
		indexerName: string;
		protocol: 'torrent' | 'usenet' | 'streaming';
		commentsUrl?: string;
		sourceIndexers?: string[];
		torrent?: {
			freeleech?: boolean;
			downloadFactor?: number;
			uploadFactor?: number;
		};
		parsed?: {
			resolution?: string;
			source?: string;
			codec?: string;
			hdr?: string;
			releaseGroup?: string;
			audioCodec?: string;
			audioChannels?: string;
			hasAtmos?: boolean;
			edition?: string;
			isProper?: boolean;
			isRepack?: boolean;
			languages?: string[];
			episode?: {
				season?: number;
				seasons?: number[];
				episodes?: number[];
				isSeasonPack?: boolean;
				isCompleteSeries?: boolean;
			};
		};
		episodeMatch?: {
			season?: number;
			seasons?: number[];
			episodes?: number[];
			isSeasonPack?: boolean;
			isCompleteSeries?: boolean;
		};
		quality?: {
			score: number;
			meetsMinimum: boolean;
		};
		totalScore?: number;
		scoreComponents?: ScoreComponents;
		scoringResult?: {
			totalScore?: number;
			breakdown?: {
				resolution?: { score: number; formats: string[] };
				source?: { score: number; formats: string[] };
				codec?: { score: number; formats: string[] };
				releaseGroupTier?: { score: number; formats: string[] };
				audio?: { score: number; formats: string[] };
				hdr?: { score: number; formats: string[] };
				streaming?: { score: number; formats: string[] };
				enhancement?: { score: number; formats: string[] };
				banned?: { score: number; formats: string[] };
			};
			isBanned?: boolean;
			bannedReasons?: string[];
			sizeRejected?: boolean;
			sizeRejectionReason?: string;
		};
		rejected?: boolean;
		rejections?: string[];
		rejectionReason?: string;
	}

	interface Props {
		release: Release;
		onGrab: (release: Release, streaming?: boolean) => Promise<void>;
		onBlock?: (release: Release) => void;
		grabbing?: boolean;
		grabbed?: boolean;
		blocked?: boolean;
		error?: string | null;
		streaming?: boolean;
		showUsenetStreamButton?: boolean;
		canUsenetStream?: boolean;
		usenetStreamUnavailableReason?: string | null;
	}

	let {
		release,
		onGrab,
		onBlock,
		grabbing = false,
		grabbed = false,
		blocked = false,
		error = null,
		streaming = false,
		showUsenetStreamButton = true,
		canUsenetStream = true,
		usenetStreamUnavailableReason = null
	}: Props = $props();

	let expanded = $state(false);

	const indexerSourceCtx = getContext<{ map: Map<string, 'prowlarr' | 'jackett'> } | undefined>(
		'indexerSources'
	);
	const indexerSource = $derived(indexerSourceCtx?.map.get(release.indexerId) ?? null);

	function formatAge(date: string | Date): string {
		const publishDate = typeof date === 'string' ? new Date(date) : date;
		const now = new Date();
		const diffMs = now.getTime() - publishDate.getTime();
		const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

		if (diffDays === 0) return m.search_today();
		if (diffDays === 1) return '1d';
		if (diffDays < 7) return `${diffDays}d`;
		if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
		if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
		return `${Math.floor(diffDays / 365)}y`;
	}

	function isKnownBadge(value?: string): boolean {
		return Boolean(value && value.trim() && value.trim().toLowerCase() !== 'unknown');
	}

	function getQualityTags(): string[] {
		const tags: string[] = [];
		const seen: string[] = [];
		const addTag = (value?: string) => {
			if (!isKnownBadge(value)) return;
			const label = value!.trim();
			const normalized = label.toLowerCase();
			if (seen.includes(normalized)) return;
			seen.push(normalized);
			tags.push(label);
		};

		addTag(release.parsed?.resolution);
		addTag(release.parsed?.source);
		addTag(release.parsed?.codec);
		addTag(release.parsed?.audioCodec ? release.parsed.audioCodec.toUpperCase() : undefined);
		addTag(release.parsed?.hdr);
		return tags;
	}

	/**
	 * Audio codec + channels for the Technical Details row, e.g. "FLAC 1.0"
	 * or "DD+ 5.1 ATMOS". Null when nothing audio-related was detected so the
	 * row can fall back to "Unknown" (#586).
	 */
	function formatAudioSummary(): string | null {
		const codec = release.parsed?.audioCodec;
		const channels = release.parsed?.audioChannels;
		if (!isKnownBadge(codec) && !isKnownBadge(channels)) return null;
		const parts = [
			isKnownBadge(codec) ? codec!.trim().toUpperCase() : null,
			isKnownBadge(channels) ? channels!.trim() : null,
			release.parsed?.hasAtmos ? 'ATMOS' : null
		];
		return parts.filter(Boolean).join(' ');
	}

	/**
	 * "Repack", "Proper" or "Repack / Proper" for the Version row (#586).
	 */
	function getVersionSummary(): string | null {
		const parts = [
			release.parsed?.isRepack ? 'Repack' : null,
			release.parsed?.isProper ? 'Proper' : null
		];
		const summary = parts.filter(Boolean).join(' / ');
		return summary || null;
	}

	function getProtocolColor(): string {
		switch (release.protocol) {
			case 'torrent':
				return 'bg-info';
			case 'streaming':
				return 'bg-success';
			case 'usenet':
				return 'bg-warning';
			default:
				return 'bg-base-300';
		}
	}

	function getScoreColor(score: number): string {
		if (score >= 700) return 'text-success';
		if (score >= 400) return 'text-warning';
		return 'text-error';
	}

	async function handleGrab() {
		await onGrab(release, false);
	}

	async function handleStream() {
		if (!canUsenetStream) return;
		await onGrab(release, true);
	}

	function getTorrentAvailabilityText(): { seeders: string; leechers: string } | null {
		if (release.protocol !== 'torrent') return null;
		const hasSeederData = release.seeders !== undefined || release.leechers !== undefined;
		if (!hasSeederData) return null;
		return {
			seeders: release.seeders !== undefined ? String(release.seeders) : '-',
			leechers: release.leechers !== undefined ? String(release.leechers) : '-'
		};
	}
</script>

<div
	class="rounded-lg border bg-base-200 transition-all duration-200 {expanded
		? 'border-primary/50'
		: 'border-base-300'} {release.rejected ? 'opacity-50' : ''}"
>
	<!-- Main row - always visible -->
	<div class="p-3">
		<!-- Mobile layout: two compact lines -->
		<div class="sm:hidden">
			<!-- Line 1: score + title + grab + expand -->
			<div class="flex items-center gap-2">
				{#if release.totalScore !== undefined}
					<span
						class="shrink-0 rounded px-1.5 py-0.5 text-sm font-semibold {getScoreColor(
							release.totalScore
						)}"
						title={m.search_qualityScore()}
					>
						{release.totalScore}
					</span>
				{/if}
				<p class="min-w-0 flex-1 truncate text-sm font-medium" title={release.title}>
					{release.title}
				</p>
				<div class="flex shrink-0 items-center gap-1">
					{#if blocked}
						<span class="badge gap-1 badge-sm badge-warning"><Ban size={10} /></span>
					{:else if grabbed}
						<span class="badge gap-1 badge-sm badge-success"><Check size={10} /></span>
					{:else if error}
						<span class="badge gap-1 badge-sm badge-error" title={error}><X size={10} /></span>
					{:else}
						{#if release.protocol === 'usenet' && showUsenetStreamButton}
							<button
								class="btn btn-accent btn-xs"
								onclick={handleStream}
								disabled={grabbing || streaming || !canUsenetStream}
								title={canUsenetStream
									? m.search_stream()
									: (usenetStreamUnavailableReason ?? m.search_unavailable())}
							>
								{#if streaming}
									<Loader2 size={12} class="animate-spin" />
								{:else}
									<Play size={12} />
								{/if}
							</button>
						{/if}
						<button
							class="btn btn-primary btn-xs"
							onclick={handleGrab}
							disabled={grabbing || streaming}
						>
							{#if grabbing}
								<Loader2 size={12} class="animate-spin" />
							{:else}
								<Download size={12} />
							{/if}
						</button>
					{/if}
					<button
						class="btn btn-ghost btn-xs"
						onclick={() => (expanded = !expanded)}
						title={expanded ? m.search_collapseDetails() : m.search_expandDetails()}
					>
						{#if expanded}
							<ChevronUp size={12} />
						{:else}
							<ChevronDown size={12} />
						{/if}
					</button>
				</div>
			</div>

			<!-- Line 2: quality badges only -->
			<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
				{#each getQualityTags() as tag (tag)}
					<span class="badge badge-xs badge-primary">{tag}</span>
				{/each}
				{#if release.parsed?.releaseGroup && isKnownBadge(release.parsed.releaseGroup)}
					<span class="badge badge-ghost badge-xs">{release.parsed.releaseGroup}</span>
				{/if}
				{#if release.torrent?.freeleech || release.torrent?.downloadFactor === 0}
					<span class="badge badge-xs badge-success">{m.search_freeleechBadge()}</span>
				{/if}
				{#if release.rejected && release.rejections?.length}
					<span class="badge gap-1 badge-xs badge-error" title={release.rejections.join('\n')}>
						<Ban size={8} />
						{release.rejectionReason || release.rejections[0]}
						{#if release.rejections.length > 1}+{release.rejections.length - 1}{/if}
					</span>
				{/if}
			</div>

			<!-- Line 3: metadata + secondary actions -->
			<div class="mt-1 flex items-center gap-2 text-xs text-base-content/50">
				<span class="h-1.5 w-1.5 shrink-0 rounded-full {getProtocolColor()}"></span>
				<span class="truncate">{release.indexerName}</span>
				{#if release.size > 0}<span class="shrink-0">{formatBytes(release.size)}</span>{/if}
				{#if release.protocol === 'torrent' && release.seeders !== undefined}
					<span class="text-success">↑{release.seeders}</span>
				{/if}
				<span>{formatAge(release.publishDate)}</span>
				<div class="ml-auto flex shrink-0 items-center gap-0.5 border-l border-base-300 pl-2">
					{#if onBlock && !blocked}
						<button
							class="btn btn-ghost text-error/70 btn-xs hover:text-error"
							onclick={() => onBlock(release)}
							title={m.search_blockRelease()}
						>
							<Ban size={13} />
						</button>
					{/if}
					{#if release.commentsUrl}
						<a
							href={release.commentsUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="btn btn-ghost text-base-content/60 btn-xs hover:text-base-content"
							title={m.search_viewComments()}
						>
							<ExternalLink size={13} />
						</a>
					{/if}
				</div>
			</div>
		</div>

		<!-- Desktop layout -->
		<div class="hidden items-center gap-3 sm:flex">
			<!-- Score - inline with title -->
			{#if release.totalScore !== undefined}
				<span
					class="shrink-0 rounded px-1.5 py-0.5 text-sm font-semibold {getScoreColor(
						release.totalScore
					)}"
					title={m.search_qualityScore()}
				>
					{release.totalScore}
				</span>
			{/if}

			<!-- Title and tags -->
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-medium" title={release.title}>
					{release.title}
				</p>
				<div class="mt-1 flex flex-wrap items-center gap-1.5">
					{#each getQualityTags() as tag (tag)}
						<span class="badge badge-sm badge-primary">{tag}</span>
					{/each}
					{#if release.parsed?.releaseGroup && isKnownBadge(release.parsed.releaseGroup)}
						<span class="badge badge-ghost badge-sm">{release.parsed.releaseGroup}</span>
					{/if}
					{#if release.torrent?.freeleech || release.torrent?.downloadFactor === 0}
						<span class="badge badge-sm badge-success">{m.search_freeleechBadge()}</span>
					{/if}
					{#if release.rejected && release.rejections?.length}
						<span class="badge gap-1 badge-sm badge-error" title={release.rejections.join('\n')}>
							<Ban size={10} />
							{release.rejectionReason || release.rejections[0]}
							{#if release.rejections.length > 1}
								+{release.rejections.length - 1}
							{/if}
						</span>
					{/if}
				</div>
			</div>

			<!-- Quick stats -->
			<div class="flex shrink-0 items-center gap-4 text-xs">
				<!-- Indexer -->
				<div class="flex items-center gap-1.5">
					<span class="h-2 w-2 rounded-full {getProtocolColor()}"></span>
					<span class="text-base-content/60">{release.indexerName}</span>
					{#if indexerSource === 'prowlarr'}
						<span class="badge badge-xs badge-primary">Prowlarr</span>
					{:else if indexerSource === 'jackett'}
						<span class="badge badge-xs badge-secondary">Jackett</span>
					{/if}
				</div>

				<!-- Size -->
				{#if release.size > 0}
					<div class="flex items-center gap-1 text-base-content/60">
						<HardDrive size={12} />
						<span>{formatBytes(release.size)}</span>
					</div>
				{/if}

				<!-- Seeders/Leechers -->
				{#if release.protocol === 'torrent'}
					{@const availability = getTorrentAvailabilityText()}
					{#if availability}
						<div class="flex items-center gap-1">
							<ArrowUpCircle size={12} class="text-success" />
							<span class="text-success">{availability.seeders}</span>
							<span class="text-base-content/30">/</span>
							<ArrowDownCircle size={12} class="text-error" />
							<span class="text-error">{availability.leechers}</span>
						</div>
					{/if}
				{/if}

				<!-- Age -->
				<div class="flex items-center gap-1 text-base-content/60">
					<Calendar size={12} />
					<span>{formatAge(release.publishDate)}</span>
				</div>
			</div>

			<!-- Actions -->
			<div class="flex shrink-0 items-center gap-1">
				{#if blocked}
					<span class="badge gap-1 badge-warning">
						<Ban size={12} />
						{m.search_releaseBlocked()}
					</span>
				{/if}
				{#if grabbed}
					<span class="badge gap-1 badge-success">
						<Check size={12} />
						{m.search_grabbedBadge()}
					</span>
				{:else if error}
					<span class="badge gap-1 badge-error" title={error}>
						<X size={12} />
						{m.search_failedBadge()}
					</span>
				{:else if !blocked}
					{#if release.protocol === 'usenet' && showUsenetStreamButton}
						<button
							class="btn btn-accent btn-sm"
							onclick={handleStream}
							disabled={grabbing || streaming || !canUsenetStream}
							title={canUsenetStream
								? m.search_stream()
								: (usenetStreamUnavailableReason ?? m.search_unavailable())}
						>
							{#if streaming}
								<Loader2 size={14} class="animate-spin" />
							{:else}
								<Play size={14} />
							{/if}
						</button>
					{/if}
					<button
						class="btn btn-primary btn-sm"
						onclick={handleGrab}
						disabled={grabbing || streaming}
					>
						{#if grabbing}
							<Loader2 size={14} class="animate-spin" />
						{:else}
							<Download size={14} />
						{/if}
					</button>
				{/if}

				{#if onBlock && !blocked}
					<button
						class="btn btn-ghost text-error btn-sm"
						onclick={() => onBlock(release)}
						title={m.search_blockRelease()}
					>
						<Ban size={14} />
					</button>
				{/if}

				{#if release.commentsUrl}
					<a
						href={release.commentsUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="btn btn-ghost btn-sm"
						title={m.search_viewComments()}
					>
						<ExternalLink size={14} />
					</a>
				{/if}

				<!-- Expand toggle -->
				<button
					class="btn btn-ghost btn-sm"
					onclick={() => (expanded = !expanded)}
					title={expanded ? m.search_collapseDetails() : m.search_expandDetails()}
				>
					{#if expanded}
						<ChevronUp size={14} />
					{:else}
						<ChevronDown size={14} />
					{/if}
				</button>
			</div>
		</div>
	</div>

	<!-- Expanded content -->
	{#if expanded}
		<div class="border-t border-base-300 bg-base-100 p-4">
			<p class="mb-3 text-xs break-all text-base-content/70 sm:hidden">{release.title}</p>
			<!-- Score breakdown section -->
			{#if release.scoringResult?.breakdown}
				<div class="mb-4">
					<h4 class="mb-2 text-xs font-medium tracking-wide text-base-content/50 uppercase">
						{m.search_scoreBreakdown()}
					</h4>
					<div class="flex flex-wrap gap-2">
						{#each Object.entries(release.scoringResult.breakdown) as [key, cat] (key)}
							{#if cat && cat.score !== 0}
								{@const label =
									key === 'releaseGroupTier'
										? m.search_group()
										: key.charAt(0).toUpperCase() + key.slice(1)}
								{@const scoreClass =
									cat.score > 0 ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}
								{@const prefix = cat.score > 0 ? '+' : ''}
								<span
									class="rounded-full px-2 py-1 text-xs {scoreClass}"
									title={cat.formats?.length ? cat.formats.join(', ') : undefined}
								>
									{prefix}{cat.score}
									{label}
								</span>
							{/if}
						{/each}
						{#if release.scoreComponents}
							{#if release.scoreComponents.enhancementBonus > 0}
								<span class="rounded-full bg-success/10 px-2 py-1 text-xs text-success">
									+{release.scoreComponents.enhancementBonus}
									{m.search_enhancement()}
								</span>
							{/if}
							{#if release.scoreComponents.packBonus > 0}
								<span class="rounded-full bg-success/10 px-2 py-1 text-xs text-success">
									+{release.scoreComponents.packBonus}
									{m.search_pack()}
								</span>
							{/if}
							{#if release.scoreComponents.hardcodedSubsPenalty < 0}
								<span class="rounded-full bg-error/10 px-2 py-1 text-xs text-error">
									{release.scoreComponents.hardcodedSubsPenalty}
									{m.search_hardcodedSubs()}
								</span>
							{/if}
						{/if}
					</div>
				</div>
			{/if}

			<!-- Rejection reasons -->
			{#if release.rejected && release.rejections?.length}
				<div class="mb-4">
					<h4 class="mb-2 text-xs font-medium tracking-wide text-error uppercase">
						Rejection reasons
					</h4>
					<div class="flex flex-wrap gap-1">
						{#each release.rejections as reason (reason)}
							<span class="badge badge-sm badge-error">{reason}</span>
						{/each}
					</div>
					{#if release.scoringResult?.isBanned}
						<div class="mt-2 text-xs text-error">
							Banned formats: {release.scoringResult.bannedReasons?.join(', ')}
						</div>
					{/if}
					{#if release.scoringResult?.sizeRejected}
						<div class="mt-1 text-xs text-error">
							{release.scoringResult.sizeRejectionReason}
						</div>
					{/if}
				</div>
			{/if}

			<!-- Release details section -->
			<div class="grid gap-4 sm:grid-cols-2">
				<!-- Left: technical details -->
				<div>
					<h4 class="mb-2 text-xs font-medium tracking-wide text-base-content/50 uppercase">
						{m.search_technicalDetails()}
					</h4>
					<dl class="space-y-1.5 text-sm">
						{#if release.parsed?.resolution}
							<div class="flex justify-between">
								<dt class="text-base-content/60">{m.search_labelResolution()}</dt>
								<dd class="font-medium">{release.parsed.resolution}</dd>
							</div>
						{/if}
						{#if release.parsed?.source}
							<div class="flex justify-between">
								<dt class="text-base-content/60">{m.search_labelSource()}</dt>
								<dd class="font-medium">{release.parsed.source}</dd>
							</div>
						{/if}
						{#if release.parsed?.codec}
							<div class="flex justify-between">
								<dt class="text-base-content/60">{m.search_labelCodec()}</dt>
								<dd class="font-medium">{release.parsed.codec}</dd>
							</div>
						{/if}
						<div class="flex justify-between">
							<dt class="text-base-content/60">{m.search_labelAudioCodec()}</dt>
							<dd class="font-medium">{formatAudioSummary() ?? m.common_unknown()}</dd>
						</div>
						{#if release.parsed?.hdr}
							<div class="flex justify-between">
								<dt class="text-base-content/60">{m.search_labelHdr()}</dt>
								<dd class="font-medium">{release.parsed.hdr}</dd>
							</div>
						{/if}
						{#if release.parsed?.edition}
							<div class="flex justify-between">
								<dt class="text-base-content/60">{m.search_labelEdition()}</dt>
								<dd class="font-medium">{release.parsed.edition}</dd>
							</div>
						{/if}
						{#if getVersionSummary()}
							<div class="flex justify-between">
								<dt class="text-base-content/60">{m.search_labelVersion()}</dt>
								<dd class="font-medium">{getVersionSummary()}</dd>
							</div>
						{/if}
						{#if release.parsed?.languages?.length}
							<div class="flex justify-between">
								<dt class="text-base-content/60">{m.search_labelLanguages()}</dt>
								<dd class="font-medium">{release.parsed.languages.join(', ')}</dd>
							</div>
						{/if}
						<div class="flex justify-between">
							<dt class="text-base-content/60">{m.search_labelProtocol()}</dt>
							<dd class="font-medium capitalize">{release.protocol}</dd>
						</div>
						<div class="flex justify-between">
							<dt class="text-base-content/60">{m.search_labelSize()}</dt>
							<dd class="font-medium">{formatBytes(release.size)}</dd>
						</div>
					</dl>
				</div>

				<!-- Right: torrent/indexer info -->
				<div>
					<h4 class="mb-2 text-xs font-medium tracking-wide text-base-content/50 uppercase">
						{m.search_indexerAndTorrent()}
					</h4>
					<dl class="space-y-1.5 text-sm">
						<div class="flex justify-between">
							<dt class="text-base-content/60">{m.search_labelIndexer()}</dt>
							<dd class="flex items-center gap-1.5 font-medium">
								{release.indexerName}
								{#if indexerSource === 'prowlarr'}
									<span class="badge badge-xs badge-primary">Prowlarr</span>
								{:else if indexerSource === 'jackett'}
									<span class="badge badge-xs badge-secondary">Jackett</span>
								{/if}
							</dd>
						</div>
						{#if release.infoHash}
							<div class="flex justify-between">
								<dt class="text-base-content/60">{m.search_labelHash()}</dt>
								<dd class="truncate font-mono text-xs">{release.infoHash}</dd>
							</div>
						{/if}
						{#if release.torrent?.freeleech || release.torrent?.downloadFactor === 0}
							<div class="flex justify-between">
								<dt class="text-base-content/60">{m.search_labelRatio()}</dt>
								<dd class="font-medium text-success">{m.search_freeleechBadge()}</dd>
							</div>
						{/if}
						{#if release.torrent?.uploadFactor && release.torrent.uploadFactor > 1}
							<div class="flex justify-between">
								<dt class="text-base-content/60">{m.search_labelUpload()}</dt>
								<dd class="font-medium text-info">{release.torrent.uploadFactor}x</dd>
							</div>
						{/if}
						{#if release.seeders !== undefined}
							<div class="flex justify-between">
								<dt class="text-base-content/60">{m.search_labelSeeders()}</dt>
								<dd class="font-medium text-success">{release.seeders}</dd>
							</div>
						{/if}
						{#if release.leechers !== undefined}
							<div class="flex justify-between">
								<dt class="text-base-content/60">{m.search_labelLeechers()}</dt>
								<dd class="font-medium text-error">{release.leechers}</dd>
							</div>
						{/if}
						<div class="flex justify-between">
							<dt class="text-base-content/60">{m.search_labelPublished()}</dt>
							<dd class="font-medium">{formatAge(release.publishDate)} {m.search_ago()}</dd>
						</div>
					</dl>
				</div>
			</div>

			<!-- Action buttons in expanded view -->
			<div class="mt-4 flex flex-wrap items-center gap-2 border-t border-base-300 pt-4">
				{#if release.downloadUrl}
					<a
						href={release.downloadUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="btn btn-outline btn-sm"
					>
						<Download size={14} />
						{m.search_directDownload()}
					</a>
				{/if}
				{#if release.magnetUrl}
					<a
						href={release.magnetUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="btn btn-outline btn-sm"
					>
						{m.search_magnetLink()}
					</a>
				{/if}
				{#if release.commentsUrl}
					<a
						href={release.commentsUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="btn btn-ghost btn-sm"
					>
						<ExternalLink size={14} />
						{m.search_comments()}
					</a>
				{/if}
			</div>
		</div>
	{/if}
</div>
