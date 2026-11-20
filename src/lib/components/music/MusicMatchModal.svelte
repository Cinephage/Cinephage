<script lang="ts">
	import { Check, Loader2, Replace, Search } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';

	interface ArtistHit {
		mbid: string;
		name: string;
		sortName?: string | null;
		disambiguation?: string | null;
		type?: string | null;
		country?: string | null;
	}

	interface AlbumHit {
		mbid: string;
		title: string;
		primaryType?: string | null;
		firstReleaseDate?: string | null;
		year?: number | null;
		artist?: { name?: string | null } | null;
	}

	interface Props {
		open: boolean;
		kind: 'artist' | 'album';
		mediaId: string;
		currentTitle: string;
		/** The album's artist, used to narrow a release-group search. */
		artistName?: string | null;
		onClose: () => void;
		onSuccess: () => void;
	}

	let {
		open,
		kind,
		mediaId,
		currentTitle,
		artistName = null,
		onClose,
		onSuccess
	}: Props = $props();

	let query = $state('');
	let results = $state<Array<ArtistHit | AlbumHit>>([]);
	let selected = $state<ArtistHit | AlbumHit | null>(null);
	let searching = $state(false);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let requestId = 0;

	$effect(() => {
		if (!open) return;
		query = currentTitle;
		results = [];
		selected = null;
		error = null;
		submitting = false;
	});

	$effect(() => {
		if (!open) return;
		const needle = query.trim();
		if (!needle) {
			results = [];
			searching = false;
			return;
		}
		const id = ++requestId;
		searching = true;
		const timer = setTimeout(async () => {
			const params = new URLSearchParams({ type: kind, q: needle });
			if (kind === 'album' && artistName) params.set('artist', artistName);
			try {
				const response = await fetch(`/api/music/search?${params.toString()}`);
				const body = (await response.json().catch(() => ({}))) as {
					results?: Array<ArtistHit | AlbumHit>;
					error?: string;
				};
				if (!response.ok) throw new Error(body.error ?? 'Search failed');
				if (id !== requestId) return;
				results = body.results ?? [];
			} catch (err) {
				if (id !== requestId) return;
				error = err instanceof Error ? err.message : 'Search failed';
				results = [];
			} finally {
				if (id === requestId) searching = false;
			}
		}, 350);
		return () => clearTimeout(timer);
	});

	function label(hit: ArtistHit | AlbumHit): string {
		return 'name' in hit ? hit.name : hit.title;
	}

	function detail(hit: ArtistHit | AlbumHit): string {
		if ('name' in hit) {
			return [hit.disambiguation, hit.type, hit.country].filter(Boolean).join(' · ');
		}
		return [hit.artist?.name, hit.primaryType, hit.firstReleaseDate ?? hit.year]
			.filter(Boolean)
			.join(' · ');
	}

	async function confirm() {
		if (!selected || submitting) return;
		submitting = true;
		error = null;
		try {
			const response = await fetch(
				`/api/music/${kind === 'artist' ? 'artists' : 'albums'}/${mediaId}/rematch`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ mbid: selected.mbid })
				}
			);
			const body = (await response.json().catch(() => ({}))) as {
				error?: string;
				albums?: number;
			};
			if (!response.ok) throw new Error(body.error ?? 'Could not change the match');

			toasts.success(
				kind === 'artist'
					? m.music_changeMatch_artistSuccess({ name: label(selected) })
					: m.music_changeMatch_albumSuccess({ title: label(selected) }),
				kind === 'artist' && body.albums
					? { description: m.music_changeMatch_albumsKept({ count: body.albums }) }
					: undefined
			);
			onSuccess();
			onClose();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not change the match';
		} finally {
			submitting = false;
		}
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="xl" labelledBy="music-match-modal-title">
	<div class="mb-4 flex items-center gap-2">
		<Replace class="h-5 w-5 text-primary" />
		<h3 id="music-match-modal-title" class="text-lg font-bold">
			{kind === 'artist' ? m.music_changeMatch_artistTitle() : m.music_changeMatch_albumTitle()}
		</h3>
	</div>

	<p class="mb-4 text-sm text-base-content/70">
		{kind === 'artist' ? m.music_changeMatch_artistWarning() : m.music_changeMatch_albumWarning()}
	</p>

	<label class="input-bordered input flex items-center gap-2">
		<Search class="h-4 w-4 text-base-content/50" />
		<input
			type="search"
			class="grow"
			value={query}
			oninput={(event) => (query = event.currentTarget.value)}
			placeholder={kind === 'artist'
				? m.music_changeMatch_artistPlaceholder()
				: m.music_changeMatch_albumPlaceholder()}
		/>
		{#if searching}<Loader2 class="h-4 w-4 animate-spin text-primary" />{/if}
	</label>

	{#if error}
		<div class="mt-3 alert py-2 text-sm alert-error">{error}</div>
	{/if}

	<div class="mt-3 max-h-80 space-y-1 overflow-y-auto">
		{#each results as hit (hit.mbid)}
			<button
				type="button"
				class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-base-200 {selected?.mbid ===
				hit.mbid
					? 'bg-primary/10 ring-1 ring-primary'
					: ''}"
				onclick={() => (selected = hit)}
			>
				<span class="min-w-0 flex-1">
					<span class="block truncate font-medium">{label(hit)}</span>
					<span class="block truncate text-xs text-base-content/60">{detail(hit)}</span>
				</span>
				{#if selected?.mbid === hit.mbid}
					<Check class="h-4 w-4 shrink-0 text-primary" />
				{/if}
			</button>
		{:else}
			{@render empty()}
		{/each}
	</div>

	<div class="mt-4 flex justify-end gap-2">
		<button type="button" class="btn btn-ghost btn-sm" onclick={onClose}>{m.action_cancel()}</button
		>
		<button
			type="button"
			class="btn btn-primary btn-sm"
			disabled={!selected || submitting}
			onclick={confirm}
		>
			{#if submitting}<Loader2 class="h-4 w-4 animate-spin" />{/if}
			{m.music_changeMatch_confirm()}
		</button>
	</div>
</ModalWrapper>

{#snippet empty()}
	<p class="py-8 text-center text-sm text-base-content/50">
		{searching
			? m.music_changeMatch_searching()
			: query.trim()
				? m.music_changeMatch_noResults()
				: m.music_changeMatch_prompt()}
	</p>
{/snippet}
