<script lang="ts">
	import { BugReportForm } from '#lib/components/bugreport/index.js';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import * as m from '#lib/paraglide/messages.js';
</script>

<SettingsPage title={m.settings_monitoring_tabBugReport()}>
	<div class="mx-auto max-w-3xl">
		<BugReportForm />
	</div>
</SettingsPage>
