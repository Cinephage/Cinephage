<script lang="ts">
	import { Disc3, Download, ExternalLink, Eye, EyeOff, Search, Settings, Trash2, Zap } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import StatusIndicator from '#lib/components/library/StatusIndicator.svelte';
	import DetailActionBar from '#lib/components/library/DetailActionBar.svelte';
	import DetailMobileBar from '#lib/components/library/DetailMobileBar.svelte';
	import type { DetailAction } from '#lib/components/library/detail-actions.js';
	import { formatRuntime } from './music-card.js';
	import type { AlbumHeroAlbum } from './music-card.js';

	type Props = {
		album: AlbumHeroAlbum;
		coverUrl?: string | null;
		/** Where the artist name links. Library albums point at the library artist page. */
		artistHref?: string | null;
		backHref?: string | null;
		backLabel?: string;
		/** Collaborators parsed from track credits — the cast row's music form. */
		featured?: string[];
		/** Hides the monitor toggle and every mutating control. */
		readOnly?: boolean;
		onMonitorToggle?: (next: boolean) => void;
		monitorBusy?: boolean;
		onFindReleases?: () => void;
		findBusy?: boolean;
		/** "Grab best" appears once a release passed the profile. */
		onGrabBest?: (() => void) | null;
		grabBusy?: boolean;
		onImport?: (() => void) | null;
		onEdit?: (() => void) | null;
		onRemove?: (() => void) | null;
		/** Page-level controls that ride in the same bars (Discover's add button). */
		extraActions?: DetailAction[];
	};

	let {
		album,
		coverUrl = null,
		artistHref = null,
		backHref = null,
		backLabel = m.nav_music(),
		featured = [],
		readOnly = false,
		onMonitorToggle,
		monitorBusy = false,
		onFindReleases,
		findBusy = false,
		onGrabBest = null,
		grabBusy = false,
		onImport = null,
		onEdit = null,
		onRemove = null,
		extraActions = []
	}: Props = $props();

	const runtime = $derived(formatRuntime(album.duration));
	// Covers are a remote URL on the discover pages and a proxy on library ones;
	// either can 404 (release groups without art are common), so the hero owns
	// the fallback instead of every caller repeating a probe image.
	let coverFailed = $state(false);
	const artUrl = $derived(coverUrl && !coverFailed ? coverUrl : null);
	const stats = $derived(
		[
			album.trackCount ? m.music_tracksShort({ count: album.trackCount }) : null,
			runtime,
			album.mediaCount && album.mediaCount > 1
				? m.music_discsShort({ count: album.mediaCount })
				: null,
			album.primaryType
		].filter(Boolean) as string[]
	);
	const sourceUrl = $derived(
		album.mbid ? `https://musicbrainz.org/release-group/${album.mbid}` : null
	);

	/** The page's controls, described once and rendered by the shared bars. */
	const actions = $derived<DetailAction[]>([
		...(readOnly
			? []
			: [
					{
						key: 'monitor',
						icon: album.monitored ? Eye : EyeOff,
						iconOnly: true,
						active: Boolean(album.monitored),
						tone: 'success' as const,
						label: album.monitored
							? m.library_monitorToggle_monitored()
							: m.library_monitorToggle_notMonitored(),
						busy: monitorBusy,
						onSelect: () => onMonitorToggle?.(!album.monitored)
					}
				]),
		...(onFindReleases
			? [
					{
						key: 'find',
						icon: Search,
						label: m.music_findReleases(),
						emphasis: 'primary' as const,
						busy: findBusy,
						disabled: readOnly,
						onSelect: onFindReleases
					}
				]
			: []),
		...(onGrabBest
			? [
					{
						key: 'grab',
						icon: Zap,
						label: m.music_grabBest(),
						busy: grabBusy,
						disabled: readOnly,
						onSelect: onGrabBest
					}
				]
			: []),
		...(onImport
			? [
					{
						key: 'import',
						icon: Download,
						label: m.music_importFromDisk(),
						disabled: readOnly,
						onSelect: onImport
					}
				]
			: []),
		...extraActions
	]);

	const menu = $derived<DetailAction[]>([
		...(sourceUrl
			? [{ key: 'musicbrainz', icon: ExternalLink, label: 'MusicBrainz', href: sourceUrl }]
			: []),
		...(onEdit ? [{ key: 'edit', icon: Settings, label: m.action_edit(), onSelect: onEdit }] : []),
		...(onRemove
			? [
					{
						key: 'remove',
						icon: Trash2,
						label: m.music_removeAlbum(),
						tone: 'error' as const,
						onSelect: onRemove
					}
				]
			: [])
	]);
