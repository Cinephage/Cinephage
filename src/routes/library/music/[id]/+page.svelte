<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import type { PageData } from './$types.js';
	import {
		Download,
		FileAudio,
		HardDriveDownload,
		LoaderCircle,
		Search,
		Trash2
	} from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { musicQualityLabel } from '#lib/components/music/release-quality.js';
	import AlbumHero from '#lib/components/music/AlbumHero.svelte';
	import AlbumEditModal from '#lib/components/music/AlbumEditModal.svelte';
	import type { AlbumEditData } from '#lib/components/music/music-card.js';
	import { formatBytes } from '#lib/utils/format.js';
	import TrackList from '#lib/components/music/TrackList.svelte';
	import TrackSearchModal from '#lib/components/music/TrackSearchModal.svelte';
	import MusicMatchModal from '#lib/components/music/MusicMatchModal.svelte';
	import { ConfirmationModal, ModalWrapper } from '#lib/components/ui/modal/index.js';
	import Panel from '#lib/components/ui/Panel.svelte';
	import FactRow from '#lib/components/ui/FactRow.svelte';
	import LibraryMediaCard from '#lib/components/library/LibraryMediaCard.svelte';
	import { albumCardView } from '#lib/components/library/media-view.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { SvelteSet } from 'svelte/reactivity';

	let { data }: { data: PageData } = $props();

	type Candidate = {
		guid: string | null;
		title: string;
		indexerName: string | null;
		size: number | null;
		seeders: number | null;
		protocol: string | null;
		isAudioCategory: boolean;
		format?: string;
		bitDepth?: number | null;
		bitrateKbps?: number | null;
		sampleRateKhz?: number | null;
		score?: number;
		accepted?: boolean;
		tierLabel?: string | null;
		reasons?: string[];
	};

	const album = $derived(data.album);
	// The toggle is optimistic: null means "whatever the server sent", and a
	// failure puts the override back rather than leaving the UI lying.
	let monitoredOverride = $state<boolean | null>(null);
	const monitored = $derived(monitoredOverride ?? Boolean(data.album.monitored));
	let monitorBusy = $state(false);
	// The profile select is optimistic like the monitor toggle: undefined means
	// "whatever the server sent", and a failure restores it.
	let profileOverride = $state<string | null | undefined>(undefined);
	let profileBusy = $state(false);
	let editOpen = $state(false);
	let editSaving = $state(false);
	let fileToDelete = $state<{ id: string; name: string } | null>(null);
	let deletingFile = $state(false);
	const activeProfile = $derived(
		profileOverride !== undefined ? profileOverride : album.qualityProfileId
	);

	let searchingReleases = $state(false);
	let grabError = $state<string | null>(null);
	let grabbed = $state<string | null>(null);
	let grabbingGuid = $state<string | 'best' | null>(null);
	let candidates = $state<Candidate[]>([]);
	let releaseError = $state<string | null>(null);
	let searched = $state(false);

	// The library list's manual-search button lands here with ?search=1: run the
	// interactive release search once, the way the movie row's manual action does.
	let autoSearchHandled = false;
	$effect(() => {
		if (autoSearchHandled) return;
		if (new URLSearchParams(window.location.search).get('search') !== '1') return;
		autoSearchHandled = true;
		void findReleases();
	});

	let trackFilter = $state('');
	const visibleTracks = $derived.by(() => {
		const needle = trackFilter.trim().toLowerCase();
		if (!needle) return album.tracks;
		return album.tracks.filter((track) => track.title.toLowerCase().includes(needle));
	});

	let importOpen = $state(false);
	let importPath = $state('');
	let importing = $state(false);
	let deleteOpen = $state(false);
	let deleting = $state(false);
	let refreshing = $state(false);
	let matchOpen = $state(false);

	function gib(bytes: number | null): string {
		if (!bytes) return '–';
		return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
	}

	async function toggleMonitor(next: boolean) {
		if (monitorBusy) return;
		monitorBusy = true;
		const previous = monitoredOverride;
		monitoredOverride = next;
		try {
			const response = await fetch(`/api/music/albums/${album.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ monitored: next })
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				monitoredOverride = previous;
				toasts.error(body.details ?? body.error ?? m.common_failedToSave());
			}
		} catch (err) {
			monitoredOverride = previous;
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			monitorBusy = false;
		}
	}

	async function saveQualityProfile(next: string | null) {
		if (profileBusy || next === activeProfile) return;
		profileBusy = true;
		const previous = profileOverride;
		profileOverride = next;
		try {
			const response = await fetch(`/api/music/albums/${album.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ qualityProfileId: next })
			});
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				profileOverride = previous;
				toasts.error(body.details ?? body.error ?? m.common_failedToSave());
			}
		} catch (err) {
			profileOverride = previous;
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			profileBusy = false;
		}
	}

	async function saveAlbumEdit(patch: AlbumEditData) {
		if (editSaving) return;
		editSaving = true;
		try {
			const response = await fetch(`/api/music/albums/${album.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patch)
			});
			const body = await response.json().catch(() => ({}));
			if (!response.ok) {
				toasts.error(body.details ?? body.error ?? m.common_failedToSave());
				return;
			}
			editOpen = false;
			await invalidateAll();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			editSaving = false;
		}
	}

	async function refreshAlbum() {
		if (refreshing) return;
		refreshing = true;
		try {
			const response = await fetch(`/api/music/albums/${album.id}/refresh`, { method: 'POST' });
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			if (!response.ok) throw new Error(body.error ?? m.music_refreshFailed());
			toasts.success(m.music_refreshSuccess());
			await invalidateAll();
		} catch (error) {
			toasts.error(m.music_refreshFailed(), {
				description: error instanceof Error ? error.message : undefined
			});
		} finally {
			refreshing = false;
		}
	}

	async function removeFile() {
		if (!fileToDelete || deletingFile) return;
		deletingFile = true;
		try {
			const response = await fetch(`/api/music/files/${fileToDelete.id}`, { method: 'DELETE' });
			const body = await response.json().catch(() => ({}));
			if (!response.ok) {
				toasts.error(body.details ?? body.error ?? m.common_failedToSave());
				return;
			}
			fileToDelete = null;
			await invalidateAll();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			deletingFile = false;
		}
	}

	async function findReleases() {
		if (searchingReleases) return;
		searchingReleases = true;
		searched = true;
		releaseError = null;
		try {
			const response = await fetch(`/api/music/albums/${album.id}/search`, { method: 'POST' });
			const body = await response.json();
			if (!response.ok) {
				releaseError = body.details ?? body.error ?? m.music_searchFailed();
				return;
			}
			candidates = body.candidates ?? [];
			if (candidates.length === 0) releaseError = m.music_noReleases();
		} catch (err) {
			releaseError = err instanceof Error ? err.message : m.music_searchFailed();
		} finally {
			searchingReleases = false;
		}
	}

	async function grab(candidate: Candidate | null) {
		if (grabbingGuid) return;
		grabbingGuid = candidate?.guid ?? 'best';
		grabError = null;
		grabbed = null;
		try {
			const response = await fetch(`/api/music/albums/${album.id}/grab`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(candidate?.guid ? { releaseGuid: candidate.guid } : {})
			});
			const body = await response.json();
			if (!response.ok) {
				grabError = body.details ?? body.error ?? m.music_grabFailed();
				return;
			}
			grabbed = body.title ?? candidate?.title ?? '';
			candidates = candidates.map((entry) =>
				entry.guid === (candidate?.guid ?? null)
					? { ...entry, accepted: false, reasons: [m.music_grabInFlight()] }
					: entry
			);
		} catch (err) {
			grabError = err instanceof Error ? err.message : m.music_grabFailed();
		} finally {
			grabbingGuid = null;
		}
	}

	async function importFolder() {
		if (importing || !importPath.trim()) return;
		importing = true;
		try {
			const response = await fetch(`/api/music/albums/${album.id}/import`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ path: importPath.trim() })
			});
			const body = await response.json();
			if (!response.ok) {
				toasts.error(body.details ?? body.error ?? m.music_importFailed());
				return;
			}
			toasts.success(m.music_importedAlbum({ title: album.title }));
			importOpen = false;
			importPath = '';
			await invalidateAll();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.music_importFailed());
		} finally {
			importing = false;
		}
	}

	async function removeAlbum() {
		if (deleting) return;
		deleting = true;
		try {
			const response = await fetch(`/api/music/albums/${album.id}`, { method: 'DELETE' });
			if (!response.ok) {
				const body = await response.json().catch(() => ({}));
				toasts.error(body.details ?? body.error ?? m.common_failedToSave());
				return;
			}
			toasts.success(m.music_removedAlbum({ title: album.title }));
			await goto('/library/music');
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.common_failedToSave());
		} finally {
			deleting = false;
		}
	}

	/** Per-track row action: the album is what gets searched, from any of its songs. */
	const busyTrackIds = new SvelteSet<string>();
	let searchTrack = $state<{ id: string; title: string } | null>(null);

	async function autoSearchFromTrack(track: { id: string }) {
		if (busyTrackIds.has(track.id)) return;
		busyTrackIds.add(track.id);
		try {
			const response = await fetch(`/api/music/albums/${album.id}/auto-search`, {
				method: 'POST'
			});
			const body = await response.json().catch(() => ({}));
			if (body.grabbed) {
				toasts.success(m.music_grabbed({ title: body.release ?? album.title }));
				await invalidateAll();
			} else {
				toasts.info(body.error ?? m.music_noReleases());
			}
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.music_searchFailed());
		} finally {
			busyTrackIds.delete(track.id);
		}
	}

	const releaseCount = $derived(candidates.length);
	const hasAccepted = $derived(candidates.some((candidate) => candidate.accepted));
</script>

<svelte:head><title>{album.title} · {m.nav_music()} · Cinephage</title></svelte:head>

<div class="flex w-full flex-col gap-4 overflow-x-hidden px-4 pb-20 md:gap-6 md:px-6 lg:px-8">
	<!-- Header -->
	<AlbumHero
		album={{ ...album, monitored }}
		coverUrl={album.hasCover ? `/api/music/albums/${album.id}/cover` : null}
		artistHref={`/library/music/artist/${album.artistId}`}
		backHref="/library/music"
		backLabel={m.nav_music()}
		featured={data.featured}
		onMonitorToggle={toggleMonitor}
		{monitorBusy}
		onFindReleases={findReleases}
		findBusy={searchingReleases}
		onGrabBest={hasAccepted ? () => grab(null) : null}
		grabBusy={grabbingGuid !== null}
		onImport={() => (importOpen = true)}
		onEdit={() => (editOpen = true)}
		onRemove={() => (deleteOpen = true)}
		onRefresh={refreshAlbum}
		{refreshing}
		onChangeMatch={() => (matchOpen = true)}
	/>

	<!-- Main content: the movie detail page's grid, with tracks for files. -->
	<div class="grid gap-4 lg:grid-cols-2 lg:gap-6 xl:grid-cols-3">
		<div class="min-w-0 md:col-span-2 lg:col-span-2">
			<div class="min-w-0 overflow-hidden rounded-xl bg-base-200 p-4 md:p-6">
				<div class="mb-4 flex flex-wrap items-center justify-between gap-2">
					<h2 class="text-lg font-semibold">
						{m.music_tracksLabel()}
						<span class="ml-1 badge badge-ghost badge-sm">{album.tracks.length}</span>
					</h2>
					{#if album.tracks.length > 0}
						<label class="input w-full max-w-xs input-sm">
							<Search class="h-4 w-4 opacity-40" />
							<input
								class="grow"
								placeholder={m.music_filterTracks()}
								bind:value={trackFilter}
								aria-label={m.music_filterTracks()}
							/>
						</label>
					{/if}
				</div>

				{#if album.tracks.length === 0}
					<div
						class="rounded-lg bg-base-300/40 px-6 py-12 text-center text-sm text-base-content/55"
					>
						{m.music_noTracks()}
					</div>
				{:else}
					<TrackList
						tracks={visibleTracks}
						artistName={album.artistName}
						onAutoSearch={autoSearchFromTrack}
						onOpenSearch={(track) => (searchTrack = { id: track.id, title: track.title })}
						{busyTrackIds}
					/>
				{/if}
			</div>

			<!-- Releases: the second panel under Files, on the same card grammar. -->
			<div class="mt-4 rounded-xl bg-base-200 md:mt-6">
				<div class="flex flex-wrap items-center justify-between gap-3 p-4 pb-3 md:p-6">
					<div class="flex items-center gap-2">
						<Download class="h-4 w-4 shrink-0 text-primary" />
						<h2 class="text-lg font-semibold">
							{m.music_releasesTab()}
							{#if releaseCount > 0}
								<span class="badge badge-ghost badge-sm">{releaseCount}</span>
							{/if}
						</h2>
					</div>
					<div class="flex items-center gap-1">
						{#if hasAccepted}
							<button
								class="btn gap-1.5 btn-primary btn-sm"
								disabled={grabbingGuid !== null}
								onclick={() => grab(null)}
							>
								{#if grabbingGuid === 'best'}
									<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
								{:else}
									<Download class="h-3.5 w-3.5" />
								{/if}
								{m.music_grabBest()}
							</button>
						{/if}
						<button
							class="btn gap-1.5 btn-ghost btn-sm"
							disabled={searchingReleases}
							onclick={findReleases}
						>
							{#if searchingReleases}
								<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
							{:else}
								<Search class="h-3.5 w-3.5" />
							{/if}
							{m.music_findReleases()}
						</button>
					</div>
				</div>

				<div class="px-4 pb-4 md:px-6">
					{#if grabError}
						<p class="pb-3 text-sm text-error">{grabError}</p>
					{/if}
					{#if grabbed}
						<p class="pb-3 text-sm text-success">{m.music_grabbed({ title: grabbed })}</p>
					{/if}
					{#if releaseError}
						<p class="py-4 text-sm text-base-content/55">{releaseError}</p>
					{:else if searchingReleases && candidates.length === 0}
						<p class="py-4 text-sm text-base-content/55">{m.common_searching()}</p>
					{:else if candidates.length === 0}
						<p class="py-4 text-sm text-base-content/55">
							{searched ? m.common_noResults() : m.music_releasesTitle()}
						</p>
					{:else}
						<div class="overflow-hidden rounded-lg bg-base-100">
							<table class="table table-sm">
								<thead>
									<tr class="border-base-content/10 bg-base-200/40">
										<th>{m.music_titleHeader()}</th>
										<th class="w-32">{m.music_indexer()}</th>
										<th class="w-24 text-right">{m.music_size()}</th>
										<th class="w-28">{m.music_quality()}</th>
										<th class="w-20 text-right">{m.music_seeders()}</th>
										<th class="w-16"></th>
									</tr>
								</thead>
								<tbody>
									{#each candidates as candidate (candidate.title + (candidate.indexerName ?? ''))}
										<tr class="border-base-content/5 hover:bg-base-200/40">
											<td class="max-w-0 truncate" title={candidate.title}>
												<span class="font-medium">{candidate.title}</span>
												{#if candidate.accepted === false && candidate.reasons?.length}
													<span class="ml-2 text-xs text-warning">{candidate.reasons[0]}</span>
												{/if}
											</td>
											<td class="text-xs text-base-content/55">{candidate.indexerName ?? '–'}</td>
											<td class="text-right font-mono text-xs text-base-content/60 tabular-nums">
												{gib(candidate.size)}
											</td>
											<td>
												<span
													class="badge badge-sm"
													class:badge-ghost={candidate.accepted === false}
												>
													{musicQualityLabel(candidate)}
												</span>
											</td>
											<td class="text-right tabular-nums">{candidate.seeders ?? '–'}</td>
											<td class="text-right">
												<button
													class="btn btn-ghost btn-xs"
													disabled={grabbingGuid !== null}
													title={candidate.accepted === false
														? (candidate.reasons?.[0] ?? m.music_grabFailed())
														: (candidate.tierLabel ?? '')}
													onclick={() => grab(candidate)}
												>
													{#if grabbingGuid === candidate.guid}
														<LoaderCircle class="h-3 w-3 animate-spin" />
													{:else}
														{m.music_grab()}
													{/if}
												</button>
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}
				</div>
			</div>
			<!-- Files: the audio half of the movie page's file management block. -->
			{#if album.files.length > 0}
				<div class="mt-4 rounded-xl bg-base-200 md:mt-6">
					<div class="flex flex-wrap items-center justify-between gap-3 p-4 pb-3 md:p-6">
						<div class="flex items-center gap-2">
							<FileAudio class="h-4 w-4 shrink-0 text-primary" />
							<h2 class="text-lg font-semibold">
								{m.common_files()}
								<span class="ml-1 badge badge-ghost badge-sm">{album.files.length}</span>
							</h2>
						</div>
					</div>
					<div class="px-4 pb-4 md:px-6">
						<div class="overflow-hidden rounded-lg bg-base-100">
							{#each album.files as file (file.id)}
								<div
									class="flex items-center gap-3 border-b border-base-300/60 px-3 py-2 last:border-b-0"
								>
									<div class="min-w-0 flex-1">
										<p class="truncate text-sm font-medium">
											{file.trackTitle ?? file.relativePath}
										</p>
										<p class="truncate text-xs text-base-content/55">{file.relativePath}</p>
									</div>
									<span class="badge badge-ghost badge-sm whitespace-nowrap">
										{[
											file.format?.toUpperCase(),
											file.bitDepth ? `${file.bitDepth}-bit` : null,
											file.bitrateKbps ? `${file.bitrateKbps} kbps` : null
										]
											.filter(Boolean)
											.join(' · ') || '—'}
									</span>
									<span class="text-xs text-base-content/60 tabular-nums">
										{formatBytes(file.sizeBytes)}
									</span>
									<button
										class="btn btn-square btn-ghost text-error btn-xs"
										title={m.common_delete()}
										aria-label={m.common_delete()}
										onclick={() =>
											(fileToDelete = {
												id: file.id,
												name: file.trackTitle ?? file.relativePath
											})}
									>
										<Trash2 class="h-3.5 w-3.5" />
									</button>
								</div>
							{/each}
						</div>
					</div>
				</div>
			{/if}
		</div>

		<!-- Sidebar: the same details grammar as the movie and series pages. -->
		<div class="min-w-0 space-y-4 md:space-y-6">
			<Panel title={m.common_details()}>
				<dl class="space-y-2 text-sm">
					<FactRow label={m.music_tabArtist()}>
						<a class="link link-primary" href={`/library/music/artist/${album.artistId}`}>
							{album.artistName}
						</a>
					</FactRow>
					{#if album.genres && album.genres.length > 0}
						<FactRow label={m.common_genres()} variant="block">
							<div class="flex flex-wrap gap-1">
								{#each album.genres.slice(0, 8) as genre (genre)}
									<span class="badge badge-ghost badge-xs">{genre}</span>
								{/each}
								{#if album.genres.length > 8}
									<span class="badge badge-ghost badge-xs" title={album.genres.slice(8).join(", ")}
										>+{album.genres.length - 8}</span
									>
								{/if}
							</div>
						</FactRow>
					{/if}
					<FactRow label={m.music_qualityProfile()}>
						<select
							class="select-bordered select select-xs"
							value={activeProfile ?? ''}
							disabled={profileBusy}
							onchange={(event) => saveQualityProfile(event.currentTarget.value || null)}
						>
							<option value="">
								{data.inheritedProfileName
									? m.music_inheritDefault({ name: data.inheritedProfileName })
									: m.music_inheritProfile()}
							</option>
							{#each data.qualityProfiles as profile (profile.id)}
								<option value={profile.id}>{profile.name}</option>
							{/each}
						</select>
					</FactRow>
					{#if album.primaryType}
						<FactRow
							label={m.music_typeLabel()}
							value={[album.primaryType, ...(album.secondaryTypes ?? [])].join(', ')}
						/>
					{/if}
					{#if album.status}
						<FactRow label={m.common_status()}>
							<span class="capitalize">{album.status.toLowerCase()}</span>
						</FactRow>
					{/if}
					{#if album.labelName}
						<FactRow label={m.music_labelLabel()} value={album.labelName} />
					{/if}
					{#if album.catalogNumber}
						<FactRow label={m.music_catalogNumber()} value={album.catalogNumber} mono />
					{/if}
					{#if album.barcode}
						<FactRow label={m.music_barcode()} value={album.barcode} mono />
					{/if}
					{#if album.country}
						<FactRow label={m.music_country()} value={album.country} />
					{/if}
					{#if album.mbid}
						<FactRow
							label="MusicBrainz"
							value={album.mbid}
							href={`https://musicbrainz.org/release-group/${album.mbid}`}
							mono
						/>
					{/if}
					{#if album.path}
						<FactRow label={m.common_path()} variant="block" mono>{album.path}</FactRow>
					{/if}
				</dl>
			</Panel>
		</div>
	</div>

	{#if data.moreFromArtist.length > 0}
		<section class="mt-8">
			<h2 class="mb-3 text-lg font-semibold">
				{m.music_moreFromArtist({ artist: album.artistName })}
			</h2>
			<div class="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
				{#each data.moreFromArtist as entry (entry.id)}
					<LibraryMediaCard view={albumCardView(entry)} />
				{/each}
			</div>
		</section>
	{/if}
</div>

<TrackSearchModal
	open={searchTrack !== null}
	track={searchTrack}
	albumId={album.id}
	albumTitle={album.title}
	onClose={() => (searchTrack = null)}
/>

<ModalWrapper open={importOpen} onClose={() => (importOpen = false)} maxWidth="lg">
	<h2 class="text-lg font-bold">{m.music_importFromDisk()}</h2>
	<p class="mt-1 text-sm text-base-content/55">{m.music_importHint()}</p>
	<form
		class="mt-4 flex gap-2"
		onsubmit={(event) => {
			event.preventDefault();
			importFolder();
		}}
	>
		<input
			class="input w-full font-mono input-sm"
			bind:value={importPath}
			placeholder="/media/Music/Artist/Album"
			aria-label={m.common_path()}
		/>
		<button
			class="btn gap-1.5 btn-primary btn-sm"
			type="submit"
			disabled={importing || !importPath.trim()}
		>
			{#if importing}
				<LoaderCircle class="h-4 w-4 animate-spin" />
			{:else}
				<HardDriveDownload class="h-4 w-4" />
			{/if}
			{m.music_importAction()}
		</button>
	</form>
</ModalWrapper>

<MusicMatchModal
	open={matchOpen}
	kind="album"
	mediaId={album.id}
	currentTitle={album.title}
	artistName={album.artistName}
	onClose={() => (matchOpen = false)}
	onSuccess={async () => {
		await invalidateAll();
	}}
/>

<AlbumEditModal
	open={editOpen}
	album={{ ...album, qualityProfileId: activeProfile ?? null }}
	qualityProfiles={data.qualityProfiles}
	inheritedProfileName={data.inheritedProfileName}
	saving={editSaving}
	onClose={() => (editOpen = false)}
	onSave={saveAlbumEdit}
/>

<ConfirmationModal
	open={fileToDelete !== null}
	title={m.music_deleteFileTitle()}
	message={m.music_deleteFileMessage({ file: fileToDelete?.name ?? '' })}
	confirmLabel={m.common_delete()}
	confirmVariant="error"
	loading={deletingFile}
	onConfirm={removeFile}
	onCancel={() => (fileToDelete = null)}
/>

<ConfirmationModal
	open={deleteOpen}
	title={m.music_removeAlbum()}
	message={m.music_removeAlbumConfirm({ title: album.title })}
	confirmLabel={m.common_delete()}
	confirmVariant="error"
	loading={deleting}
	onConfirm={removeAlbum}
	onCancel={() => (deleteOpen = false)}
/>
