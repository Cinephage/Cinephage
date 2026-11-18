<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ArrowLeft, ExternalLink, Eye, EyeOff, Globe, Mic2 } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { resolvePath } from '#lib/utils/routing.js';

	type Props = {
		artist: {
			id: string;
			name: string;
			mbid?: string | null;
			disambiguation?: string | null;
			type?: string | null;
			country?: string | null;
			genres?: string[] | null;
			monitored?: boolean | null;
			added?: string | null;
		};
		/** Art for the portrait and backdrop — the artist's first album cover. */
		backdropUrl?: string | null;
		albumCount: number;
		inLibraryCount: number;
		songCount?: number;
		/** Collaborators credited across the discography, most frequent first. */
		featured?: string[];
		backHref?: string | null;
		backLabel?: string;
		sourceUrl?: string | null;
		actions?: Snippet;
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
		actions
	}: Props = $props();

	const initials = $derived(
		artist.name
			.split(/\s+/)
			.slice(0, 2)
			.map((part) => part.charAt(0).toUpperCase())
			.join('')
	);
	const missing = $derived(Math.max(0, albumCount - inLibraryCount));

	function bubbleInitials(name: string): string {
		return name
			.split(/\s+/)
			.slice(0, 2)
			.map((part) => part.charAt(0).toUpperCase())
			.join('');
	}
</script>

