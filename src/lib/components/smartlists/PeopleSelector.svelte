<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Loader2, X } from '@lucide/svelte';
	import { getSmartListHelpers } from '#lib/api/smartlists.js';

	interface PersonResult {
		id: number;
		name: string;
		profile_path: string | null;
	}

	interface SelectedPerson {
		id: number;
		name: string;
		type: 'cast' | 'crew';
	}

	interface Props {
		selectedPeople: SelectedPerson[];
		onAddPerson: (person: PersonResult, type: 'cast' | 'crew') => void;
		onRemovePerson: (personId: number, type: 'cast' | 'crew') => void;
	}

	let { selectedPeople, onAddPerson, onRemovePerson }: Props = $props();

	let query = $state('');
	let results = $state<PersonResult[]>([]);
	let searching = $state(false);
	let searchTimer: ReturnType<typeof setTimeout>;

	async function searchPeople() {
		if (query.length < 2) {
			results = [];
			return;
		}
		searching = true;
		try {
			const res = await getSmartListHelpers({ helper: 'people', q: query });
			results = Array.isArray(res) ? res : [];
		} finally {
			searching = false;
		}
	}

	function handleInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(searchPeople, 300);
	}

	function addPerson(person: PersonResult, type: 'cast' | 'crew') {
		onAddPerson(person, type);
		query = '';
		results = [];
	}
</script>

<div class="form-control">
	<div class="label py-1">
		<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase">
			{m.smartlists_filter_castCrew()}
		</span>
	</div>
	<div class="relative">
		<input
			type="text"
			bind:value={query}
			oninput={handleInput}
			placeholder={m.smartlists_filter_castCrewPlaceholder()}
			class="input-bordered input w-full input-sm"
		/>
		{#if searching}
			<Loader2 class="absolute top-2 right-3 h-4 w-4 animate-spin" />
		{/if}
	</div>
	{#if results.length > 0}
		<div class="mt-1 max-h-40 overflow-y-auto rounded-lg border border-base-300 bg-base-100">
			{#each results as person (person.id)}
				<div class="flex items-center justify-between border-b border-base-200 p-2 last:border-0">
					<div class="flex items-center gap-2">
						{#if person.profile_path}
							<img
								src="https://image.tmdb.org/t/p/w45{person.profile_path}"
								alt={person.name}
								class="h-8 w-8 rounded-full object-cover"
							/>
						{:else}
							<div class="flex h-8 w-8 items-center justify-center rounded-full bg-base-300">
								<span class="text-xs">{person.name.charAt(0)}</span>
							</div>
						{/if}
						<span class="text-sm">{person.name}</span>
					</div>
					<div class="flex gap-1">
						<button
							type="button"
							class="btn btn-primary btn-xs"
							onclick={() => addPerson(person, 'cast')}
						>
							{m.smartlists_filter_cast()}
						</button>
						<button
							type="button"
							class="btn btn-secondary btn-xs"
							onclick={() => addPerson(person, 'crew')}
						>
							{m.smartlists_filter_crew()}
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
	{#if selectedPeople.length > 0}
		<div class="mt-2 flex flex-wrap gap-1">
			{#each selectedPeople as person (person.id + '-' + person.type)}
				<span class="badge {person.type === 'cast' ? 'badge-primary' : 'badge-secondary'} gap-1">
					{person.name}
					<button type="button" onclick={() => onRemovePerson(person.id, person.type)}>
						<X class="h-3 w-3" />
					</button>
				</span>
			{/each}
		</div>
	{/if}
</div>
