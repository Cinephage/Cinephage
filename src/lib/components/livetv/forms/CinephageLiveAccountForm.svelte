<script lang="ts">
	import { Info } from '@lucide/svelte';
	import { SectionHeader } from '#lib/components/ui/modal/index.js';

	interface Props {
		name: string;
		enabled: boolean;
		mode: 'add' | 'edit';
		onNameChange: (value: string) => void;
		onEnabledChange: (value: boolean) => void;
	}

	let { name, enabled, mode: _mode, onNameChange, onEnabledChange }: Props = $props();
</script>

<div class="space-y-4">
	<!-- Name -->
	<div class="form-control">
		<label class="label py-1" for="cinephage-live-name">
			<span class="label-text">
				Account Name
				<span class="text-error">* </span>
			</span>
		</label>
		<input
			id="cinephage-live-name"
			type="text"
			class="input-bordered input input-sm"
			value={name}
			oninput={(e) => onNameChange(e.currentTarget.value)}
			placeholder="e.g. Cinephage Live Sports"
		/>
	</div>

	<SectionHeader title="Settings" />

	<div class="flex items-start gap-2 rounded-lg bg-base-200 px-4 py-3 text-sm">
		<Info class="mt-0.5 h-4 w-4 shrink-0 text-base-content/60" />
		<span class="text-base-content/70">
			Channels and the schedule are pulled from the Cinephage network with the instance's own
			identity — no credentials to configure. Add the channels you want to the lineup to make them
			playable.
		</span>
	</div>

	<label class="label cursor-pointer gap-2">
		<input
			type="checkbox"
			class="checkbox checkbox-sm checkbox-primary"
			checked={enabled}
			onchange={(e) => onEnabledChange(e.currentTarget.checked)}
		/>
		<span class="label-text">Enabled</span>
	</label>
</div>
