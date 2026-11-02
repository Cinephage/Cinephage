<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { PageData } from './$types';
	import MediaHero from '#lib/components/tmdb/MediaHero.svelte';
	import PersonCard from '#lib/components/tmdb/PersonCard.svelte';
	import SeasonList from '#lib/components/tmdb/SeasonList.svelte';
	import SectionRow from '#lib/components/discover/SectionRow.svelte';
	import { ArrowLeft } from '@lucide/svelte';

	let { data }: { data: PageData } = $props();

	// Only admins add content from Discover.
	const isAdminUser = $derived(data.user?.role === 'admin');

	function goBack(e: MouseEvent) {
		e.preventDefault();
		if (window.history.length > 1) window.history.back();
		else window.location.href = '/discover';
	}
</script>

<svelte:head>
	<title>{m.discover_tv_pageTitle({ name: data.tv.name })}</title>
</svelte:head>

{#if data.hasBlockedKeywords}
	<div class="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
		<h1 class="text-3xl font-bold">{data.tv.name}</h1>
		<p class="mt-4 text-base-content/70">
			This content matches keywords you have blocked. It has been hidden from view.
		</p>
		{#if data.blockedKeywords.length > 0}
			<div class="mt-3 flex flex-wrap justify-center gap-1.5">
				{#each data.blockedKeywords as keyword (keyword)}
					<span class="badge badge-outline badge-sm badge-error">{keyword}</span>
				{/each}
			</div>
		{/if}
		<div class="mt-6 flex gap-4">
			<a href="/settings/blocklist/blocked-keywords" class="btn btn-outline btn-sm">
				Manage blocked keywords
			</a>
			<a href="/discover" class="btn btn-primary btn-sm"> Back to discover </a>
		</div>
	</div>
{:else}
	<div class="flex w-full flex-col gap-12 px-4 pb-20 lg:px-8">
		<!-- Hero Section -->
		<div class="flex flex-col gap-3">
			<a href="/discover" onclick={goBack} class="btn -ml-2 w-fit gap-1.5 btn-ghost btn-sm">
				<ArrowLeft class="h-4 w-4" />
				{m.action_back()}
			</a>
			<MediaHero item={data.tv} readOnly={!isAdminUser} requestState={data.requestState} />
		</div>

		<!-- Cast Section -->
		{#if data.tv.credits.cast.length > 0}
			<SectionRow
				title={m.discover_tv_topCast()}
				items={data.tv.credits.cast.slice(0, 15)}
				itemClass="w-[30vw] sm:w-36 md:w-44"
			>
				{#snippet cardSnippet(person)}
					<PersonCard {person} />
				{/snippet}
			</SectionRow>
		{/if}

		<!-- Seasons Section -->
		{#if data.tv.seasons.length > 0}
			<section>
				<h2 class="mb-6 text-2xl font-bold">{m.discover_tv_seasons()}</h2>
				<SeasonList seasons={data.tv.seasons} />
			</section>
		{/if}

		<!-- Recommendations -->
		{#if data.tv.recommendations.results.length > 0}
			<SectionRow
				title={m.discover_tv_recommendations()}
				items={data.tv.recommendations.results}
				endpoint={`tv/${data.tv.id}/recommendations`}
			/>
		{/if}

		<!-- Similar -->
		{#if data.tv.similar.results.length > 0}
			<SectionRow
				title={m.discover_tv_similarTitles()}
				items={data.tv.similar.results}
				endpoint={`tv/${data.tv.id}/similar`}
			/>
		{/if}
	</div>
{/if}
