<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Clapperboard, Disc3, X, Check } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { listRequests, cancelRequest, type MediaRequest } from '#lib/api/requests.js';
	import RequestModal from './RequestModal.svelte';
	import RequestStatusBadge from './RequestStatusBadge.svelte';

	interface Props {
		/** Discover pages use 'tv'; the request API uses 'series'. */
		mediaType: 'movie' | 'tv' | 'music';
		/** TMDB id for movie/tv; the release-group id for music. */
		tmdbId?: number;
		mbid?: string;
		title: string;
		year?: number | null;
		posterPath?: string | null;
		coverUrl?: string | null;
		onChange?: () => void;
	}

	let { mediaType, tmdbId, mbid, title, year, posterPath, coverUrl, onChange }: Props = $props();

	let showModal = $state(false);
	let ownRequests = $state<MediaRequest[]>([]);
	let loaded = $state(false);
	let cancelling = $state(false);

	const isMusic = $derived(mediaType === 'music');
	const requestMediaType = $derived(
		mediaType === 'music' ? 'music' : mediaType === 'tv' ? 'series' : 'movie'
	);
	const identity = $derived(isMusic ? (mbid ?? '') : String(tmdbId ?? ''));

	// The live one wins; otherwise show the newest request so the user still
	// sees where theirs stands (declined/expired keep the request action).
	let activeRequest = $derived(
		ownRequests.find(
			(r) => r.status === 'pending' || r.status === 'approved' || r.status === 'awaiting_target'
		) ?? ownRequests.find((r) => r.status === 'failed')
	);
	let fulfilledRequest = $derived(ownRequests.find((r) => r.status === 'fulfilled'));

	async function load(media: 'movie' | 'series' | 'music', id: string) {
		try {
			const all = await listRequests({ take: 100 });
			ownRequests = all.filter((r) =>
				media === 'music' ? r.mediaType === media && r.mbid === id : r.mediaType === media && String(r.tmdbId) === id
			);
		} catch {
			// Non-fatal: the request action still renders.
		} finally {
			loaded = true;
		}
	}

	// Track the identity props synchronously so intra-route navigation
	// between two detail pages reloads the request state (the reads must
	// happen inside the effect, not after an await).
	$effect(() => {
		const media = requestMediaType;
		const id = identity;
		void load(media, id);
	});

	async function cancelPending() {
		if (!activeRequest) return;
		cancelling = true;
		try {
			await cancelRequest(activeRequest.id);
			toasts.info(m.requests_cancelled({ title }));
			await load(requestMediaType, identity);
			onChange?.();
		} catch {
			toasts.error(m.requests_errorGeneric());
		} finally {
			cancelling = false;
		}
	}

	function handleSuccess() {
		void load(requestMediaType, identity);
		onChange?.();
	}
</script>

{#if loaded}
	{#if fulfilledRequest}
		<span
			class="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-3 py-1 text-sm font-medium text-success"
		>
			<Check class="h-4 w-4" strokeWidth={2.5} />
			{m.requests_status_fulfilled()}
		</span>
	{:else if activeRequest}
		<div
			class="flex items-center gap-2 rounded-full bg-base-content/[0.04] py-1 pr-1 pl-2.5 {activeRequest.status ===
			'awaiting_target'
				? 'border border-warning/25'
				: ''}"
		>
			<RequestStatusBadge status={activeRequest.status} size="xs" />
			{#if activeRequest.status === 'pending'}
				<button
					type="button"
					class="btn btn-circle btn-ghost btn-xs"
					disabled={cancelling}
					onclick={cancelPending}
					title={m.requests_cancelRequest()}
					aria-label={m.requests_cancelRequest()}
				>
					<X class="h-3.5 w-3.5" />
				</button>
			{/if}
		</div>
	{:else}
		<button type="button" class="btn gap-1.5 btn-primary btn-sm" onclick={() => (showModal = true)}>
			{#if isMusic}
				<Disc3 class="h-4 w-4" />
				{m.requests_requestAlbum()}
			{:else if mediaType === 'tv'}
				<Clapperboard class="h-4 w-4" />
				{m.requests_requestSeries()}
			{:else}
				<Clapperboard class="h-4 w-4" />
				{m.requests_requestMovie()}
			{/if}
		</button>
	{/if}
{/if}

<RequestModal
	open={showModal}
	{mediaType}
	{tmdbId}
	{mbid}
	{title}
	{year}
	{posterPath}
	{coverUrl}
	onClose={() => (showModal = false)}
	onSuccess={handleSuccess}
/>
