<script lang="ts">
	import type { ScoringProfile } from '#lib/types/profile.js';
	import ProfileTable from './ProfileTable.svelte';
	import { Plus } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		profiles: ScoringProfile[];
		onAdd?: () => void;
		onEdit?: (profile: ScoringProfile) => void;
		onDelete?: (profile: ScoringProfile) => void;
		onSetDefault?: (profile: ScoringProfile) => void;
	}

	let { profiles, onAdd, onEdit, onDelete, onSetDefault }: Props = $props();

	// Sort profiles: built-in first (sorted by name), then custom (sorted by name)
	const sortedProfiles = $derived(() => {
		const builtIn = profiles
			.filter((p) => p.isBuiltIn)
			.sort((a, b) => a.name.localeCompare(b.name));
		const custom = profiles
			.filter((p) => !p.isBuiltIn)
			.sort((a, b) => a.name.localeCompare(b.name));
		return [...builtIn, ...custom];
	});
</script>

<div class="space-y-4">
	<div class="flex items-center justify-end">
		{#if onAdd}
			<button class="btn w-full gap-2 btn-primary btn-sm sm:w-auto" onclick={onAdd}>
				<Plus class="h-4 w-4" />
				{m.profiles_addProfile()}
			</button>
		{/if}
	</div>

	<div class="card bg-transparent shadow-none sm:bg-base-100 sm:shadow-xl">
		<div class="card-body p-0">
			<ProfileTable
				profiles={sortedProfiles()}
				onEdit={onEdit ?? (() => {})}
				onDelete={onDelete ?? (() => {})}
				onSetDefault={onSetDefault ?? (() => {})}
			/>
		</div>
	</div>
</div>
