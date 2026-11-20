<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Disc3, Search, X } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();

	let ignoredIds = $state<string[]>([]);
	const issues = $derived(data.issues.filter((issue) => !ignoredIds.includes(issue.id)));
	let ignoring = $state<string | null>(null);

	async function ignore(id: string) {
		ignoring = id;
		try {
			const response = await fetch(`/api/music/scan-issues/${id}`, { method: 'DELETE' });
			if (response.ok) ignoredIds = [...ignoredIds, id];
		} finally {
			ignoring = null;
		}
	}
</script>

<svelte:head>
	<title>{m.music_scanIssuesTitle()} - Cinephage</title>
</svelte:head>

<div class="mx-auto max-w-4xl space-y-6 p-4 lg:p-8">
	<div class="flex items-center gap-3">
		<div class="rounded-lg bg-warning/10 p-2">
			<Disc3 class="h-6 w-6 text-warning" />
		</div>
		<div>
			<h1 class="text-2xl font-bold">{m.music_scanIssuesTitle()}</h1>
			<p class="text-sm text-base-content/60">{m.music_scanIssuesHint()}</p>
		</div>
	</div>

	{#if issues.length === 0}
		<div class="card bg-base-200">
			<div class="card-body items-center py-12 text-center">
				<Disc3 class="h-12 w-12 text-base-content/20" />
				<p class="text-base-content/60">{m.music_scanIssuesEmpty()}</p>
				<a href={resolve('library/music')} class="btn btn-ghost btn-sm">
					{m.nav_music()}
				</a>
			</div>
		</div>
	{:else}
		<div class="space-y-3">
			{#each issues as issue (issue.id)}
				<div class="card bg-base-200">
					<div class="card-body gap-3 p-4">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div class="min-w-0">
								<p class="truncate font-mono text-sm" title={issue.folder}>{issue.folder}</p>
								<p class="mt-1 text-sm text-base-content/70">
									{issue.artistName ?? '—'} · {issue.albumTitle ?? '—'}
								</p>
								<p class="mt-1 text-xs text-warning">{issue.reason}</p>
							</div>
							<div class="flex shrink-0 gap-2">
								<a
									class="btn gap-1.5 btn-ghost btn-sm"
									href="{resolve('library/music')}?q={encodeURIComponent(
										[issue.artistName, issue.albumTitle].filter(Boolean).join(' ')
									)}"
								>
									<Search class="h-3.5 w-3.5" />
									{m.music_scanIssuesSearch()}
								</a>
								<button
									class="btn gap-1.5 btn-ghost btn-sm"
									disabled={ignoring === issue.id}
									onclick={() => ignore(issue.id)}
								>
									<X class="h-3.5 w-3.5" />
									{m.music_scanIssuesIgnore()}
								</button>
							</div>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
