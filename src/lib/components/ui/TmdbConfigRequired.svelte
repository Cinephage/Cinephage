<script lang="ts">
	import { AlertCircle, Settings } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	let { message = m.ui_tmdbRequired_description() }: { message?: string } = $props();
</script>

<div class="alert alert-warning shadow-lg" role="alert">
	<AlertCircle class="h-6 w-6 shrink-0" />
	<div>
		<h3 class="font-bold">{m.ui_tmdbRequired_title()}</h3>
		<p class="text-sm">{message}</p>
	</div>
	<a href="/settings/system/metadata-providers?open=tmdb" class="btn gap-2 btn-primary btn-sm">
		<Settings class="h-4 w-4" />
		{m.ui_tmdbRequired_configureTmdb()}
	</a>
</div>
