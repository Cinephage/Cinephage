<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		ArrowLeft,
		CircleCheck,
		CircleDashed,
		Clock,
		Disc3,
		ExternalLink,
		Eye,
		EyeOff,
		LoaderCircle
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import { formatRuntime } from './music-card.js';
	import type { AlbumHeroAlbum } from './music-card.js';

	type Props = {
		album: AlbumHeroAlbum;
		coverUrl?: string | null;
		/** Where the artist name links. Library albums point at the library artist page. */
		artistHref?: string | null;
		backHref?: string | null;
		backLabel?: string;
		/** Hides the monitor toggle and dims the state badges to plain facts. */
		readOnly?: boolean;
		onMonitorToggle?: (next: boolean) => void;
		monitorBusy?: boolean;
		/** Action buttons for the hero footer (find releases, import, add…). */
		actions?: Snippet;
	};

	let {
		album,
		coverUrl = null,
		artistHref = null,
		backHref = null,
		backLabel = m.nav_music(),
		readOnly = false,
		onMonitorToggle,
		monitorBusy = false,
		actions
	}: Props = $props();

	const runtime = $derived(formatRuntime(album.duration));
	// Covers are a remote URL on the discover pages and a proxy on library ones;
	// either can 404 (release groups without art are common), so the hero owns
	// the fallback instead of every caller repeating a probe image.
	let coverFailed = $state(false);
	const artUrl = $derived(coverUrl && !coverFailed ? coverUrl : null);
	const facts = $derived(
		[
			album.trackCount ? m.music_tracksShort({ count: album.trackCount }) : null,
			runtime,
			album.mediaCount && album.mediaCount > 1 ? m.music_discsShort({ count: album.mediaCount }) : null,
			album.primaryType,
			album.labelName,
			album.country
		].filter(Boolean) as string[]
	);
	const sourceUrl = $derived(
		album.mbid ? `https://musicbrainz.org/release-group/${album.mbid}` : null
	);
</script>

