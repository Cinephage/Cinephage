<script lang="ts">
	import type { CrewMember, Creator } from '#lib/types/tmdb.js';
	import * as m from '#lib/paraglide/messages.js';

	let {
		crew = [],
		creators = [],
		showJobs = ['Director', 'Writer', 'Screenplay', 'Story']
	}: {
		crew?: CrewMember[];
		creators?: Creator[];
		showJobs?: string[];
	} = $props();

	// Group crew by job, limit to 2 per role
	const groupedCrew = $derived.by(() => {
		const groups: Record<string, CrewMember[]> = {};
		for (const member of crew) {
			if (showJobs.includes(member.job)) {
				const jobLabel =
					member.job === 'Screenplay' || member.job === 'Story' ? 'Writer' : member.job;
				if (!groups[jobLabel]) groups[jobLabel] = [];
				// Avoid duplicates (same person with multiple credits)
				if (groups[jobLabel].length < 3 && !groups[jobLabel].some((m) => m.id === member.id)) {
					groups[jobLabel].push(member);
				}
			}
		}
		return groups;
	});

	const hasContent = $derived(creators.length > 0 || Object.keys(groupedCrew).length > 0);
</script>

{#if hasContent}
	<div class="flex flex-wrap gap-x-6 gap-y-2 text-sm">
		{#if creators.length > 0}
			<div class="flex items-center gap-2">
				<span class="text-base-content/60">{m.tmdb_crewList_createdBy()}</span>
				<span class="font-medium text-base-content">
					{creators.map((c) => c.name).join(', ')}
				</span>
			</div>
		{/if}

		{#each Object.entries(groupedCrew) as [job, members] (job)}
			<div class="flex items-center gap-2">
				<span class="text-base-content/60">{job}</span>
				<span class="font-medium text-base-content">
					{members.map((m) => m.name).join(', ')}
				</span>
			</div>
		{/each}
	</div>
{/if}
