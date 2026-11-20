<script lang="ts">
	import { Download, LoaderCircle, Search, Zap } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { ModalWrapper } from '#lib/components/ui/modal/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { musicQualityLabel } from './release-quality.js';

	export type TrackSearchCandidate = {
		guid: string | null;
		title: string;
		indexerName: string | null;
		size: number | null;
		seeders: number | null;
		format?: string;
		bitDepth?: number | null;
		sampleRateKhz?: number | null;
		bitrateKbps?: number | null;
		accepted?: boolean;
		tierLabel?: string | null;
		reasons?: string[];
	};

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

	/**
	 * A song can be taken from two places: the album it sits on, or a single
	 * release named after the song. Anything else on the artist's shelf is not
	 * this song, so it is not offered here — same rule the album row applies.
	 */
	const visible = $derived(
		candidates.filter(
			(candidate) =>
				containsAll(candidate.title, albumTitle) ||
				(track ? containsAll(candidate.title, track.title) : false)
		)
	);

	async function load() {
		if (!track || loading) return;
		loading = true;
		error = null;
		candidates = [];
		try {
			const response = await fetch(`/api/music/albums/${albumId}/search`, { method: 'POST' });
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

	function gib(bytes: number | null): string {
		if (!bytes) return '–';
		return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
	}

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

<ModalWrapper {open} {onClose} maxWidth="xl">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div class="min-w-0">
			<h2 class="truncate text-lg font-bold">{track?.title ?? albumTitle}</h2>
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
				{m.music_findReleases()}
			</button>
		</div>
	</div>

	<div class="mt-4">
		{#if error}
			<p class="py-4 text-sm text-base-content/55">{error}</p>
		{:else if loading}
			<p class="py-4 text-sm text-base-content/55">{m.common_searching()}</p>
		{:else if visible.length === 0}
			<p class="py-4 text-sm text-base-content/55">{m.common_noResults()}</p>
		{:else}
			<div class="overflow-hidden rounded-lg bg-base-200">
				<table class="table table-sm">
					<thead>
						<tr class="border-base-content/10">
							<th>{m.music_titleHeader()}</th>
							<th class="w-32">{m.music_indexer()}</th>
							<th class="w-24 text-right">{m.music_size()}</th>
							<th class="w-28">{m.music_quality()}</th>
							<th class="w-20 text-right">{m.music_seeders()}</th>
							<th class="w-16"></th>
						</tr>
					</thead>
					<tbody>
						{#each visible as candidate (candidate.title + (candidate.indexerName ?? ''))}
							<tr class="border-base-content/5">
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
										{musicQualityLabel(candidate)}
									</span>
								</td>
								<td class="text-right tabular-nums">{candidate.seeders ?? '–'}</td>
								<td class="text-right">
									<button
										class="btn gap-1 btn-ghost btn-xs"
										disabled={grabbing !== null}
										title={candidate.accepted === false
											? (candidate.reasons?.[0] ?? m.music_grabFailed())
											: (candidate.tierLabel ?? '')}
										onclick={() => grab(candidate)}
									>
										{#if grabbing === candidate.guid}
											<LoaderCircle class="h-3 w-3 animate-spin" />
										{:else}
											<Download class="h-3 w-3" />
										{/if}
										{m.music_grab()}
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</ModalWrapper>
