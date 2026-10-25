<script lang="ts">
	import { Server, Film, Shield, Download, Zap, Inbox } from '@lucide/svelte';
	import { SettingsTabNav } from '#lib/components/settings/index.js';
	import * as m from '#lib/paraglide/messages.js';

	let { children } = $props();

	const navItems = [
		{
			href: '/settings/system/general',
			label: m.nav_general(),
			icon: Server
		},
		{
			href: '/settings/system/metadata-providers',
			label: m.nav_metadataProviders(),
			icon: Film
		},
		{
			href: '/settings/system/captcha',
			label: m.nav_captchaSolver(),
			icon: Shield
		},
		{
			href: '/settings/system/backup',
			label: m.nav_backupRestore(),
			icon: Download
		},
		{
			href: '/settings/system/cinephage',
			label: m.nav_cinephage(),
			icon: Zap
		},
		{
			href: '/settings/system/requests',
			label: m.requestsSettings_title(),
			icon: Inbox
		}
	];
</script>

<div class="flex min-h-full flex-col">
	<SettingsTabNav {navItems} ariaLabel={m.settings_system_tabsAriaLabel()} />

	<!-- Page content -->
	<div class="flex-1">
		{@render children()}
	</div>
</div>
