<script lang="ts">
	import { LoaderCircle, Search, Zap } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { ModalWrapper } from '#lib/components/ui/modal/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import ReleaseTable from './ReleaseTable.svelte';
	import type { ReleaseRow } from './release-row.js';

	export type TrackSearchCandidate = ReleaseRow;

	type Props = {
		open: boolean;
		track: { id: string; title: string } | null;
		albumId: string;
		albumTitle: string;
		onClose: () => void;
	};

	let { open, track, albumId, albumTitle, onClose }: Props = $props();

	let loading = $state(false);
	let candidates = $state<TrackSearchCandidate[]>([]);
	let error = $state<string | null>(null);
	let grabbing = $state<string | null>(null);
	let lastTrackId: string | null = null;

	/** Letters and digits only — release titles are punctuation soup. */
	function normalize(text: string): string {
		return text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.trim();
	}

	function containsAll(haystack: string, needle: string): boolean {
		const tokens = normalize(needle)
			.split(' ')
			.filter((token) => token.length > 2);
		if (tokens.length === 0) return false;
		const normalizedHaystack = normalize(haystack);
		return tokens.every((token) => normalizedHaystack.includes(token));
	}

	async function load() {
		if (!track || loading) return;
		loading = true;
		error = null;
		candidates = [];
		try {
			const endpoint = track
				? `/api/music/tracks/${track.id}/search`
				: `/api/music/albums/${albumId}/search`;
			const response = await fetch(endpoint, { method: 'POST' });
			const body = await response.json().catch(() => ({}));
			if (!response.ok) {
				error = body.details ?? body.error ?? m.music_searchFailed();
				return;
			}
			candidates = body.candidates ?? [];
		} catch (err) {
			error = err instanceof Error ? err.message : m.music_searchFailed();
		} finally {
			loading = false;
		}
	}

	// Opening on a new track starts a fresh search; reopening the same one
	// keeps the list the user was already reading.
	$effect(() => {
		if (open && track && track.id !== lastTrackId) {
			lastTrackId = track.id;
			load();
		}
		if (!open) lastTrackId = null;
	});

	async function grab(candidate: TrackSearchCandidate | null) {
		if (grabbing) return;
		grabbing = candidate?.guid ?? 'best';
		error = null;
		try {
			const response = await fetch(`/api/music/albums/${albumId}/grab`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(candidate?.guid ? { releaseGuid: candidate.guid } : {})
			});
			const body = await response.json().catch(() => ({}));
			if (!response.ok) {
				error = body.details ?? body.error ?? m.music_grabFailed();
				return;
			}
			toasts.success(m.music_grabbed({ title: body.title ?? candidate?.title ?? albumTitle }));
			onClose();
		} catch (err) {
			error = err instanceof Error ? err.message : m.music_grabFailed();
		} finally {
			grabbing = null;
		}
	}

	async function autoGrab() {
		if (grabbing) return;
		grabbing = 'best';
		try {
			const response = await fetch(`/api/music/albums/${albumId}/auto-search`, { method: 'POST' });
			const body = await response.json().catch(() => ({}));
			if (body.grabbed) {
				toasts.success(m.music_grabbed({ title: body.release ?? albumTitle }));
				onClose();
			} else {
				error = body.error ?? m.music_noReleases();
			}
		} catch (err) {
			error = err instanceof Error ? err.message : m.music_searchFailed();
		} finally {
			grabbing = null;
		}
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="xl" labelledBy="track-search-modal-title">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div class="min-w-0">
			<h2 id="track-search-modal-title" class="truncate text-lg font-bold">
				{track?.title ?? albumTitle}
			</h2>
			<p class="mt-0.5 text-sm text-base-content/55">
				{albumTitle}
			</p>
		</div>
		<div class="flex items-center gap-1">
			<button
				class="btn gap-1.5 btn-primary btn-sm"
				disabled={grabbing !== null}
				onclick={autoGrab}
			>
				{#if grabbing === 'best'}
					<LoaderCircle class="h-4 w-4 animate-spin" />
				{:else}
					<Zap class="h-4 w-4" />
				{/if}
				{m.music_grabBest()}
			</button>
			<button class="btn gap-1.5 btn-ghost btn-sm" disabled={loading} onclick={load}>
				{#if loading}
					<LoaderCircle class="h-4 w-4 animate-spin" />
				{:else}
					<Search class="h-4 w-4" />
				{/if}
				{m.action_refresh()}
			</button>
		</div>
	</div>

	<div class="mt-4">
		{#if error}
			<p class="py-4 text-sm text-base-content/55">{error}</p>
		{:else if loading}
			<p class="py-4 text-sm text-base-content/55">{m.common_searching()}</p>
		{:else if candidates.length === 0}
			<p class="py-4 text-sm text-base-content/55">
				{track ? m.music_noTrackReleases() : m.music_noReleases()}
			</p>
		{:else}
			<ReleaseTable rows={candidates} {grabbing} onGrab={grab} />
		{/if}
	</div>
</ModalWrapper>
