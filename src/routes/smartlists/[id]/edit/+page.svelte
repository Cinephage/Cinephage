<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type { PageData } from './$types';
	import SmartListEditor from '#lib/components/smartlists/SmartListEditor.svelte';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{m.smartlists_edit_pageTitle({ name: data.list.name })}</title>
</svelte:head>

<SmartListEditor
	list={data.list}
	rootFolders={data.rootFolders}
	scoringProfiles={data.scoringProfiles}
/>
