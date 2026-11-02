<script lang="ts">
	import { Ban, EyeOff, Hash, FileWarning } from '@lucide/svelte';
	import { SettingsTabNav } from '#lib/components/settings/index.js';
	import * as m from '#lib/paraglide/messages.js';

	let { children } = $props();

	const navItems = [
		{
			href: '/settings/blocklist/releases',
			label: m.blocklist_tab_releases(),
			icon: Ban
		},
		{
			href: '/settings/blocklist/blocked-media',
			label: m.blocklist_tab_blockedMedia(),
			icon: EyeOff
		},
		{
			href: '/settings/blocklist/blocked-keywords',
			label: m.blocklist_tab_blockedKeywords(),
			icon: Hash
		},
		{
			href: '/settings/blocklist/blocked-extensions',
			label: m.nav_blockedExtensions(),
			icon: FileWarning
		}
	];
</script>

<div class="flex min-h-full flex-col">
	<SettingsTabNav {navItems} ariaLabel={m.settings_blocklist_tabsAriaLabel()} />

	<div class="flex-1">
		{@render children()}
	</div>
</div>