<div class="relative w-full overflow-hidden rounded-xl bg-base-200 shadow-xl">
	<!-- Backdrop: the album cover blown up and blurred, so the hero takes its
	     colour from the art instead of a flat panel. -->
	<div class="absolute inset-0 h-full w-full">
		{#if artUrl}
			<img
				src={artUrl}
				alt=""
				aria-hidden="true"
				class="h-full w-full scale-110 object-cover opacity-25 blur-2xl"
				onerror={() => (coverFailed = true)}
			/>
		{/if}
		<div class="absolute inset-0 bg-linear-to-t from-base-200 via-base-200/70 to-base-200/30"></div>
		<div class="absolute inset-0 bg-linear-to-r from-base-200 via-base-200/50 to-transparent"></div>
	</div>

	<div class="relative z-10">
		<div class="flex flex-col gap-6 p-5 sm:p-6 md:flex-row md:p-8">
			<!-- Cover + monitor -->
			<div class="flex shrink-0 flex-col gap-2">
				<div class="w-40 overflow-hidden rounded-lg shadow-lg sm:w-48 md:w-56">
					{#if artUrl}
						<img
							src={artUrl}
							alt={album.title}
							class="aspect-square h-auto w-full object-cover"
							onerror={() => (coverFailed = true)}
						/>
					{:else}
						<div class="flex aspect-square w-full items-center justify-center bg-base-300">
							<Disc3 class="h-12 w-12 text-base-content/25" />
						</div>
					{/if}
				</div>

				{#if !readOnly && onMonitorToggle}
					<button
						class="flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-colors {album.monitored
							? 'bg-success/10 text-success hover:bg-success/20'
							: 'bg-base-content/5 text-base-content/40 hover:bg-base-content/10'}"
						disabled={monitorBusy}
						onclick={() => onMonitorToggle(!album.monitored)}
					>
						{#if monitorBusy}
							<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
						{:else if album.monitored}
							<Eye class="h-3.5 w-3.5" />
						{:else}
							<EyeOff class="h-3.5 w-3.5" />
						{/if}
						{album.monitored ? m.common_monitored() : m.common_unmonitored()}
					</button>
				{/if}
			</div>

			<!-- Title block -->
			<div class="flex min-w-0 flex-1 flex-col">
				{#if backHref}
					<a
						class="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-base-content/45 transition-colors hover:text-base-content/80"
						href={resolvePath(backHref)}
					>
						<ArrowLeft class="h-3.5 w-3.5" />
						{backLabel}
					</a>
				{/if}

				<h1 class="text-2xl leading-tight font-bold tracking-tight sm:text-3xl">{album.title}</h1>

				{#if artistHref}
					<a
						class="mt-1 inline-block w-fit text-lg font-medium text-base-content/75 underline-offset-4 transition-colors hover:text-primary hover:underline"
						href={resolvePath(artistHref)}
					>
						{album.artistName}
					</a>
				{:else}
					<p class="mt-1 text-lg font-medium text-base-content/75">{album.artistName}</p>
				{/if}

				<div class="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
					{#if album.year}
						<span class="badge badge-sm border-base-content/15 bg-base-100/60">{album.year}</span>
					{/if}
					{#if album.primaryType}
						<span class="badge badge-sm border-base-content/15 bg-base-100/60">{album.primaryType}</span>
					{/if}
					{#each album.secondaryTypes ?? [] as type (type)}
						<span class="badge badge-sm border-base-content/15 bg-base-100/60">{type}</span>
					{/each}
					{#if album.status}
						<span class="badge badge-sm border-base-content/15 bg-base-100/60">{album.status}</span>
					{/if}
					{#if album.hasFile}
						<span class="badge badge-sm gap-1 border-none bg-success/15 text-success">
							<CircleCheck class="h-3 w-3" />{m.music_inLibrary()}
						</span>
					{:else}
						<span class="badge badge-sm gap-1 border-none bg-warning/15 text-warning">
							<CircleDashed class="h-3 w-3" />{m.common_missing()}
						</span>
					{/if}
				</div>

				<p class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-base-content/60">
					{#each facts as fact, index (fact + index)}
						{#if index > 0}<span class="text-base-content/25">·</span>{/if}
						<span class="inline-flex items-center gap-1">
							{#if index === 1 && runtime}<Clock class="h-3 w-3" />{/if}
							{fact}
						</span>
					{/each}
				</p>

				<div class="mt-auto flex flex-wrap items-center gap-2 pt-5">
					{@render actions?.()}
					{#if sourceUrl}
						<a
							class="btn gap-1.5 btn-ghost btn-xs text-base-content/50 hover:text-base-content"
							href={sourceUrl}
							target="_blank"
							rel="noreferrer"
						>
							<ExternalLink class="h-3.5 w-3.5" />
							MusicBrainz
						</a>
					{/if}
				</div>
			</div>

			<!-- Metadata panel -->
			<aside class="hidden w-52 shrink-0 rounded-lg bg-base-100/30 p-4 backdrop-blur-sm lg:block xl:w-60">
				<dl class="space-y-3 text-sm">
					{#if album.labelName}
						<div>
							<dt class="text-xs text-base-content/45">{m.music_labelLabel()}</dt>
							<dd class="font-medium">{album.labelName}</dd>
						</div>
					{/if}
					{#if album.catalogNumber}
						<div>
							<dt class="text-xs text-base-content/45">{m.music_catalogNumber()}</dt>
							<dd class="font-mono text-xs">{album.catalogNumber}</dd>
						</div>
					{/if}
					{#if album.barcode}
						<div>
							<dt class="text-xs text-base-content/45">{m.music_barcode()}</dt>
							<dd class="font-mono text-xs">{album.barcode}</dd>
						</div>
					{/if}
					{#if album.status}
						<div>
							<dt class="text-xs text-base-content/45">{m.common_status()}</dt>
							<dd class="font-medium capitalize">{album.status.toLowerCase()}</dd>
						</div>
					{/if}
					{#if album.country}
						<div>
							<dt class="text-xs text-base-content/45">{m.music_country()}</dt>
							<dd class="font-medium">{album.country}</dd>
						</div>
					{/if}
					{#if album.path}
						<div>
							<dt class="text-xs text-base-content/45">{m.common_path()}</dt>
							<dd class="truncate font-mono text-[11px] text-base-content/60" title={album.path}>
								{album.path}
							</dd>
						</div>
					{/if}
				</dl>
			</aside>
		</div>
	</div>
</div>
