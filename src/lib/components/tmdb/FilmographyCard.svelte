<script lang="ts">
	import type { PersonCastCredit, PersonCrewCredit } from '#lib/types/tmdb.js';
	import TmdbImage from './TmdbImage.svelte';
	import { resolvePath } from '#lib/utils/routing.js';
	import { Check, Clock } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	// Extended type that includes library status (added by enrichWithLibraryStatus)
	type CreditWithLibraryStatus = (PersonCastCredit | PersonCrewCredit) & {
		inLibrary?: boolean;
		hasFile?: boolean;
		libraryId?: string;
	};

	interface Props {
		credit: CreditWithLibraryStatus;
		showRole?: boolean;
	}

	let { credit, showRole = false }: Props = $props();

	// Library status
	const inLibrary = $derived(credit.inLibrary ?? false);
	const hasFile = $derived(credit.hasFile ?? false);

	// Determine the title and link
	const title = $derived(credit.title || credit.name || 'Unknown');
	const link = $derived(
		credit.media_type === 'movie' ? `/discover/movie/${credit.id}` : `/discover/tv/${credit.id}`
	);
	const date = $derived(credit.release_date || credit.first_air_date || '');
	const year = $derived(date ? new Date(date).getFullYear() : null);

	// Role info - check if it's a cast credit (has character) or crew credit (has job)
	const isCastCredit = $derived('character' in credit);
	const role = $derived(
		isCastCredit ? (credit as PersonCastCredit).character : (credit as PersonCrewCredit).job
	);

	const ratingColor = (rating: number): string => {
		if (rating >= 7) return 'text-success';
		if (rating >= 5) return 'text-warning';
		return 'text-error';
	};
</script>

<a
	href={resolvePath(link)}
	class="group relative block aspect-[2/3] w-full overflow-hidden rounded-lg bg-base-300 shadow-sm transition-all hover:shadow-md hover:ring-2 hover:ring-primary/50"
>
	<TmdbImage
		path={credit.poster_path}
		size="w342"
		alt={title}
		class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
	/>

	<!-- Library Status Badge (top-left) -->
	{#if inLibrary}
		<div class="absolute top-2 left-2 z-10">
			{#if hasFile}
				<!-- Available: Green checkmark -->
				<div
					class="flex h-6 w-6 items-center justify-center rounded-full bg-success/90 text-success-content shadow-md backdrop-blur-sm"
					title={m.tmdb_availableInLibrary()}
				>
					<Check class="h-4 w-4" strokeWidth={3} />
				</div>
			{:else}
				<!-- Monitored but missing: Yellow clock -->
				<div
					class="flex h-6 w-6 items-center justify-center rounded-full bg-warning/90 text-warning-content shadow-md backdrop-blur-sm"
					title={m.tmdb_monitoredNotDownloaded()}
				>
					<Clock class="h-4 w-4" strokeWidth={2.5} />
				</div>
			{/if}
		</div>
	{/if}

	<!-- Media Type Badge -->
	<div class="absolute top-2 right-2 z-10">
		<span
			class="badge border-none badge-sm font-semibold shadow-sm backdrop-blur-sm {credit.media_type ===
			'movie'
				? 'bg-primary/80 text-primary-content'
				: 'bg-secondary/80 text-secondary-content'}"
		>
			{credit.media_type === 'movie' ? m.ui_mediaType_movie() : m.ui_mediaType_tv()}
		</span>
	</div>

	<!-- Hover Overlay -->
	<div
		class="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/90 via-black/20 to-transparent p-3 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
	>
		<div
			class="translate-y-4 transform transition-transform duration-300 group-hover:translate-y-0"
		>
			<h3 class="line-clamp-2 text-sm leading-tight font-bold text-white">{title}</h3>
			{#if role}
				<p class="mt-1 line-clamp-1 text-xs text-white/70">
					{#if showRole && !isCastCredit}
						{role}
					{:else if role}
						{m.tmdb_filmographyCard_asRole({ role })}
					{/if}
				</p>
			{/if}
			<div class="mt-1 flex items-center justify-between">
				{#if year}
					<span class="text-xs text-white/70">{year}</span>
				{/if}
				{#if credit.vote_average}
					<div
						class="flex items-center gap-1 text-xs font-medium {ratingColor(credit.vote_average)}"
					>
						<span>★</span>
						<span>{credit.vote_average.toFixed(1)}</span>
					</div>
				{/if}
			</div>
		</div>
	</div>
</a>
