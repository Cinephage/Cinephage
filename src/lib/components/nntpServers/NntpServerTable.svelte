<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { formatDisplayDate } from '#lib/utils/format.js';
	import {
		ChevronDown,
		ChevronUp,
		Settings,
		Trash2,
		ToggleLeft,
		ToggleRight,
		Server,
		FlaskConical,
		AlertTriangle,
		CheckCircle,
		XCircle,
		Loader2,
		GripVertical,
		Link2
	} from '@lucide/svelte';

	interface NntpServer {
		id: string;
		name: string;
		host: string;
		port: number;
		useSsl: boolean | null;
		username: string | null;
		maxConnections: number | null;
		priority: number | null;
		enabled: boolean | null;
		testResult: string | null;
		testError?: string | null;
		lastTestedAt: string | null;
	}

	interface Props {
		servers: NntpServer[];
		selectedIds: Set<string>;
		onSelect: (id: string, selected: boolean) => void;
		onSelectAll: (selected: boolean) => void;
		sort: {
			column: 'status' | 'name' | 'priority';
			direction: 'asc' | 'desc';
		};
		onSort: (column: 'status' | 'name' | 'priority') => void;
		canReorder: boolean;
		onPrioritySortForReorder: () => void;
		onEdit: (server: NntpServer) => void;
		onDelete: (server: NntpServer) => void;
		onToggle: (server: NntpServer) => void;
		onTest: (server: NntpServer) => Promise<void>;
		testingId?: string | null;
		onReorder?: (serverIds: string[]) => void;
	}

	let {
		servers,
		selectedIds,
		onSelect,
		onSelectAll,
		sort,
		onSort,
		canReorder,
		onPrioritySortForReorder,
		onEdit,
		onDelete,
		onToggle,
		onTest,
		testingId = null,
		onReorder
	}: Props = $props();

	let draggedIndex = $state<number | null>(null);
	let dragOverIndex = $state<number | null>(null);
	let reorderMode = $state(false);

	function isSortedBy(column: 'status' | 'name' | 'priority'): boolean {
		return sort.column === column;
	}

	function isAscending(): boolean {
		return sort.direction === 'asc';
	}

	function formatLastTested(lastTestedAt: string | null): string {
		if (!lastTestedAt) return 'never';
		return formatDisplayDate(lastTestedAt, {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function getStatusTooltip(server: NntpServer): string {
		if (!server.enabled) {
			return 'NNTP server is disabled by user';
		}
		if (server.testResult === 'failed') {
			const testedAt = formatLastTested(server.lastTestedAt);
			return server.testError
				? `Connection failed: ${server.testError}. Last tested: ${testedAt}`
				: `Connection test failed. Last tested: ${testedAt}`;
		}
		if (server.testResult === 'success') {
			return `Connection test succeeded. Last tested: ${formatLastTested(server.lastTestedAt)}`;
		}
		return 'Connection has not been tested yet';
	}

	const allSelected = $derived(servers.length > 0 && servers.every((s) => selectedIds.has(s.id)));
	const someSelected = $derived(servers.some((s) => selectedIds.has(s.id)) && !allSelected);
	const reorderDisabledReason = $derived(
		canReorder ? '' : 'Clear filters to reorder all servers by priority'
	);

	function toggleReorderMode() {
		if (!reorderMode && !canReorder) return;

		reorderMode = !reorderMode;
		draggedIndex = null;
		dragOverIndex = null;

		if (reorderMode) {
			onPrioritySortForReorder();
		}
	}

	function handleDragStart(event: DragEvent, index: number) {
		if (!reorderMode) return;
		draggedIndex = index;
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', String(index));
		}
	}

	function handleDragOver(event: DragEvent, index: number) {
		if (!reorderMode || draggedIndex === null) return;
		event.preventDefault();
		dragOverIndex = index;
	}

	function handleDragLeave() {
		dragOverIndex = null;
	}

	function handleDrop(event: DragEvent, dropIndex: number) {
		if (!reorderMode || draggedIndex === null || !onReorder) return;
		event.preventDefault();

		if (draggedIndex !== dropIndex) {
			const reordered = [...servers];
			const [moved] = reordered.splice(draggedIndex, 1);
			reordered.splice(dropIndex, 0, moved);
			onReorder(reordered.map((s) => s.id));
		}

		draggedIndex = null;
		dragOverIndex = null;
	}

	function handleDragEnd() {
		draggedIndex = null;
		dragOverIndex = null;
	}

	function moveServer(fromIndex: number, toIndex: number) {
		if (!onReorder || !reorderMode) return;
		if (toIndex < 0 || toIndex >= servers.length || fromIndex === toIndex) return;

		const reordered = [...servers];
		const [moved] = reordered.splice(fromIndex, 1);
		reordered.splice(toIndex, 0, moved);
		onReorder(reordered.map((s) => s.id));
	}

	function getServerUrl(server: NntpServer): string {
		return `${server.useSsl ? 'nntps' : 'nntp'}://${server.host}:${server.port}`;
	}

	$effect(() => {
		if (!canReorder && reorderMode) {
			reorderMode = false;
			draggedIndex = null;
			dragOverIndex = null;
		}
	});
</script>

{#if servers.length === 0}
	<div class="py-12 text-center text-base-content/60">
		<Server class="mx-auto mb-4 h-12 w-12 opacity-40" />
		<p class="text-lg font-medium">No usenet servers configured</p>
		<p class="mt-1 text-sm">Add an NNTP server to enable direct NZB streaming</p>
	</div>
{:else}
	<div class="space-y-3 overflow-x-hidden sm:hidden">
		<div class="rounded-lg border border-base-300/80 bg-base-100 px-3 py-2 shadow-sm">
			<div class="flex items-center justify-between gap-2">
				<label class="flex items-center gap-2 text-xs font-medium">
					<input
						type="checkbox"
						class="checkbox checkbox-sm checkbox-primary"
						checked={allSelected}
						indeterminate={someSelected}
						onchange={(e) => onSelectAll(e.currentTarget.checked)}
					/>
					Select all
				</label>
				<span class="text-xs text-base-content/60">{selectedIds.size} selected</span>
			</div>

			{#if onReorder}
				<div class="mt-2 border-t border-base-300/70 pt-2">
					<div class="flex items-center justify-between gap-2">
						<div
							class="text-xs font-medium {reorderMode ? 'text-primary' : 'text-base-content/70'}"
						>
							{reorderMode ? 'Reorder mode is active' : 'Priority reordering'}
						</div>
						<button
							class="btn gap-1 btn-xs {reorderMode ? 'btn-primary' : 'btn-ghost'}"
							onclick={toggleReorderMode}
							disabled={!canReorder}
							title={reorderDisabledReason}
						>
							<GripVertical class="h-3.5 w-3.5" />
							{reorderMode ? 'Done' : 'Reorder'}
						</button>
					</div>
					<p class="mt-1 text-xs text-base-content/60">
						{#if canReorder}
							{reorderMode
								? 'Drag cards or use the up/down arrows to change priority.'
								: 'Enable reorder mode to change NNTP server priority.'}
						{:else}
							Clear filters to reorder priorities.
						{/if}
					</p>
				</div>
			{/if}
		</div>

		{#each servers as server, index (server.id)}
			<div
				role="listitem"
				class="rounded-xl border bg-base-100 p-3 transition-all duration-150 {selectedIds.has(
					server.id
				)
					? 'border-primary/50 ring-1 ring-primary/30'
					: 'border-base-300/80'} {dragOverIndex === index
					? 'border-primary/70 bg-primary/5'
					: ''} {draggedIndex === index ? 'opacity-60' : ''}"
				draggable={reorderMode}
				ondragstart={(e) => handleDragStart(e, index)}
				ondragover={(e) => handleDragOver(e, index)}
				ondragleave={handleDragLeave}
				ondrop={(e) => handleDrop(e, index)}
				ondragend={handleDragEnd}
			>
				<div class="mb-2 flex items-start justify-between gap-2">
					<div class="flex min-w-0 items-start gap-2.5">
						{#if reorderMode}
							<div class="mt-0.5 flex h-5 w-5 items-center justify-center">
								<GripVertical class="h-4 w-4 text-base-content/50" />
							</div>
						{:else}
							<input
								type="checkbox"
								class="checkbox checkbox-sm checkbox-primary"
								checked={selectedIds.has(server.id)}
								onchange={(e) => onSelect(server.id, e.currentTarget.checked)}
							/>
						{/if}
						<div class="min-w-0">
							<div class="flex flex-wrap items-center gap-2">
								<button class="link text-sm font-bold link-hover" onclick={() => onEdit(server)}>
									{server.name}
								</button>
								<div class="tooltip tooltip-right" data-tip={getStatusTooltip(server)}>
									{#if !server.enabled}
										<span class="badge gap-1 badge-ghost">
											<XCircle class="h-3 w-3" />
											<span class="text-xs">{m.status_disabled()}</span>
										</span>
									{:else if server.testResult === 'failed'}
										<span class="badge gap-1 badge-error">
											<AlertTriangle class="h-3 w-3" />
											<span class="text-xs">{m.status_unhealthy()}</span>
										</span>
									{:else}
										<span class="badge gap-1 badge-success">
											<CheckCircle class="h-3 w-3" />
											<span class="text-xs">{m.status_healthy()}</span>
										</span>
									{/if}
								</div>
							</div>
						</div>
					</div>
					<div class="flex shrink-0 items-center gap-1">
						{#if reorderMode}
							<button
								class="btn btn-ghost btn-xs"
								onclick={() => moveServer(index, index - 1)}
								disabled={index === 0}
								title={m.action_moveUp()}
								aria-label={m.action_moveUp()}
							>
								<ChevronUp class="h-3.5 w-3.5" />
							</button>
							<button
								class="btn btn-ghost btn-xs"
								onclick={() => moveServer(index, index + 1)}
								disabled={index === servers.length - 1}
								title={m.action_moveDown()}
								aria-label={m.action_moveDown()}
							>
								<ChevronDown class="h-3.5 w-3.5" />
							</button>
						{/if}
						<span class="badge shrink-0 gap-1 badge-ghost badge-sm">
							<Link2 class="h-3 w-3" />
							{server.maxConnections ?? 10}
						</span>
						<span class="badge shrink-0 badge-outline badge-sm">{server.priority ?? 1}</span>
					</div>
				</div>

				<div
					class="mb-3 min-w-0 truncate font-mono text-xs text-base-content/60"
					title={getServerUrl(server)}
				>
					{getServerUrl(server)}
				</div>

				<div class="grid grid-cols-4 gap-1.5">
					<button
						class="btn btn-ghost btn-xs"
						onclick={() => onTest(server)}
						title={m.action_testConnection()}
						aria-label={m.action_testConnection()}
						disabled={testingId === server.id || reorderMode}
					>
						{#if testingId === server.id}
							<Loader2 class="h-4 w-4 animate-spin" />
						{:else}
							<FlaskConical class="h-4 w-4" />
						{/if}
					</button>
					<button
						class="btn btn-ghost btn-xs"
						onclick={() => onToggle(server)}
						title={server.enabled ? m.action_disable() : m.action_enable()}
						aria-label={server.enabled ? m.nntpServer_disableServer() : m.nntpServer_enableServer()}
						disabled={testingId === server.id || reorderMode}
					>
						{#if server.enabled}
							<ToggleRight class="h-4 w-4 text-success" />
						{:else}
							<ToggleLeft class="h-4 w-4" />
						{/if}
					</button>
					<button
						class="btn btn-ghost btn-xs"
						onclick={() => onEdit(server)}
						title={m.action_edit()}
						aria-label={m.nntpServer_editServer()}
						disabled={reorderMode}
					>
						<Settings class="h-4 w-4" />
					</button>
					<button
						class="btn btn-ghost text-error btn-xs"
						onclick={() => onDelete(server)}
						title={m.common_delete()}
						aria-label={m.nntpServer_deleteServer()}
						disabled={reorderMode}
					>
						<Trash2 class="h-4 w-4" />
					</button>
				</div>
			</div>
		{/each}
	</div>

	<div class="hidden overflow-x-auto sm:block">
		{#if onReorder}
			<div class="flex items-center justify-end border-b border-base-300 px-4 py-2">
				<button
					class="btn btn-sm {reorderMode ? 'btn-primary' : 'btn-ghost'}"
					onclick={toggleReorderMode}
					disabled={!canReorder}
					title={reorderDisabledReason}
				>
					<GripVertical class="h-4 w-4" />
					{reorderMode ? 'Done Reordering' : 'Reorder Priorities'}
				</button>
			</div>
		{/if}

		{#if reorderMode}
			<div class="flex items-center gap-2 bg-info/10 px-4 py-2 text-sm text-info">
				<GripVertical class="h-4 w-4" />
				Drag servers to reorder. Lower priority numbers are used first.
			</div>
		{/if}

		<table class="table table-sm">
			<thead>
				<tr>
					<th class="w-10">
						{#if reorderMode}
							<GripVertical class="mx-auto h-4 w-4 text-base-content/50" />
						{:else}
							<input
								type="checkbox"
								class="checkbox checkbox-sm checkbox-primary"
								checked={allSelected}
								indeterminate={someSelected}
								onchange={(e) => onSelectAll(e.currentTarget.checked)}
							/>
						{/if}
					</th>
					<th>
						<button
							class="flex items-center gap-1 hover:text-primary"
							onclick={() => onSort('status')}
							disabled={reorderMode}
						>
							Status
							{#if isSortedBy('status') && !reorderMode}
								{#if isAscending()}
									<ChevronUp class="h-3 w-3" />
								{:else}
									<ChevronDown class="h-3 w-3" />
								{/if}
							{/if}
						</button>
					</th>
					<th>
						<button
							class="flex items-center gap-1 hover:text-primary"
							onclick={() => onSort('name')}
							disabled={reorderMode}
						>
							Name
							{#if isSortedBy('name') && !reorderMode}
								{#if isAscending()}
									<ChevronUp class="h-3 w-3" />
								{:else}
									<ChevronDown class="h-3 w-3" />
								{/if}
							{/if}
						</button>
					</th>
					<th>Host</th>
					<th>Connections</th>
					<th>
						<button
							class="flex items-center gap-1 hover:text-primary"
							onclick={() => onSort('priority')}
							disabled={reorderMode}
						>
							Priority
							{#if isSortedBy('priority') && !reorderMode}
								{#if isAscending()}
									<ChevronUp class="h-3 w-3" />
								{:else}
									<ChevronDown class="h-3 w-3" />
								{/if}
							{/if}
						</button>
					</th>
					<th class="pl-4! text-start">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each servers as server, index (server.id)}
					<tr
						class={`hover ${dragOverIndex === index && draggedIndex !== index ? 'bg-primary/5' : ''} ${draggedIndex === index ? 'opacity-70' : ''} ${reorderMode ? 'cursor-move' : ''}`}
						draggable={reorderMode}
						ondragstart={(e) => handleDragStart(e, index)}
						ondragover={(e) => handleDragOver(e, index)}
						ondragleave={handleDragLeave}
						ondrop={(e) => handleDrop(e, index)}
						ondragend={handleDragEnd}
					>
						<td class="w-10">
							{#if reorderMode}
								<GripVertical class="mx-auto h-4 w-4 text-base-content/50" />
							{:else}
								<input
									type="checkbox"
									class="checkbox checkbox-sm checkbox-primary"
									checked={selectedIds.has(server.id)}
									onchange={(e) => onSelect(server.id, e.currentTarget.checked)}
								/>
							{/if}
						</td>
						<td>
							<div class="tooltip tooltip-right" data-tip={getStatusTooltip(server)}>
								{#if !server.enabled}
									<span class="badge gap-1 badge-ghost">
										<XCircle class="h-3 w-3" />
										<span class="text-xs">Disabled</span>
									</span>
								{:else if server.testResult === 'failed'}
									<span class="badge gap-1 badge-error">
										<AlertTriangle class="h-3 w-3" />
										<span class="text-xs">Unhealthy</span>
									</span>
								{:else}
									<span class="badge gap-1 badge-success">
										<CheckCircle class="h-3 w-3" />
										<span class="text-xs">Healthy</span>
									</span>
								{/if}
							</div>
						</td>
						<td>
							<div class="font-bold">{server.name}</div>
						</td>
						<td>
							<div class="font-mono text-sm">{getServerUrl(server)}</div>
						</td>
						<td>
							<span class="badge badge-ghost badge-sm">{server.maxConnections ?? 10}</span>
						</td>
						<td>
							<span class="badge badge-outline badge-sm">{server.priority ?? 1}</span>
						</td>
						<td>
							<div class="flex gap-0">
								<button
									class="btn btn-ghost btn-xs"
									onclick={() => onTest(server)}
									title="Test connection"
									disabled={testingId === server.id}
								>
									{#if testingId === server.id}
										<Loader2 class="h-4 w-4 animate-spin" />
									{:else}
										<FlaskConical class="h-4 w-4" />
									{/if}
								</button>
								<button
									class="btn btn-ghost btn-xs"
									onclick={() => onToggle(server)}
									title={server.enabled ? 'Disable' : 'Enable'}
									disabled={testingId === server.id}
								>
									{#if server.enabled}
										<ToggleRight class="h-4 w-4 text-success" />
									{:else}
										<ToggleLeft class="h-4 w-4" />
									{/if}
								</button>
								<button
									class="btn btn-ghost btn-xs"
									onclick={() => onEdit(server)}
									title="Edit server"
								>
									<Settings class="h-4 w-4" />
								</button>
								<button
									class="btn btn-ghost text-error btn-xs"
									onclick={() => onDelete(server)}
									title="Delete server"
								>
									<Trash2 class="h-4 w-4" />
								</button>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
