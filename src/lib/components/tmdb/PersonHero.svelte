<script lang="ts">
	import type { PersonDetails } from '#lib/types/tmdb.js';
	import TmdbImage from './TmdbImage.svelte';
	import { ExternalLink, Briefcase } from '@lucide/svelte';
	import { formatDisplayDate } from '#lib/utils/format.js';
	import * as m from '#lib/paraglide/messages.js';

	// Accept PersonDetails with or without combined_credits (for optimized loading)
	// The combined_credits field is intentionally optional as this component works with both variants
	type PersonBasic = Omit<PersonDetails, 'combined_credits'>;

	let { person }: { person: PersonBasic } = $props();

	// Calculate age (or age at death)
	const age = $derived.by(() => {
		if (!person.birthday) return null;
		const birth = new Date(person.birthday);
		const end = person.deathday ? new Date(person.deathday) : new Date();
		let years = end.getFullYear() - birth.getFullYear();
		const m = end.getMonth() - birth.getMonth();
		if (m < 0 || (m === 0 && end.getDate() < birth.getDate())) {
			years--;
		}
		return years;
	});

	// Gender display
	const genderLabel = $derived(
		person.gender === 1
			? m.person_gender_female()
			: person.gender === 2
				? m.person_gender_male()
				: person.gender === 3
					? m.person_gender_nonBinary()
					: null
	);
</script>

<div class="relative w-full overflow-hidden rounded-xl bg-base-200 shadow-xl">
	<!-- Backdrop using profile image with blur -->
	<div class="absolute inset-0 h-full w-full">
		{#if person.profile_path}
			<TmdbImage
				path={person.profile_path}
				size="w780"
				alt={person.name}
				class="h-full w-full object-cover opacity-20 blur-xl"
			/>
		{/if}
		<div
			class="absolute inset-0 bg-gradient-to-t from-base-200 via-base-200/80 to-transparent"
		></div>
		<div
			class="absolute inset-0 bg-gradient-to-r from-base-200 via-base-200/60 to-transparent"
		></div>
	</div>

	<!-- Content -->
	<div class="relative z-10 flex flex-col gap-6 p-6 md:flex-row md:p-8">
		<!-- Profile Photo -->
		<div class="shrink-0">
			<div class="w-28 overflow-hidden rounded-lg shadow-lg sm:w-40 md:w-48">
				{#if person.profile_path}
					<TmdbImage
						path={person.profile_path}
						size="w342"
						alt={person.name}
						class="h-auto w-full object-cover"
					/>
				{:else}
					<div
						class="flex aspect-[2/3] w-full items-center justify-center bg-base-300 text-base-content/30"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							class="h-16 w-16"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
							/>
						</svg>
					</div>
				{/if}
			</div>
		</div>

		<!-- Main Info -->
		<div class="flex min-w-0 flex-1 flex-col gap-4">
			<div>
				<h1 class="text-2xl font-bold md:text-3xl">{person.name}</h1>

				<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-base-content/70">
					{#if person.known_for_department}
						<span class="flex items-center gap-1">
							<Briefcase class="h-4 w-4" />
							{person.known_for_department}
						</span>
					{/if}
				</div>
			</div>

			<!-- Biography -->
			{#if person.biography}
				<div class="max-h-48 overflow-y-auto">
					<p class="text-base leading-relaxed whitespace-pre-line text-base-content/90">
						{person.biography}
					</p>
				</div>
			{:else}
				<p class="text-base-content/50 italic">{m.person_noBiography()}</p>
			{/if}

			<!-- External links -->
			<div class="mt-auto flex flex-wrap items-center gap-2">
				<a
					href={`https://www.themoviedb.org/person/${person.id}`}
					target="_blank"
					rel="noopener noreferrer"
					class="btn gap-1 btn-ghost btn-xs"
				>
					{m.tmdb_link_tmdb()}
					<ExternalLink size={12} />
				</a>
				{#if person.external_ids?.imdb_id}
					<a
						href={`https://www.imdb.com/name/${person.external_ids.imdb_id}`}
						target="_blank"
						rel="noopener noreferrer"
						class="btn gap-1 btn-ghost btn-xs"
					>
						{m.tmdb_link_imdb()}
						<ExternalLink size={12} />
					</a>
				{/if}
				{#if person.external_ids?.instagram_id}
					<a
						href={`https://www.instagram.com/${person.external_ids.instagram_id}`}
						target="_blank"
						rel="noopener noreferrer"
						class="btn gap-1 btn-ghost btn-xs"
					>
						{m.tmdb_link_instagram()}
						<ExternalLink size={12} />
					</a>
				{/if}
				{#if person.external_ids?.twitter_id}
					<a
						href={`https://twitter.com/${person.external_ids.twitter_id}`}
						target="_blank"
						rel="noopener noreferrer"
						class="btn gap-1 btn-ghost btn-xs"
					>
						{m.tmdb_link_x()}
						<ExternalLink size={12} />
					</a>
				{/if}
				{#if person.homepage}
					<!-- eslint-disable svelte/no-navigation-without-resolve -- External URL -->
					<a
						href={person.homepage}
						target="_blank"
						rel="noopener noreferrer"
						class="btn gap-1 btn-ghost btn-xs"
					>
						{m.tmdb_link_website()}
						<ExternalLink size={12} />
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{/if}
			</div>
		</div>

		<!-- Right side metadata -->
		<div class="hidden w-64 shrink-0 rounded-lg bg-base-100/30 p-5 backdrop-blur-sm lg:block">
			<div class="grid gap-y-3">
				{#if person.birthday}
					<div>
						<div class="text-sm text-base-content/50">{m.person_born()}</div>
						<div class="font-medium">{formatDisplayDate(person.birthday)}</div>
						{#if age && !person.deathday}
							<div class="text-sm text-base-content/60">{m.person_ageYears({ age })}</div>
						{/if}
					</div>
				{/if}

				{#if person.deathday}
					<div>
						<div class="text-sm text-base-content/50">{m.person_died()}</div>
						<div class="font-medium">{formatDisplayDate(person.deathday)}</div>
						{#if age}
							<div class="text-sm text-base-content/60">{m.person_ageAtDeath({ age })}</div>
						{/if}
					</div>
				{/if}

				{#if person.place_of_birth}
					<div>
						<div class="text-sm text-base-content/50">{m.person_birthplace()}</div>
						<div class="font-medium">{person.place_of_birth}</div>
					</div>
				{/if}

				{#if genderLabel}
					<div>
						<div class="text-sm text-base-content/50">{m.person_gender()}</div>
						<div class="font-medium">{genderLabel}</div>
					</div>
				{/if}

				{#if person.also_known_as && person.also_known_as.length > 0}
					<div>
						<div class="text-sm text-base-content/50">{m.person_alsoKnownAs()}</div>
						<div class="text-sm">{person.also_known_as.slice(0, 3).join(', ')}</div>
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>
