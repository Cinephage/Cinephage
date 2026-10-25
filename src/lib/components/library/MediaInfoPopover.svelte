<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { MediaInfo } from '#lib/types/library.js';
	import { Info, Monitor, Volume2, Captions, Clock } from '@lucide/svelte';

	interface Props {
		mediaInfo: MediaInfo;
	}

	let { mediaInfo }: Props = $props();

	function formatBitrate(bps: number | undefined): string {
		if (!bps) return m.common_na();
		if (bps >= 1000000) {
			return `${(bps / 1000000).toFixed(1)} Mbps`;
		}
		return `${(bps / 1000).toFixed(0)} kbps`;
	}

	function formatRuntime(seconds: number | undefined): string {
		if (!seconds) return m.common_na();
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
	}

	function formatChannels(channels: number | undefined): string {
		if (!channels) return m.common_na();
		switch (channels) {
			case 1:
				return 'Mono';
			case 2:
				return 'Stereo';
			case 6:
				return '5.1';
			case 8:
				return '7.1';
			default:
				return `${channels} ch`;
		}
	}

	function formatResolution(info: MediaInfo): string {
		if (info.videoResolution) {
			return `${info.videoResolution.width}x${info.videoResolution.height}`;
		}
		return m.common_na();
	}
</script>

<div class="dropdown dropdown-end">
	<div tabindex="0" role="button" class="btn btn-ghost btn-xs">
		<Info size={14} />
	</div>
	<div
		tabindex="0"
		role="dialog"
		class="dropdown-content z-50 w-80 rounded-lg bg-base-200 p-4 shadow-xl"
	>
		<h4 class="mb-3 text-sm font-semibold">{m.library_mediaInfo_title()}</h4>

		<div class="space-y-3 text-sm">
			<!-- Video Section -->
			<div class="flex items-start gap-2">
				<Monitor size={14} class="mt-0.5 shrink-0 text-primary" />
				<div class="flex-1">
					<div class="font-medium">{m.library_mediaInfo_video()}</div>
					<div class="text-base-content/70">
						{mediaInfo.videoCodec || m.common_unknown()}
						{#if mediaInfo.videoProfile}
							({mediaInfo.videoProfile})
						{/if}
					</div>
					<div class="text-base-content/60">
						{formatResolution(mediaInfo)}
						{#if mediaInfo.videoFps}
							@ {mediaInfo.videoFps.toFixed(2)} fps
						{/if}
					</div>
					{#if mediaInfo.videoBitDepth}
						<div class="text-base-content/60">
							{mediaInfo.videoBitDepth}-bit
							{#if mediaInfo.hdrFormat}
								• {mediaInfo.hdrFormat}
							{/if}
						</div>
					{/if}
					{#if mediaInfo.videoBitrate}
						<div class="text-base-content/60">
							{formatBitrate(mediaInfo.videoBitrate)}
						</div>
					{/if}
				</div>
			</div>

			<!-- Audio Section -->
			<div class="flex items-start gap-2">
				<Volume2 size={14} class="mt-0.5 shrink-0 text-secondary" />
				<div class="flex-1">
					<div class="font-medium">{m.library_mediaInfo_audio()}</div>
					<div class="text-base-content/70">
						{mediaInfo.audioCodec || m.common_unknown()}
						{#if mediaInfo.audioChannels}
							• {formatChannels(mediaInfo.audioChannels)}
						{/if}
					</div>
					{#if mediaInfo.audioBitrate}
						<div class="text-base-content/60">
							{formatBitrate(mediaInfo.audioBitrate)}
						</div>
					{/if}
					{#if mediaInfo.audioLanguages && mediaInfo.audioLanguages.length > 0}
						<div class="text-base-content/60">
							{m.common_languages()}: {mediaInfo.audioLanguages.join(', ')}
						</div>
					{/if}
				</div>
			</div>

			<!-- Subtitles Section -->
			{#if mediaInfo.subtitleLanguages && mediaInfo.subtitleLanguages.length > 0}
				<div class="flex items-start gap-2">
					<Captions size={14} class="mt-0.5 shrink-0 text-accent" />
					<div class="flex-1">
						<div class="font-medium">{m.library_mediaInfo_subtitles()}</div>
						<div class="text-base-content/70">
							{mediaInfo.subtitleLanguages.join(', ')}
						</div>
					</div>
				</div>
			{/if}

			<!-- Runtime -->
			{#if mediaInfo.runtime}
				<div class="flex items-start gap-2">
					<Clock size={14} class="mt-0.5 shrink-0 text-info" />
					<div class="flex-1">
						<div class="font-medium">{m.library_mediaInfo_runtime()}</div>
						<div class="text-base-content/70">
							{formatRuntime(mediaInfo.runtime)}
						</div>
					</div>
				</div>
			{/if}

			<!-- Container -->
			{#if mediaInfo.container}
				<div class="mt-2 border-t border-base-300 pt-2 text-base-content/60">
					{m.library_mediaInfo_container()}: {mediaInfo.container}
				</div>
			{/if}
		</div>
	</div>
</div>
