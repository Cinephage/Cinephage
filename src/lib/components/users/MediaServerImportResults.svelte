<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Check, Copy, Link2Off, XCircle } from '@lucide/svelte';

	interface ImportRowResult {
		serverUserId: string;
		serverUsername: string;
		status: 'created' | 'failed';
		error: string | null;
		userId: string | null;
		username: string | null;
		email: string | null;
		tempPassword: string | null;
		linked: boolean;
	}

	interface Props {
		results: ImportRowResult[];
		copiedId: string | null;
		onCopy: (row: ImportRowResult) => void;
	}

	let { results, copiedId, onCopy }: Props = $props();

	const createdCount = $derived(results.filter((row) => row.status === 'created').length);
</script>

<p class="text-sm font-medium">
	{m.users_importSummary({ created: String(createdCount), total: String(results.length) })}
</p>

<div class="space-y-3">
	{#each results as row (row.serverUserId)}
		<div
			class="space-y-2 rounded-lg border border-base-300 p-3 {row.status === 'failed'
				? 'border-error/30 bg-error/5'
				: ''}"
		>
			<div class="flex items-center justify-between gap-2">
				<span class="min-w-0 truncate font-medium">{row.username ?? row.serverUsername}</span>
				{#if row.status === 'failed'}
					<span
						class="badge shrink-0 gap-1 border-error/40 bg-error/10 badge-sm whitespace-nowrap text-error"
					>
						<XCircle class="h-3 w-3" />
						{m.users_importFailed()}
					</span>
				{:else if row.linked}
					<span
						class="badge shrink-0 gap-1 border-success/40 bg-success/10 badge-sm whitespace-nowrap text-success"
					>
						<Check class="h-3 w-3" />
						{m.users_importCreatedLinked()}
					</span>
				{:else}
					<span
						class="badge shrink-0 gap-1 border-warning/40 bg-warning/10 badge-sm whitespace-nowrap text-warning"
					>
						<Link2Off class="h-3 w-3" />
						{m.users_importCreatedUnlinked()}
					</span>
				{/if}
			</div>

			{#if row.status === 'failed'}
				<p class="text-sm text-error">{row.error}</p>
			{:else}
				<p class="text-xs break-all text-base-content/60">{row.email}</p>
				{#if row.tempPassword}
					<div class="flex items-center gap-2">
						<code
							class="min-w-0 flex-1 rounded bg-base-200 px-2 py-1.5 font-mono text-sm break-all"
						>
							{row.tempPassword}
						</code>
						<button
							type="button"
							class="btn shrink-0 gap-1 btn-ghost btn-xs"
							onclick={() => onCopy(row)}
						>
							<Copy class="h-3 w-3" />
							{copiedId === row.serverUserId
								? m.users_importCopied()
								: m.users_importCopyPassword()}
						</button>
					</div>
				{/if}
				{#if !row.linked && row.error}
					<p class="text-xs text-warning">{row.error}</p>
				{/if}
			{/if}
		</div>
	{/each}
</div>