<div class="relative w-full overflow-hidden rounded-xl bg-base-200 shadow-xl">
	<!-- Backdrop: the artist's own art, dimmed the way a series backdrop is. -->
	<div class="absolute inset-0 h-full w-full">
		{#if backdropUrl}
			<img
				src={backdropUrl}
				alt=""
				aria-hidden="true"
				class="h-full w-full scale-110 object-cover opacity-25 blur-2xl"
			/>
		{/if}
		<div class="absolute inset-0 bg-linear-to-t from-base-200 via-base-200/70 to-base-200/30"></div>
		<div class="absolute inset-0 bg-linear-to-r from-base-200 via-base-200/50 to-transparent"></div>
	</div>

	<div class="relative z-10">
		<div class="flex flex-col gap-6 p-5 sm:p-6 md:flex-row md:p-8">
			<!-- Portrait sits in the poster slot of a series hero. -->
			<div class="flex shrink-0 flex-col gap-2">
				<div
					class="h-36 w-36 overflow-hidden rounded-full border border-white/10 shadow-lg sm:h-44 sm:w-44 md:h-52 md:w-52"
				>
					{#if backdropUrl}
						<img src={backdropUrl} alt={artist.name} class="h-full w-full object-cover" />
					{:else}
						<div class="flex h-full w-full items-center justify-center bg-base-300">
							{#if initials}
								<span class="text-4xl font-bold text-base-content/40">{initials}</span>
							{:else}
								<Mic2 class="h-12 w-12 text-base-content/25" />
							{/if}
						</div>
					{/if}
				</div>
			</div>

			<div class="flex min-w-0 flex-1 flex-col">
				{#if backHref}
					<a
						class="mb-2 inline-flex items-center gap-1.5 text-xs font-medium text-base-content/45 transition-colors hover:text-base-content/80"
						href={resolvePath(backHref)}
					>
						<ArrowLeft class="h-3.5 w-3.5" />
						{backLabel}
					</a>
				{/if}

				<div class="flex flex-wrap items-center gap-2">
					<h1 class="text-2xl leading-tight font-bold tracking-tight sm:text-3xl">{artist.name}</h1>
					{#if artist.monitored !== undefined && artist.monitored !== null}
						<span
							class="badge gap-1 badge-sm border-none {artist.monitored
								? 'bg-success/15 text-success'
								: 'bg-base-content/10 text-base-content/50'}"
						>
							{#if artist.monitored}
								<Eye class="h-3 w-3" />{m.common_monitored()}
							{:else}
								<EyeOff class="h-3 w-3" />{m.common_unmonitored()}
							{/if}
						</span>
					{/if}
				</div>

				{#if artist.disambiguation}
					<p class="mt-1 text-sm italic text-base-content/55">{artist.disambiguation}</p>
				{/if}

				<div class="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
					{#if artist.type}
						<span class="badge badge-sm border-base-content/15 bg-base-100/60">{artist.type}</span>
					{/if}
					{#if artist.country}
						<span class="badge badge-sm gap-1 border-base-content/15 bg-base-100/60">
							<Globe class="h-3 w-3" />{artist.country}
						</span>
					{/if}
					{#each (artist.genres ?? []).slice(0, 4) as genre (genre)}
						<span class="badge badge-sm border-base-content/15 bg-base-100/60 capitalize">{genre}</span>
					{/each}
				</div>

				<!-- The series page's "8 / 24 episodes" line, in albums and songs. -->
				<p class="mt-3 text-sm text-base-content/70">
					<span class="font-medium">{inLibraryCount} / {albumCount}</span>
					{m.music_tabAlbums().toLowerCase()}
					{#if songCount > 0}
						<span class="text-base-content/30">·</span>
						{m.music_songsCount({ count: songCount })}
					{/if}
					{#if missing > 0}
						<span class="text-base-content/30">·</span>
						<span class="text-warning">{m.music_missingCount({ count: missing })}</span>
					{/if}
				</p>

				<!-- Collaborators get the cast-row treatment: round bubbles, names under. -->
				{#if featured.length > 0}
					<div class="mt-3">
						<div class="mb-2 text-sm text-base-content/60">{m.music_featuredArtists()}</div>
						<div class="flex gap-3 overflow-x-auto pb-1">
							{#each featured as name (name)}
								<div class="flex w-16 shrink-0 flex-col items-center gap-1.5">
									<div
										class="flex h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-base-300 text-base font-semibold text-base-content/45"
										title={name}
									>
										{bubbleInitials(name)}
									</div>
									<div class="text-center">
										<div class="line-clamp-2 text-xs leading-tight font-medium">{name}</div>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<div class="mt-4 flex flex-wrap items-center gap-2">
					{@render actions?.()}
					{#if sourceUrl}
						<a
							class="btn gap-1.5 btn-ghost btn-xs text-base-content/50 hover:text-base-content"
							href={sourceUrl}
							target="_blank"
							rel="noreferrer"
						>
							<ExternalLink class="h-3.5 w-3.5" />
							MusicBrainz
						</a>
					{/if}
				</div>
			</div>

			<!-- Right side metadata panel, the same slot the series hero uses. -->
			<aside
				class="hidden w-56 shrink-0 rounded-lg bg-base-100/30 p-4 backdrop-blur-sm md:block lg:w-64 lg:p-5"
			>
				<dl class="space-y-3 text-sm">
					{#if artist.type}
						<div>
							<dt class="text-xs text-base-content/50">{m.common_type()}</dt>
							<dd class="font-medium">{artist.type}</dd>
						</div>
					{/if}
					{#if artist.country}
						<div>
							<dt class="text-xs text-base-content/50">{m.music_country()}</dt>
							<dd class="font-medium">{artist.country}</dd>
						</div>
					{/if}
					{#if artist.added}
						<div>
							<dt class="text-xs text-base-content/50">{m.common_added()}</dt>
							<dd class="font-medium">{new Date(artist.added).toLocaleDateString()}</dd>
						</div>
					{/if}
					{#if (artist.genres ?? []).length > 0}
						<div>
							<dt class="text-xs text-base-content/50">{m.common_genres()}</dt>
							<dd class="font-medium capitalize">{(artist.genres ?? []).slice(0, 4).join(', ')}</dd>
						</div>
					{/if}
					<div>
						<dt class="text-xs text-base-content/50">{m.music_tabAlbums()}</dt>
						<dd class="font-medium">{albumCount}</dd>
					</div>
					{#if songCount > 0}
						<div>
							<dt class="text-xs text-base-content/50">{m.music_tabSongs()}</dt>
							<dd class="font-medium">{songCount}</dd>
						</div>
					{/if}
				</dl>
			</aside>
		</div>
	</div>
</div>
