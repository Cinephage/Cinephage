<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Plus, Search } from '@lucide/svelte';
	import { resolve } from '$app/paths';
</script>

<div class="card bg-base-200">
	<div class="card-body items-center text-center">
		<div class="rounded-full bg-base-300 p-4">
			<Plus class="h-8 w-8 text-base-content/50" />
		</div>
		<h2 class="card-title">{m.dashboard_emptyState_title()}</h2>
		<p class="text-base-content/70">{m.dashboard_emptyState_description()}</p>

		<a href={resolve('discover')} class="btn btn-primary">
			<Search class="h-4 w-4" />
			{m.dashboard_emptyState_discoverContent()}
		</a>
	</div>
</div>
