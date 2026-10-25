<script lang="ts">
	import { ChevronDown, Check, Copy } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		onToggle: () => void;
		channelName: string;
		channelNumber: string | number | null;
		providerCategory: string | null;
		tvArchive: boolean;
		archiveDurationFormatted: string;
		streamCommand: string | undefined;
		copiedCmd: boolean;
		onCopyStreamCommand: () => void;
		accountId: string;
		channelDbId: string;
	}

	let {
		open,
		onToggle,
		channelName,
		channelNumber,
		providerCategory,
		tvArchive,
		archiveDurationFormatted,
		streamCommand,
		copiedCmd,
		onCopyStreamCommand,
		accountId,
		channelDbId
	}: Props = $props();
</script>

<div class="collapse mt-4 rounded-lg bg-base-200" class:collapse-open={open}>
	<button
		type="button"
		class="collapse-title flex min-h-0 items-center justify-between px-3 py-2 text-sm font-medium"
		onclick={onToggle}
	>
		<span>{m.livetv_channelEditModal_technicalDetails()}</span>
		<ChevronDown class="h-4 w-4 transition-transform {open ? 'rotate-180' : ''}" />
	</button>
	<div class="collapse-content px-3 pb-3">
		<div class="space-y-2 text-sm">
			<div class="flex justify-between gap-4">
				<span class="text-base-content/50">{m.livetv_channelEditModal_originalName()}</span>
				<span class="truncate font-medium">{channelName}</span>
			</div>
			<div class="flex justify-between">
				<span class="text-base-content/50"
					>{m.livetv_channelEditModal_originalNumber({
						number: channelNumber ?? 'None'
					})}</span
				>
				<span class="font-medium">{channelNumber || 'None'}</span>
			</div>
			<div class="flex justify-between gap-4">
				<span class="text-base-content/50">{m.livetv_channelEditModal_providerCategory()}</span>
				<span class="truncate font-medium">{providerCategory || 'None'}</span>
			</div>
			<div class="flex justify-between">
				<span class="text-base-content/50">{m.livetv_channelEditModal_archive()}</span>
				<span class="font-medium">
					{#if tvArchive}
						{m.livetv_channelEditModal_archiveYes({
							duration: archiveDurationFormatted
						})}
					{:else}
						{m.livetv_channelEditModal_archiveNo()}
					{/if}
				</span>
			</div>
			<div>
				<span class="text-base-content/50">{m.livetv_channelEditModal_streamCommand()}</span>
				<div class="mt-1 flex items-center gap-2">
					<code
						class="flex-1 truncate rounded bg-base-300 px-2 py-1 font-mono text-xs"
						title={streamCommand}
					>
						{streamCommand}
					</code>
					<button
						type="button"
						class="btn btn-ghost btn-xs"
						onclick={onCopyStreamCommand}
						title={m.livetv_channelEditModal_copy()}
					>
						{#if copiedCmd}
							<Check class="h-3.5 w-3.5 text-success" />
						{:else}
							<Copy class="h-3.5 w-3.5" />
						{/if}
					</button>
				</div>
			</div>
			<div class="flex justify-between">
				<span class="text-base-content/50">{m.livetv_channelEditModal_accountId()}</span>
				<span class="font-mono text-xs">{accountId}</span>
			</div>
			<div class="flex justify-between">
				<span class="text-base-content/50">{m.livetv_channelEditModal_channelId()}</span>
				<span class="font-mono text-xs">{channelDbId}</span>
			</div>
		</div>
	</div>
</div>
