<script lang="ts">
	import { SectionHeader } from '#lib/components/ui/modal/index.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		maxConnections: number;
		priority: number;
	}

	let { maxConnections = $bindable(), priority = $bindable() }: Props = $props();
</script>

<SectionHeader title={m.settings_integrations_nntpServers_serverSettings()} />

<div class="form-control">
	<label class="label py-1" for="maxConnections">
		<span class="label-text">{m.settings_integrations_nntpServers_maxConnections()}</span>
	</label>
	<input
		id="maxConnections"
		type="number"
		class="input-bordered input input-sm"
		bind:value={maxConnections}
		min="1"
		max="50"
	/>
	<div class="label py-1">
		<span class="label-text-alt text-xs">
			{m.settings_integrations_nntpServers_maxConnectionsHelp()}
		</span>
	</div>
</div>

<div class="form-control">
	<label class="label py-1" for="priority">
		<span class="label-text">{m.common_priority()}</span>
	</label>
	<input
		id="priority"
		type="number"
		class="input-bordered input input-sm"
		bind:value={priority}
		min="0"
		max="99"
	/>
	<div class="label py-1">
		<span class="label-text-alt text-xs">
			{m.settings_integrations_nntpServers_priorityHelp()}
		</span>
	</div>
</div>
