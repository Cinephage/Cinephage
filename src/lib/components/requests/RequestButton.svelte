<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Clapperboard, X, Check } from '@lucide/svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { listRequests, cancelRequest, type MediaRequest } from '#lib/api/requests.js';
	import RequestModal from './RequestModal.svelte';
	import RequestStatusBadge from './RequestStatusBadge.svelte';

	interface Props {
		/** Discover pages use 'tv'; the request API uses 'series'. */
		mediaType: 'movie' | 'tv';
		tmdbId: number;
		title: string;
		year?: number | null;
		posterPath?: string | null;
		onChange?: () => void;
	}

	let { mediaType, tmdbId, title, year, posterPath, onChange }: Props = $props();

	let showModal = $state(false);
	let ownRequests = $state<MediaRequest[]>([]);
	let loaded = $state(false);
	let cancelling = $state(false);

	const requestMediaType = $derived(mediaType === 'tv' ? 'series' : 'movie');

	// The live one wins; otherwise show the newest request so the user still
	// sees where theirs stands (declined/expired keep the request action).
	let activeRequest = $derived(
		ownRequests.find(
			(r) => r.status === 'pending' || r.status === 'approved' || r.status === 'awaiting_target'
		) ?? ownRequests.find((r) => r.status === 'failed')
	);
	let fulfilledRequest = $derived(ownRequests.find((r) => r.status === 'fulfilled'));

	async function load(media: 'movie' | 'series', id: number) {
		try {
			const all = await listRequests({ take: 100 });
			ownRequests = all.filter((r) => r.mediaType === media && r.tmdbId === id);
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
		const id = tmdbId;
		void load(media, id);
	});

	async function cancelPending() {
		if (!activeRequest) return;
		cancelling = true;
		try {
			await cancelRequest(activeRequest.id);
			toasts.info(m.requests_cancelled({ title }));
			await load(requestMediaType, tmdbId);
			onChange?.();
		} catch {
			toasts.error(m.requests_errorGeneric());
		} finally {
			cancelling = false;
		}
	}

	function handleSuccess() {
		void load(requestMediaType, tmdbId);
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
			<Clapperboard class="h-4 w-4" />
			{mediaType === 'tv' ? m.requests_requestSeries() : m.requests_requestMovie()}
		</button>
	{/if}
{/if}

<RequestModal
	open={showModal}
	{mediaType}
	{tmdbId}
	{title}
	{year}
	{posterPath}
	onClose={() => (showModal = false)}
	onSuccess={handleSuccess}
/>
