<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { PageData } from './$types';
	import SmartListEditor from '#lib/components/smartlists/SmartListEditor.svelte';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{m.smartlists_new_pageTitle()}</title>
</svelte:head>

<SmartListEditor rootFolders={data.rootFolders} scoringProfiles={data.scoringProfiles} />
