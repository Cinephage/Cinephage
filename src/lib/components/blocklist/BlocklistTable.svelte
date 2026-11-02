<script lang="ts">
	import { ChevronDown, ChevronUp, Trash2 } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	import type { BlocklistEntry } from './index.js';

	interface Props {
		entries: BlocklistEntry[];
		selectedIds: Set<string>;
		onSelect: (id: string, selected: boolean) => void;
		onSelectAll: (selected: boolean) => void;
		sort: {
			column: 'title' | 'reason' | 'createdAt' | 'expiresAt';
			direction: 'asc' | 'desc';
		};
		onSort: (column: 'title' | 'reason' | 'createdAt' | 'expiresAt') => void;
		onDelete: (entry: BlocklistEntry) => void;
		onUpdateExpiry?: (id: string, expiresInHours: number | null) => Promise<void>;
	}

	let {
		entries,
		selectedIds,
		onSelect,
		onSelectAll,
		sort,
		onSort,
		onDelete,
		onUpdateExpiry
	}: Props = $props();

	const allSelected = $derived(entries.length > 0 && entries.every((e) => selectedIds.has(e.id)));
	const someSelected = $derived(entries.some((e) => selectedIds.has(e.id)) && !allSelected);

	let editingExpiryId = $state<string | null>(null);
	let expiryLoading = $state(false);

	const durationOptions: { label: () => string; value: number | null }[] = [
		{ label: m.blocklist_duration_1hour, value: 1 },
		{ label: m.blocklist_duration_6hours, value: 6 },
		{ label: m.blocklist_duration_24hours, value: 24 },
		{ label: m.blocklist_duration_72hours, value: 72 },
		{ label: m.blocklist_duration_1week, value: 168 },
		{ label: m.blocklist_duration_permanent, value: null }
	];

	function formatReason(reason: string): string {
		const map: Record<string, string> = {
			download_failed: m.blocklist_reason_downloadFailed(),
			import_failed: m.blocklist_reason_importFailed(),
			quality_mismatch: m.blocklist_reason_qualityMismatch(),
			manual: m.blocklist_reason_manual(),
			duplicate: m.blocklist_reason_duplicate(),
			bad_release: m.blocklist_reason_badRelease()
		};
		return map[reason] ?? reason;
	}

	import { getLocale } from '#lib/paraglide/runtime.js';

	function formatDate(dateStr: string | null): string {
		if (!dateStr) return '-';
		return new Date(dateStr).toLocaleDateString(getLocale(), {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function getExpiryLabel(expiresAt: string | null): { label: string; variant: string } {
		if (!expiresAt) return { label: m.blocklist_duration_permanent(), variant: 'badge-ghost' };
		const now = Date.now();
		const expires = new Date(expiresAt).getTime();
		if (expires < now) return { label: m.blocklist_duration_expired(), variant: 'badge-warning' };
		const hoursLeft = Math.round((expires - now) / (1000 * 60 * 60));
		if (hoursLeft < 24)
			return { label: m.blocklist_hoursLeft({ hours: hoursLeft }), variant: 'badge-info' };
		const daysLeft = Math.round(hoursLeft / 24);
		return { label: m.blocklist_daysLeft({ days: daysLeft }), variant: 'badge-ghost' };
	}

	function protocolBadge(protocol: string | null): string {
		if (!protocol) return '';
		const map: Record<string, string> = {
			torrent: 'badge-info',
			usenet: 'badge-success',
			streaming: 'badge-accent'
		};
		return map[protocol] ?? 'badge-ghost';
	}

	async function handleExpiryChange(id: string, hours: number | null) {
		if (!onUpdateExpiry) return;
		expiryLoading = true;
		try {
			await onUpdateExpiry(id, hours);
		} finally {
			expiryLoading = false;
			editingExpiryId = null;
		}
	}
</script>

<div class="overflow-x-auto">
	<table class="table table-sm">
		<thead>
			<tr>
				<th class="w-10">
					<input
						type="checkbox"
						class="checkbox checkbox-xs checkbox-primary"
						checked={allSelected}
						indeterminate={someSelected}
						onchange={(e) => onSelectAll((e.currentTarget as HTMLInputElement).checked)}
						aria-label={m.blocklist_tableSelectAll()}
					/>
				</th>
				<th>
					<button
						class="btn flex items-center gap-1 btn-ghost btn-xs"
						onclick={() => onSort('title')}
					>
						{m.blocklist_tableTitle()}
						{#if sort.column === 'title' && sort.direction === 'asc'}
							<ChevronUp class="h-3 w-3" />
						{:else}
							<ChevronDown class="h-3 w-3" />
						{/if}
					</button>
				</th>
				<th>
					<button
						class="btn flex items-center gap-1 btn-ghost btn-xs"
						onclick={() => onSort('reason')}
					>
						{m.blocklist_tableReason()}
						{#if sort.column === 'reason' && sort.direction === 'asc'}
							<ChevronUp class="h-3 w-3" />
						{:else}
							<ChevronDown class="h-3 w-3" />
						{/if}
					</button>
				</th>
				<th>{m.blocklist_tableMessage()}</th>
				<th>{m.blocklist_tableProtocol()}</th>
				<th>
					<button
						class="btn flex items-center gap-1 btn-ghost btn-xs"
						onclick={() => onSort('createdAt')}
					>
						{m.blocklist_tableAdded()}
						{#if sort.column === 'createdAt' && sort.direction === 'asc'}
							<ChevronUp class="h-3 w-3" />
						{:else}
							<ChevronDown class="h-3 w-3" />
						{/if}
					</button>
				</th>
				<th>
					<button
						class="btn flex items-center gap-1 btn-ghost btn-xs"
						onclick={() => onSort('expiresAt')}
					>
						{m.blocklist_tableExpires()}
						{#if sort.column === 'expiresAt' && sort.direction === 'asc'}
							<ChevronUp class="h-3 w-3" />
						{:else}
							<ChevronDown class="h-3 w-3" />
						{/if}
					</button>
				</th>
				<th class="w-16">{m.blocklist_tableActions()}</th>
			</tr>
		</thead>
		<tbody>
			{#each entries as entry (entry.id)}
				<tr>
					<td>
						<input
							type="checkbox"
							class="checkbox checkbox-xs checkbox-primary"
							checked={selectedIds.has(entry.id)}
							onchange={(e) => onSelect(entry.id, (e.currentTarget as HTMLInputElement).checked)}
							aria-label={m.blocklist_tableSelectEntry({ title: entry.title })}
						/>
					</td>
					<td>
						<span class="block max-w-48 truncate text-sm" title={entry.title}>
							{entry.title}
						</span>
					</td>
					<td>
						<span class="badge badge-ghost badge-sm">{formatReason(entry.reason)}</span>
					</td>
					<td>
						<span
							class="block max-w-40 truncate text-xs text-base-content/60"
							title={entry.message ?? ''}
						>
							{entry.message ?? '-'}
						</span>
					</td>
					<td>
						{#if entry.protocol}
							<span class="badge badge-xs {protocolBadge(entry.protocol)}">
								{entry.protocol}
							</span>
						{:else}
							-
						{/if}
					</td>
					<td class="text-xs text-base-content/60">{formatDate(entry.createdAt)}</td>
					<td>
						{#if editingExpiryId === entry.id}
							<select
								class="select-bordered select w-28 select-xs"
								onchange={(e) =>
									handleExpiryChange(
										entry.id,
										(e.currentTarget as HTMLSelectElement).value === ''
											? null
											: Number((e.currentTarget as HTMLSelectElement).value)
									)}
								disabled={expiryLoading}
							>
								{#each durationOptions as option (option.value)}
									<option value={option.value === null ? '' : option.value}>
										{option.label()}
									</option>
								{/each}
							</select>
						{:else}
							<button
								class="badge cursor-pointer badge-xs {getExpiryLabel(entry.expiresAt).variant}"
								onclick={() => (editingExpiryId = entry.id)}
								title={m.blocklist_tableEditExpiry()}
							>
								{getExpiryLabel(entry.expiresAt).label}
							</button>
						{/if}
					</td>
					<td>
						<button
							class="btn btn-ghost text-error btn-xs"
							onclick={() => onDelete(entry)}
							aria-label={m.blocklist_tableRemoveEntry({ title: entry.title })}
						>
							<Trash2 class="h-3.5 w-3.5" />
						</button>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
