<script lang="ts">
	import { Activity, BarChart2, ListTodo, ScrollText } from '@lucide/svelte';
	import { SettingsTabNav } from '#lib/components/settings/index.js';
	import * as m from '#lib/paraglide/messages.js';

	let { children } = $props();

	const navItems = [
		{
			href: '/settings/monitoring/status',
			label: m.settings_monitoring_tabMaintenance(),
			icon: Activity
		},
		{
			href: '/settings/monitoring/tasks',
			label: m.nav_tasks(),
			icon: ListTodo
		},
		{
			href: '/settings/monitoring/logs',
			label: m.nav_logs(),
			icon: ScrollText
		},
		{
			href: '/settings/monitoring/reports',
			label: m.settings_monitoring_tabReports(),
			icon: BarChart2
		}
	];
</script>

<div class="flex min-h-full flex-col">
	<SettingsTabNav {navItems} ariaLabel={m.settings_monitoring_tabsAriaLabel()} />

	<div class="flex-1">
		{@render children()}
	</div>
</div>
