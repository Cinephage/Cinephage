<script lang="ts">
	import {
		Library,
		FolderOpen,
		FileSignature,
		Shield,
		Filter,
		FolderSync,
		Languages
	} from '@lucide/svelte';
	import { SettingsTabNav } from '#lib/components/settings/index.js';
	import * as m from '#lib/paraglide/messages.js';

	let { children } = $props();

	const navItems = [
		{
			href: '/settings/library/libraries',
			label: m.settings_library_tabLibraries(),
			icon: Library
		},
		{
			href: '/settings/library/root-folders',
			label: m.settings_library_tabRootFolders(),
			icon: FolderOpen
		},
		{
			href: '/settings/library/file-management',
			label: m.settings_library_tabFileManagement(),
			icon: FolderSync
		},
		{
			href: '/settings/library/naming',
			label: m.nav_naming(),
			icon: FileSignature
		},
		{
			href: '/settings/library/quality',
			label: m.nav_qualitySettings(),
			icon: Shield
		},
		{
			href: '/settings/library/languages',
			label: m.nav_languages(),
			icon: Languages
		},
		{
			href: '/settings/library/filters',
			label: m.nav_globalFilters(),
			icon: Filter
		}
	];
</script>

<div class="flex min-h-full flex-col">
	<SettingsTabNav {navItems} ariaLabel={m.settings_library_tabsAriaLabel()} />

	<div class="flex-1">
		{@render children()}
	</div>
</div>
