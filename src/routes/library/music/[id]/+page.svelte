<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import type { PageData } from './$types.js';
	import { Download, HardDriveDownload, LoaderCircle, Search, Trash2 } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AlbumHero from '#lib/components/music/AlbumHero.svelte';
	import TrackList from '#lib/components/music/TrackList.svelte';
	import { ConfirmationModal, ModalWrapper } from '#lib/components/ui/modal/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';

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
		sampleRateKhz?: number | null;
		score?: number;
		accepted?: boolean;
		tierLabel?: string | null;
		reasons?: string[];
	};

	const album = $derived(data.album);
	let activeTab = $state<'tracks' | 'releases'>('tracks');
	// The toggle is optimistic: null means "whatever the server sent", and a
	// failure puts the override back rather than leaving the UI lying.
	let monitoredOverride = $state<boolean | null>(null);
	const monitored = $derived(monitoredOverride ?? Boolean(data.album.monitored));
	let monitorBusy = $state(false);

	let searchingReleases = $state(false);
	let grabError = $state<string | null>(null);
	let grabbed = $state<string | null>(null);
	let grabbingGuid = $state<string | 'best' | null>(null);
	let candidates = $state<Candidate[]>([]);
	let releaseError = $state<string | null>(null);
	let searched = $state(false);

	let importOpen = $state(false);
	let importPath = $state('');
	let importing = $state(false);
	let deleteOpen = $state(false);
	let deleting = $state(false);

	function qualityLabel(candidate: Candidate): string {
		const format = (candidate.format ?? 'unknown').toUpperCase();
		const depth = candidate.bitDepth ? ` ${candidate.bitDepth}-bit` : '';
		const rate = candidate.sampleRateKhz ? `/${candidate.sampleRateKhz}` : '';
		return `${format}${depth}${rate}`;
	}

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

	async function findReleases() {
		if (searchingReleases) return;
		searchingReleases = true;
		searched = true;
		activeTab = 'releases';
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

	const releaseCount = $derived(candidates.length);
</script>

<svelte:head><title>{album.title} · {m.nav_music()} · Cinephage</title></svelte:head>

<div class="w-full px-4 pt-4 pb-20 md:px-6 lg:px-8">
	<AlbumHero
		album={{ ...album, monitored }}
		coverUrl={album.hasCover ? `/api/music/albums/${album.id}/cover` : null}
		artistHref={album.artistMbid ? `/discover/music/artist/${album.artistMbid}` : null}
		backHref="/library/music"
		backLabel={m.nav_music()}
		onMonitorToggle={toggleMonitor}
		{monitorBusy}
	>
		{#snippet actions()}
			<button class="btn gap-1.5 btn-primary btn-sm" disabled={searchingReleases} onclick={findReleases}>
				{#if searchingReleases}
					<LoaderCircle class="h-4 w-4 animate-spin" />
				{:else}
					<Search class="h-4 w-4" />
				{/if}
				{m.music_findReleases()}
			</button>
			{#if candidates.some((candidate) => candidate.accepted)}
				<button
					class="btn gap-1.5 btn-secondary btn-sm"
					disabled={grabbingGuid !== null}
					onclick={() => grab(null)}
				>
					{#if grabbingGuid === 'best'}
						<LoaderCircle class="h-4 w-4 animate-spin" />
					{:else}
						<Download class="h-4 w-4" />
					{/if}
					{m.music_grabBest()}
				</button>
			{/if}
			<button class="btn gap-1.5 btn-ghost btn-sm" onclick={() => (importOpen = true)}>
				<HardDriveDownload class="h-4 w-4" />
				{m.music_importFromDisk()}
			</button>
			<button class="btn gap-1.5 btn-ghost btn-sm text-error hover:bg-error/10" onclick={() => (deleteOpen = true)}>
				<Trash2 class="h-4 w-4" />
				{m.music_removeAlbum()}
			</button>
		{/snippet}
	</AlbumHero>

	<div class="mt-5 flex items-center gap-1 border-b border-base-content/10">
		<button
			class="border-b-2 px-3 py-2 text-sm font-medium transition-colors {activeTab === 'tracks'
				? 'border-primary text-primary'
				: 'border-transparent text-base-content/55 hover:text-base-content'}"
			onclick={() => (activeTab = 'tracks')}
		>
			{m.music_tracksLabel()}
			<span class="ml-1.5 badge badge-sm badge-ghost">{album.tracks.length}</span>
		</button>
		<button
			class="border-b-2 px-3 py-2 text-sm font-medium transition-colors {activeTab === 'releases'
				? 'border-primary text-primary'
				: 'border-transparent text-base-content/55 hover:text-base-content'}"
			onclick={() => {
				activeTab = 'releases';
				if (!searched) findReleases();
			}}
		>
			{m.music_releasesTab()}
			{#if releaseCount > 0}
				<span class="ml-1.5 badge badge-sm badge-ghost">{releaseCount}</span>
			{/if}
		</button>
	</div>

	<div class="mt-4">
		{#if activeTab === 'tracks'}
			{#if album.tracks.length === 0}
				<div
					class="rounded-xl border border-dashed border-base-content/15 px-6 py-12 text-center text-sm text-base-content/55"
				>
					{m.music_noTracks()}
				</div>
			{:else}
				<TrackList tracks={album.tracks} artistName={album.artistName} />
			{/if}
		{:else}
			<div class="rounded-xl border border-base-content/10 bg-base-100">
				<div class="flex flex-wrap items-center justify-between gap-3 border-b border-base-content/10 px-4 py-3">
					<p class="text-sm font-medium">{m.music_releasesTab()}</p>
					<div class="flex items-center gap-2">
						{#if candidates.some((candidate) => candidate.accepted)}
							<button
								class="btn gap-1.5 btn-primary btn-xs"
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
						<button class="btn gap-1.5 btn-outline btn-xs" disabled={searchingReleases} onclick={findReleases}>
							{#if searchingReleases}
								<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
							{:else}
								<Search class="h-3.5 w-3.5" />
							{/if}
							{m.music_findReleases()}
						</button>
					</div>
				</div>

				{#if grabError}
					<p class="px-4 pt-3 text-sm text-error">{grabError}</p>
				{/if}
				{#if grabbed}
					<p class="px-4 pt-3 text-sm text-success">{m.music_grabbed({ title: grabbed })}</p>
				{/if}
				{#if releaseError}
					<p class="px-4 py-6 text-sm text-base-content/55">{releaseError}</p>
				{:else if searchingReleases && candidates.length === 0}
					<p class="px-4 py-6 text-sm text-base-content/55">{m.common_searching()}</p>
				{:else if candidates.length === 0}
					<p class="px-4 py-6 text-sm text-base-content/55">{m.common_noResults()}</p>
				{:else}
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
										<span class="badge badge-sm" class:badge-ghost={candidate.accepted === false}>
											{qualityLabel(candidate)}
										</span>
									</td>
									<td class="text-right tabular-nums">{candidate.seeders ?? '–'}</td>
									<td class="text-right">
										<button
											class="btn btn-ghost btn-xs"
											disabled={grabbingGuid !== null || candidate.accepted === false}
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
				{/if}
			</div>
		{/if}
	</div>
</div>

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
			class="input w-full input-sm font-mono"
			bind:value={importPath}
			placeholder="/media/Music/Artist/Album"
			aria-label={m.common_path()}
		/>
		<button class="btn gap-1.5 btn-primary btn-sm" type="submit" disabled={importing || !importPath.trim()}>
			{#if importing}
				<LoaderCircle class="h-4 w-4 animate-spin" />
			{:else}
				<HardDriveDownload class="h-4 w-4" />
			{/if}
			{m.music_importAction()}
		</button>
	</form>
</ModalWrapper>

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
