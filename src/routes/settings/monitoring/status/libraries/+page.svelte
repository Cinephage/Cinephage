<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import LibraryOverview from '#lib/components/storage/LibraryOverview.svelte';
	import { LibraryEditModal } from '#lib/components/libraries/index.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let libraryModalOpen = $state(false);
	let editingLibraryId = $state<string | null>(null);

	function openEditLibrary(libraryId: string) {
		editingLibraryId = libraryId;
		libraryModalOpen = true;
	}

	function closeLibraryModal() {
		libraryModalOpen = false;
		editingLibraryId = null;
	}
</script>

<svelte:head>
	<title>{m.status_libraries_title()}</title>
</svelte:head>

<SettingsPage
	title={m.status_libraries_title()}
	subtitle={m.status_libraries_subtitle()}
	backHref="/settings/monitoring/status"
	backLabel={m.nav_storageMaintenance()}
>
	<LibraryOverview libraries={data.storage.libraryBreakdown} onEditLibrary={openEditLibrary} />
</SettingsPage>

{#if libraryModalOpen}
	<LibraryEditModal
		open={libraryModalOpen}
		libraryId={editingLibraryId}
		libraries={data.libraries}
		rootFolders={data.rootFolders}
		onClose={closeLibraryModal}
	/>
{/if}
