<script lang="ts">
	import { AlertCircle, ChevronDown, ChevronUp, Loader2, Plus, Trash2, Tv } from '@lucide/svelte';
	import type { ChannelBackupLink } from '#lib/types/livetv.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		onToggle: () => void;
		backups: ChannelBackupLink[];
		loading: boolean;
		saving: boolean;
		error: string | null;
		onMoveUp: (index: number) => void;
		onMoveDown: (index: number) => void;
		onRemove: (backupId: string) => void;
		onAddBackup?: () => void;
	}

	let {
		open,
		onToggle,
		backups,
		loading,
		saving,
		error,
		onMoveUp,
		onMoveDown,
		onRemove,
		onAddBackup
	}: Props = $props();
</script>

<div class="collapse mt-2 rounded-lg bg-base-200" class:collapse-open={open}>
	<button
		type="button"
		class="collapse-title flex min-h-0 items-center justify-between px-3 py-2 text-sm font-medium"
		onclick={onToggle}
	>
		<span class="flex items-center gap-2">
			{m.livetv_channelEditModal_backupSources()}
			{#if backups.length > 0}
				<span class="badge badge-xs badge-neutral">{backups.length}</span>
			{/if}
		</span>
		<ChevronDown class="h-4 w-4 transition-transform {open ? 'rotate-180' : ''}" />
	</button>
	<div class="collapse-content px-3 pb-3">
		{#if error}
			<div class="mb-2 alert py-2 alert-error">
				<AlertCircle class="h-4 w-4" />
				<span class="text-sm">{error}</span>
			</div>
		{/if}

		{#if loading}
			<div class="flex justify-center py-3">
				<Loader2 class="h-5 w-5 animate-spin text-base-content/50" />
			</div>
		{:else if backups.length === 0}
			<p class="py-2 text-xs text-base-content/50">
				{m.livetv_channelEditModal_noBackups()}
			</p>
		{:else}
			<div class="space-y-2">
				{#each backups as backup, i (backup.id)}
					<div class="flex items-center gap-2 rounded bg-base-300 px-2 py-1.5">
						<span class="badge badge-xs badge-neutral">{i + 1}</span>
						{#if backup.channel.logo}
							<img
								src={backup.channel.logo}
								alt=""
								class="h-6 w-6 rounded bg-base-100 object-contain"
							/>
						{:else}
							<div class="flex h-6 w-6 items-center justify-center rounded bg-base-100">
								<Tv class="h-3 w-3 text-base-content/30" />
							</div>
						{/if}
						<div class="min-w-0 flex-1">
							<span class="block truncate text-xs font-medium">{backup.channel.name}</span>
							<span class="text-xs text-base-content/50">{backup.accountName}</span>
						</div>
						<div class="flex gap-0.5">
							<button
								type="button"
								class="btn btn-ghost btn-xs"
								onclick={() => onMoveUp(i)}
								disabled={i === 0 || saving}
								title={m.livetv_channelEditModal_moveUp()}
							>
								<ChevronUp class="h-3 w-3" />
							</button>
							<button
								type="button"
								class="btn btn-ghost btn-xs"
								onclick={() => onMoveDown(i)}
								disabled={i >= backups.length - 1 || saving}
								title={m.livetv_channelEditModal_moveDown()}
							>
								<ChevronDown class="h-3 w-3" />
							</button>
							<button
								type="button"
								class="btn btn-ghost text-error btn-xs"
								onclick={() => onRemove(backup.id)}
								title={m.livetv_channelEditModal_remove()}
							>
								<Trash2 class="h-3 w-3" />
							</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}

		{#if onAddBackup}
			<button type="button" class="btn mt-2 gap-1 btn-ghost btn-xs" onclick={onAddBackup}>
				<Plus class="h-3 w-3" />
				{m.livetv_channelEditModal_addBackup()}
			</button>
		{/if}
	</div>
</div>
