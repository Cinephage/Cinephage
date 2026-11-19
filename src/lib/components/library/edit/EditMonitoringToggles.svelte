<script lang="ts">
	/**
	 * The two switches at the top of both edit dialogs: monitored, and whether the
	 * item should pull subtitles. Only the second label differs per kind, so it
	 * arrives as a prop and the markup lives once.
	 */
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		monitored?: boolean;
		wantsSubtitles?: boolean;
		/** Kind-specific copy for the subtitle switch. */
		autoSubtitlesLabel: string;
	}

	let {
		monitored = $bindable(false),
		wantsSubtitles = $bindable(true),
		autoSubtitlesLabel
	}: Props = $props();
</script>

<div class="grid grid-cols-2 gap-3">
	<label class="label cursor-pointer">
		<span class="label-text text-xs text-base-content/80">{m.common_monitored()}</span>
		<input type="checkbox" class="toggle toggle-primary toggle-sm" bind:checked={monitored} />
	</label>
	<label class="label cursor-pointer">
		<span class="label-text text-xs text-base-content/80">{autoSubtitlesLabel}</span>
		<input type="checkbox" class="toggle toggle-primary toggle-sm" bind:checked={wantsSubtitles} />
	</label>
</div>
