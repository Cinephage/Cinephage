<script lang="ts">
	import {
		Disc3,
		ExternalLink,
		Eye,
		EyeOff,
		Pencil,
		Plus,
		Trash2,
		Zap
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { formatDisplayDateShort } from '#lib/utils/format.js';
	import DetailActionBar from '#lib/components/library/DetailActionBar.svelte';
	import DetailMobileBar from '#lib/components/library/DetailMobileBar.svelte';
	import type { DetailAction } from '#lib/components/library/detail-actions.js';
	/** The artist row plus the counters the page already has; no card view-model. */
	interface ArtistHeroArtist {
		id: string;
		name: string;
		mbid?: string | null;
		sortName?: string | null;
		artistType?: string | null;
		country?: string | null;
		genres?: string[] | null;
		overview?: string | null;
		disambiguation?: string | null;
		added?: string | null;
		monitored?: boolean | null;
	}

	type Props = {
		artist: ArtistHeroArtist;
		/** Album art doubling as the artist's backdrop, the way a series uses a still. */
		backdropUrl?: string | null;
		albumCount: number;
		inLibraryCount: number;
		songCount?: number;
		featured?: string[];
		backHref?: string | null;
		backLabel?: string;
		sourceUrl?: string | null;
		readOnly?: boolean;
		onMonitorToggle?: (next: boolean) => void;
		monitorBusy?: boolean;
		onSearchDiscography?: () => void;
		searching?: boolean;
		searchProgressText?: string | null;
		onAddMissing?: (() => void) | null;
		addingMissing?: boolean;
		onEdit?: (() => void) | null;
		onRemove?: (() => void) | null;
		/** Page-level controls that ride in the same bars (Discover's add button). */
		extraActions?: DetailAction[];
	};

	let {
		artist,
		backdropUrl = null,
		albumCount,
		inLibraryCount,
		songCount = 0,
		featured = [],
		backHref = null,
		backLabel = m.nav_music(),
		sourceUrl = null,
		readOnly = false,
		onMonitorToggle,
		monitorBusy = false,
		onSearchDiscography,
		searching = false,
		searchProgressText = null,
		onAddMissing = null,
		addingMissing = false,
		onEdit = null,
		onRemove = null,
		extraActions = []
	}: Props = $props();

	let artFailed = $state(false);
	const artUrl = $derived(backdropUrl && !artFailed ? backdropUrl : null);
	const stats = $derived(
		[
			m.music_albumsCount({ count: albumCount }),
			m.music_songsCount({ count: songCount })
		].filter(Boolean) as string[]
	);

	/** The page's controls, described once and rendered by the shared bars. */
	const actions = $derived<DetailAction[]>([
		...(readOnly
			? []
			: [
					{
						key: 'monitor',
						icon: artist.monitored ? Eye : EyeOff,
						iconOnly: true,
						active: Boolean(artist.monitored),
						tone: 'success' as const,
						label: artist.monitored
							? m.library_monitorToggle_monitored()
							: m.library_monitorToggle_notMonitored(),
						busy: monitorBusy,
						onSelect: () => onMonitorToggle?.(!artist.monitored)
					}
				]),
		...(onSearchDiscography
			? [
					{
						key: 'search',
						icon: Zap,
						label: searchProgressText ?? m.music_searchDiscography(),
						compactLabel: m.music_searchDiscography(),
						emphasis: 'primary' as const,
						busy: searching,
						disabled: readOnly,
						onSelect: onSearchDiscography
					}
				]
			: []),
		...(onAddMissing
			? [
					{
						key: 'add-missing',
						icon: Plus,
						label: m.music_addMissing(),
						busy: addingMissing,
						disabled: readOnly,
						onSelect: onAddMissing
					}
				]
			: []),
		...extraActions
	]);

	const menu = $derived<DetailAction[]>([
		...(onEdit
			? [{ key: 'edit', icon: Pencil, label: m.action_edit(), onSelect: onEdit }]
			: []),
		...(sourceUrl
			? [{ key: 'musicbrainz', icon: ExternalLink, label: 'MusicBrainz', href: sourceUrl }]
			: []),
		...(onRemove
			? [
					{
						key: 'remove',
						icon: Trash2,
						label: m.common_delete(),
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
		<div class="absolute inset-0 h-full w-full">
			{#if artUrl}
				<img
					src={artUrl}
					alt=""
					aria-hidden="true"
					class="h-full w-full object-cover opacity-40"
					onerror={() => (artFailed = true)}
				/>
			{/if}
			<div class="absolute inset-0 bg-linear-to-t from-base-200 via-base-200/60 to-transparent"
			></div>
			<div class="absolute inset-0 bg-linear-to-r from-base-200 via-base-200/60 to-transparent"
			></div>
		</div>

		<div class="relative z-10">
			<div class="flex flex-col gap-6 p-6 md:flex-row md:p-8">
				<!-- Artist art: square, in the poster slot. -->
				<div class="hidden shrink-0 flex-col gap-2 sm:flex">
					<div class="w-48 overflow-hidden rounded-lg shadow-lg md:w-56">
						{#if artUrl}
							<img
								src={artUrl}
								alt={artist.name}
								class="aspect-square h-auto w-full object-cover"
								onerror={() => (artFailed = true)}
							/>
						{:else}
							<div class="flex aspect-square w-full items-center justify-center bg-base-300">
								<Disc3 class="h-12 w-12 text-base-content/25" />
							</div>
						{/if}
					</div>
					{#if !readOnly}
						<button
							class="flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-colors {artist.monitored
								? 'bg-success/10 text-success hover:bg-success/20'
								: 'bg-base-content/5 text-base-content/40 hover:bg-base-content/10'}"
							disabled={monitorBusy}
							onclick={() => onMonitorToggle?.(!artist.monitored)}
						>
							{#if artist.monitored}
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
						<h1 class="text-2xl font-bold md:text-3xl">{artist.name}</h1>
						{#if artist.disambiguation}
							<p class="mt-1 text-sm text-base-content/50">{artist.disambiguation}</p>
						{/if}
						<div
							class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-base-content/70"
						>
							{#each stats as fact, index (fact)}
								{#if index > 0}<span class="hidden sm:inline">•</span>{/if}
								<span>{fact}</span>
							{/each}
							{#if inLibraryCount > 0}
								<span>•</span>
								<span class="text-success">{m.music_inLibraryCount({ count: inLibraryCount })}</span>
							{/if}
						</div>
					</div>

					{#if artist.overview}
						<p class="line-clamp-3 text-sm leading-relaxed text-base-content/80 sm:line-clamp-none">
							{artist.overview}
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

					<div
						class="flex flex-col gap-2 border-t border-base-content/10 pt-3 sm:flex-row sm:items-center sm:justify-between"
					>
						<div class="flex flex-wrap items-center gap-2">
							{#if artist.monitored}
								<span class="inline-flex items-center gap-2 rounded-lg bg-success/10 px-3 py-1.5 text-sm text-success">
									<Eye size={16} />
									{m.common_monitored()}
								</span>
							{:else}
								<span class="inline-flex items-center gap-2 rounded-lg bg-base-content/5 px-3 py-1.5 text-sm text-base-content/50">
									<EyeOff size={16} />
									{m.common_unmonitored()}
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

				<!-- Right metadata panel -->
				<div class="hidden w-56 shrink-0 rounded-lg bg-base-100/30 p-4 backdrop-blur-sm md:block lg:w-64 lg:p-5">
					<div class="grid grid-cols-2 gap-x-4 gap-y-3">
						{#if artist.added}
							<div class="col-span-2">
								<div class="text-xs text-base-content/50">{m.common_added()}</div>
								<div class="font-medium">{formatDisplayDateShort(artist.added)}</div>
							</div>
						{/if}
						<div>
							<div class="text-xs text-base-content/50">{m.music_tabAlbums()}</div>
							<div class="font-medium">{albumCount}</div>
						</div>
						<div>
							<div class="text-xs text-base-content/50">{m.music_inLibrary()}</div>
							<div class="font-medium">{inLibraryCount}</div>
						</div>
						<div>
							<div class="text-xs text-base-content/50">{m.music_tabSongs()}</div>
							<div class="font-medium">{songCount}</div>
						</div>
						{#if artist.artistType}
							<div>
								<div class="text-xs text-base-content/50">{m.music_typeLabel()}</div>
								<div class="font-medium">{artist.artistType}</div>
							</div>
						{/if}
						{#if artist.country}
							<div>
								<div class="text-xs text-base-content/50">{m.music_country()}</div>
								<div class="font-medium">{artist.country}</div>
							</div>
						{/if}
						{#if artist.mbid}
							<div class="col-span-2">
								<div class="text-xs text-base-content/50">MusicBrainz</div>
								<div class="truncate font-mono text-[11px] text-base-content/60" title={artist.mbid}>
									{artist.mbid}
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
