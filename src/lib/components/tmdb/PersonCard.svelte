<script lang="ts">
	import type { CastMember, CrewMember } from '#lib/types/tmdb.js';
	import { isCastMember } from '#lib/types/tmdb-guards.js';
	import { resolvePath } from '#lib/utils/routing.js';
	import TmdbImage from './TmdbImage.svelte';

	let { person }: { person: CastMember | CrewMember } = $props();

	function getRole(person: CastMember | CrewMember): string {
		return isCastMember(person) ? person.character : person.job;
	}
</script>

<a
	href={resolvePath(`/discover/person/${person.id}`)}
	class="card w-32 shrink-0 bg-base-200 shadow-sm transition-all hover:shadow-md hover:ring-2 hover:ring-primary/50 sm:w-36 md:w-44"
>
	<figure class="aspect-[2/3] w-full overflow-hidden">
		{#if person.profile_path}
			<TmdbImage
				path={person.profile_path}
				size="w185"
				alt={person.name}
				class="h-full w-full object-cover transition-transform duration-500 hover:scale-105"
			/>
		{:else}
			<div class="flex h-full w-full items-center justify-center bg-base-300 text-base-content/30">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="h-12 w-12"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					><path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
					/></svg
				>
			</div>
		{/if}
	</figure>
	<div class="card-body p-3">
		<h3 class="line-clamp-1 text-sm font-bold" title={person.name}>{person.name}</h3>
		<p class="line-clamp-1 text-xs text-base-content/70" title={getRole(person)}>
			{getRole(person)}
		</p>
	</div>
</a>
