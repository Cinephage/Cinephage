<script lang="ts">
	/**
	 * Interactive release search for a whole discography — the multi-season
	 * search of music. Rows are filed under the album each release names, so a
	 * grab always targets the album it belongs to.
	 */
	import { LoaderCircle, RefreshCw } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { ModalWrapper } from '#lib/components/ui/modal/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import ReleaseTable from './ReleaseTable.svelte';
	import type { ReleaseRow } from './release-row.js';

	type Candidate = ReleaseRow & { albumId: string; albumTitle: string };

	type Props = {
		open: boolean;
		artistId: string;
		artistName: string;
		onClose: () => void;
	};

	let { open, artistId, artistName, onClose }: Props = $props();

	let loading = $state(false);
	let candidates = $state<Candidate[]>([]);
	let error = $state<string | null>(null);
	let grabbing = $state<string | null>(null);
	let loadedFor = $state<string | null>(null);

	const groups = $derived.by(() => {
		const byAlbum = new Map<string, Candidate[]>();
		for (const candidate of candidates) {
			const rows = byAlbum.get(candidate.albumTitle) ?? [];
			rows.push(candidate);
			byAlbum.set(candidate.albumTitle, rows);
		}
		return [...byAlbum.entries()].sort(([a], [b]) => a.localeCompare(b));
	});

	async function load() {
		if (loading) return;
		loading = true;
		error = null;
		try {
			const response = await fetch(`/api/music/artists/${artistId}/releases`, { method: 'POST' });
			const body = await response.json().catch(() => ({}));
			if (!response.ok) {
				error = body.details ?? body.error ?? m.music_searchFailed();
				candidates = [];
				return;
			}
			candidates = body.candidates ?? [];
		} catch (err) {
			error = err instanceof Error ? err.message : m.music_searchFailed();
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (open && loadedFor !== artistId) {
			loadedFor = artistId;
			void load();
		}
		if (!open) {
			loadedFor = null;
			candidates = [];
			error = null;
		}
	});

	async function grab(candidate: Candidate) {
		if (grabbing) return;
		grabbing = candidate.guid ?? 'best';
		try {
			const response = await fetch(`/api/music/albums/${candidate.albumId}/grab`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ releaseGuid: candidate.guid })
			});
			const body = await response.json().catch(() => ({}));
			if (!response.ok) {
				toasts.error(body.details ?? body.error ?? m.music_grabFailed());
				return;
			}
			toasts.success(m.music_grabbed({ title: body.title ?? candidate.title }));
			onClose();
		} catch (err) {
			toasts.error(err instanceof Error ? err.message : m.music_grabFailed());
		} finally {
			grabbing = null;
		}
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="4xl" labelledBy="artist-releases-modal-title">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div class="min-w-0">
			<h2 id="artist-releases-modal-title" class="truncate text-lg font-bold">
				{m.music_findReleases()}
			</h2>
			<p class="mt-0.5 text-sm text-base-content/55">{artistName}</p>
		</div>
		<button class="btn gap-1.5 btn-ghost btn-sm" disabled={loading} onclick={load}>
			{#if loading}
				<LoaderCircle class="h-4 w-4 animate-spin" />
			{:else}
				<RefreshCw class="h-4 w-4" />
			{/if}
			{m.action_refresh()}
		</button>
	</div>

	<div class="mt-4 max-h-[65vh] space-y-4 overflow-y-auto">
		{#if error}
			<p class="py-4 text-sm text-base-content/55">{error}</p>
		{:else if loading && candidates.length === 0}
			<p class="py-4 text-sm text-base-content/55">{m.common_searching()}</p>
		{:else if groups.length === 0}
			<p class="py-4 text-sm text-base-content/55">{m.music_noReleases()}</p>
		{:else}
			{#each groups as [albumTitle, rows] (albumTitle)}
				<section>
					<h3 class="mb-1 text-sm font-semibold">
						{albumTitle}
						<span class="ml-2 text-xs font-normal text-base-content/50">{rows.length}</span>
					</h3>
					<ReleaseTable rows={rows} {grabbing} onGrab={grab} />
				</section>
			{/each}
		{/if}
	</div>
</ModalWrapper>
