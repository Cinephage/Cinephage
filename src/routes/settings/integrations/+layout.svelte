<script lang="ts">
	import { DatabaseSearch, Download, Server, Captions, Monitor, Archive } from '@lucide/svelte';
	import { SettingsTabNav } from '#lib/components/settings/index.js';
	import * as m from '#lib/paraglide/messages.js';

	let { children } = $props();

	const navItems = [
		{
			href: '/settings/integrations/indexers',
			label: m.nav_indexers(),
			icon: DatabaseSearch
		},
		{
			href: '/settings/integrations/download-clients',
			label: m.nav_downloadClients(),
			icon: Download
		},
		{
			href: '/settings/integrations/nntp-servers',
			label: m.nav_nntpServers(),
			icon: Server
		},
		{
			href: '/settings/integrations/subtitle-providers',
			label: m.nav_subtitleProviders(),
			icon: Captions
		},
		{
			href: '/settings/integrations/media-browsers',
			label: m.nav_mediaServers(),
			icon: Monitor
		},
		{
			href: '/settings/integrations/streaming',
			label: m.nav_streaming(),
			icon: Archive
		}
	];
</script>

<div class="flex min-h-full flex-col">
	<SettingsTabNav {navItems} ariaLabel={m.settings_integrations_tabsAriaLabel()} />

	<!-- Page content -->
	<div class="flex-1">
		{@render children()}
	</div>
</div>