</script>

<div class="flex flex-col gap-4">
	<DetailActionBar
		backHref={backHref ?? '/library/music'}
		backLabel={backLabel}
		{actions}
		{menu}
	/>

	<!-- Hero card -->
	<div class="relative w-full overflow-hidden rounded-xl bg-base-200 shadow-xl">
		<!-- Backdrop: the cover, at the same weight the movie page gives a still. -->
		<div class="absolute inset-0 h-full w-full">
			{#if artUrl}
				<img
					src={artUrl}
					alt=""
					aria-hidden="true"
					class="h-full w-full object-cover opacity-40"
					onerror={() => (coverFailed = true)}
				/>
			{/if}
			<div class="absolute inset-0 bg-linear-to-t from-base-200 via-base-200/60 to-transparent"
			></div>
			<div class="absolute inset-0 bg-linear-to-r from-base-200 via-base-200/60 to-transparent"
			></div>
		</div>

		<div class="relative z-10">
			<div class="flex flex-col gap-6 p-6 md:flex-row md:p-8">
				<!-- Cover -->
				<div class="hidden shrink-0 flex-col gap-2 sm:flex">
					<div class="w-48 overflow-hidden rounded-lg shadow-lg md:w-56">
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
					{#if !readOnly}
						<button
							class="flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-colors {album.monitored
								? 'bg-success/10 text-success hover:bg-success/20'
								: 'bg-base-content/5 text-base-content/40 hover:bg-base-content/10'}"
							disabled={monitorBusy}
							onclick={() => onMonitorToggle?.(!album.monitored)}
						>
							{#if album.monitored}
								<Eye size={13} />
								{m.common_monitored()}
							{:else}
								<EyeOff size={13} />
								{m.common_unmonitored()}
							{/if}
						</button>
					{/if}
				</div>

				<!-- Main info -->
				<div class="flex min-w-0 flex-1 flex-col gap-4">
					<div class="min-w-0">
						<h1 class="text-2xl font-bold md:text-3xl">
							{album.title}
							{#if album.year}
								<span class="font-normal text-base-content/60">({album.year})</span>
							{/if}
						</h1>
						<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-base-content/70">
							{#each stats as fact, index (fact)}
								{#if index > 0}<span class="hidden sm:inline">•</span>{/if}
								<span>{fact}</span>
							{/each}
						</div>
					</div>

					{#if artistHref}
						<a
							class="w-fit text-lg font-medium text-base-content/75 underline-offset-4 transition-colors hover:text-primary hover:underline"
							href={resolvePath(artistHref)}
						>
							{album.artistName}
						</a>
					{:else}
						<p class="text-lg font-medium text-base-content/75">{album.artistName}</p>
					{/if}

					{#if album.labelName || album.country}
						<p class="text-sm text-base-content/50">
							{[album.labelName, album.country].filter(Boolean).join(' · ')}
						</p>
					{/if}

					{#if featured.length > 0}
						<div>
							<div class="mb-2 text-sm text-base-content/60">{m.music_featuredArtists()}</div>
							<div class="flex gap-3 overflow-x-auto pb-1">
								{#each featured as name (name)}
									<div class="flex w-16 shrink-0 flex-col items-center gap-1.5">
										<div
											class="flex h-14 w-14 items-center justify-center rounded-full bg-base-300 text-lg text-base-content/40"
										>
											{name.charAt(0)}
										</div>
										<div class="line-clamp-2 text-center text-xs leading-tight font-medium">
											{name}
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Status badges and external links: the movie hero's footer row. -->
					<div
						class="flex flex-col gap-2 border-t border-base-content/10 pt-3 sm:flex-row sm:items-center sm:justify-between"
					>
						<div class="flex flex-wrap items-center gap-2">
							<StatusIndicator
								status={album.hasFile ? 'downloaded' : 'missing'}
								qualityText={album.primaryType}
							/>
							{#if album.hasFile && album.trackCount}
								<span class="badge badge-sm badge-outline">
									{m.music_tracksShort({ count: album.trackCount })}
								</span>
							{/if}
						</div>
						<div
							class="flex w-full items-center gap-1 overflow-x-auto border-t border-base-content/10 pt-2 pb-0.5 sm:w-auto sm:shrink-0 sm:overflow-x-visible sm:border-0 sm:pt-0 sm:pb-0"
						>
							{#if sourceUrl}
								<a
									href={sourceUrl}
									target="_blank"
									rel="noopener noreferrer"
									class="btn shrink-0 gap-1 btn-ghost btn-xs"
								>
									MusicBrainz<ExternalLink size={12} />
								</a>
							{/if}
						</div>
					</div>
				</div>

				<!-- Right metadata panel: the movie hero's, with edition facts. -->
				<div class="hidden w-56 shrink-0 rounded-lg bg-base-100/30 p-4 backdrop-blur-sm md:block lg:w-64 lg:p-5">
					<div class="grid grid-cols-2 gap-x-4 gap-y-3">
						{#if album.status}
							<div class="col-span-2">
								<div class="text-xs text-base-content/50">{m.common_status()}</div>
								<div class="font-medium capitalize">{album.status.toLowerCase()}</div>
							</div>
						{/if}
						{#if album.trackCount}
							<div>
								<div class="text-xs text-base-content/50">{m.music_tracksLabel()}</div>
								<div class="font-medium">{album.trackCount}</div>
							</div>
						{/if}
						{#if runtime}
							<div>
								<div class="text-xs text-base-content/50">{m.music_durationLabel()}</div>
								<div class="font-medium">{runtime}</div>
							</div>
						{/if}
						{#if album.labelName}
							<div class="col-span-2">
								<div class="text-xs text-base-content/50">{m.music_labelLabel()}</div>
								<div class="font-medium">{album.labelName}</div>
							</div>
						{/if}
						{#if album.catalogNumber}
							<div>
								<div class="text-xs text-base-content/50">{m.music_catalogNumber()}</div>
								<div class="font-mono text-xs">{album.catalogNumber}</div>
							</div>
						{/if}
						{#if album.barcode}
							<div>
								<div class="text-xs text-base-content/50">{m.music_barcode()}</div>
								<div class="font-mono text-xs">{album.barcode}</div>
							</div>
						{/if}
						{#if album.country}
							<div>
								<div class="text-xs text-base-content/50">{m.music_country()}</div>
								<div class="font-medium">{album.country}</div>
							</div>
						{/if}
						{#if album.mediaCount && album.mediaCount > 1}
							<div>
								<div class="text-xs text-base-content/50">{m.music_discsLabel()}</div>
								<div class="font-medium">{album.mediaCount}</div>
							</div>
						{/if}
						{#if album.path}
							<div class="col-span-2">
								<div class="text-xs text-base-content/50">{m.common_path()}</div>
								<div class="truncate font-mono text-[11px] text-base-content/60" title={album.path}>
									{album.path}
								</div>
							</div>
						{/if}
					</div>
				</div>
			</div>
		</div>
	</div>
</div>

<DetailMobileBar {actions} {menu} />
