<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Loader2 } from '@lucide/svelte';

	interface Genre {
		id: number;
		name: string;
	}

	interface Props {
		genres: Genre[];
		withGenres: number[];
		withoutGenres: number[];
		genreMode: 'and' | 'or';
		loading: boolean;
		onToggleGenre: (genreId: number, include: boolean) => void;
		onGenreModeChange: (mode: 'and' | 'or') => void;
	}

	let {
		genres,
		withGenres,
		withoutGenres,
		genreMode,
		loading,
		onToggleGenre,
		onGenreModeChange
	}: Props = $props();

	function isIncluded(genreId: number): boolean {
		return withGenres.includes(genreId);
	}

	function isExcluded(genreId: number): boolean {
		return withoutGenres.includes(genreId);
	}
</script>

<div class="form-control">
	<div class="label py-1">
		<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
			>{m.smartlists_filter_includeGenres()}</span
		>
		{#if withGenres.length}
			<span class="badge badge-sm badge-primary">{withGenres.length}</span>
		{/if}
	</div>
	{#if loading}
		<div class="flex items-center gap-2 py-2">
			<Loader2 class="h-4 w-4 animate-spin" />
			<span class="text-sm text-base-content/60">{m.smartlists_filter_loading()}</span>
		</div>
	{:else}
		<div class="flex flex-wrap gap-1.5">
			{#each genres as genre (genre.id)}
				<button
					type="button"
					class="badge cursor-pointer transition-all {isIncluded(genre.id)
						? 'badge-primary'
						: 'hover:badge-primary/30 badge-ghost'}"
					onclick={() => onToggleGenre(genre.id, true)}
				>
					{genre.name}
				</button>
			{/each}
		</div>
	{/if}
</div>

<div class="form-control">
	<div class="label py-1">
		<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
			>{m.smartlists_filter_excludeGenres()}</span
		>
		{#if withoutGenres.length}
			<span class="badge badge-sm badge-error">{withoutGenres.length}</span>
		{/if}
	</div>
	<div class="flex flex-wrap gap-1.5">
		{#each genres as genre (genre.id)}
			<button
				type="button"
				class="badge cursor-pointer transition-all {isExcluded(genre.id)
					? 'badge-error'
					: 'hover:badge-error/30 badge-ghost'}"
				onclick={() => onToggleGenre(genre.id, false)}
			>
				{genre.name}
			</button>
		{/each}
	</div>
</div>

{#if withGenres.length > 1}
	<div class="form-control">
		<div class="label py-1">
			<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
				>{m.smartlists_filter_genreMatchMode()}</span
			>
		</div>
		<div class="flex gap-4">
			<label class="label cursor-pointer gap-2">
				<input
					type="radio"
					name="genreMode"
					class="radio radio-sm"
					value="or"
					checked={genreMode !== 'and'}
					onchange={() => onGenreModeChange('or')}
				/>
				<span class="text-sm">{m.smartlists_filter_matchAny()}</span>
			</label>
			<label class="label cursor-pointer gap-2">
				<input
					type="radio"
					name="genreMode"
					class="radio radio-sm"
					value="and"
					checked={genreMode === 'and'}
					onchange={() => onGenreModeChange('and')}
				/>
				<span class="text-sm">{m.smartlists_filter_matchAll()}</span>
			</label>
		</div>
	</div>
{/if}
