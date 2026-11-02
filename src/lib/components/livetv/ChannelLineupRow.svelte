<script lang="ts">
	import { GripVertical, Pencil, Trash2, Tv, Loader2, Info } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import type {
		ChannelLineupItemWithDetails,
		EpgProgram,
		EpgProgramWithProgress
	} from '#lib/types/livetv.js';

	interface NowNextEntry {
		now: EpgProgramWithProgress | null;
		next: EpgProgram | null;
	}

	interface Props {
		item: ChannelLineupItemWithDetails;
		index: number;
		selected: boolean;
		isDragging: boolean;
		isDropTarget: boolean;
		epgNow?: NowNextEntry;
		onSelect: (selected: boolean) => void;
		onDragStart: (e: DragEvent) => void;
		onDragOver: (e: DragEvent) => void;
		onDragLeave: () => void;
		onDrop: (e: DragEvent) => void;
		onDragEnd: () => void;
		onEdit: () => void;
		onRemove: () => void;
		onInlineEdit: (
			id: string,
			field: 'channelNumber' | 'customName',
			value: number | string | null
		) => Promise<boolean>;
		onShowSchedule?: (channel: ChannelLineupItemWithDetails) => void;
	}

	let {
		item,
		index: _index,
		selected,
		isDragging,
		isDropTarget,
		epgNow,
		onSelect,
		onDragStart,
		onDragOver,
		onDragLeave,
		onDrop,
		onDragEnd,
		onEdit,
		onRemove,
		onInlineEdit,
		onShowSchedule
	}: Props = $props();

	// Display channel number (custom or position-based)
	const displayNumber = $derived(item.channelNumber ?? item.position);

	// Inline editing state
	let editingField = $state<'number' | 'name' | null>(null);
	let editValue = $state('');
	let saving = $state(false);

	// Logo broken-image fallback. onerror as a prop renders as a literal
	// inline HTML attribute during SSR (Svelte replays the pre-hydration
	// event that way), which a strict CSP blocks without 'unsafe-hashes'.
	// Attaching imperatively avoids that path.
	let logoFailed = $state(false);
	let logoEl: HTMLImageElement | undefined = $state();
	$effect(() => {
		const el = logoEl;
		if (!el) return;
		const handleError = () => (logoFailed = true);
		el.addEventListener('error', handleError);
		return () => el.removeEventListener('error', handleError);
	});
	$effect(() => {
		void item.displayLogo;
		logoFailed = false;
	});

	function startEditNumber() {
		editingField = 'number';
		editValue = item.channelNumber?.toString() ?? '';
	}

	function startEditName() {
		editingField = 'name';
		editValue = item.customName ?? '';
	}

	async function handleSaveNumber() {
		if (editingField !== 'number') return;
		const trimmed = editValue.trim();
		const numValue = trimmed === '' ? null : parseInt(trimmed, 10);

		if (numValue !== null && (isNaN(numValue) || numValue < 1)) {
			editingField = null;
			return;
		}

		// Skip if unchanged
		if (numValue === item.channelNumber) {
			editingField = null;
			return;
		}

		saving = true;
		const success = await onInlineEdit(item.id, 'channelNumber', numValue);
		saving = false;
		if (success) {
			editingField = null;
		}
	}

	async function handleSaveName() {
		if (editingField !== 'name') return;
		const nameValue = editValue.trim() || null;

		// Skip if unchanged
		if (nameValue === item.customName) {
			editingField = null;
			return;
		}

		saving = true;
		const success = await onInlineEdit(item.id, 'customName', nameValue);
		saving = false;
		if (success) {
			editingField = null;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			editingField = null;
		} else if (e.key === 'Enter') {
			if (editingField === 'number') handleSaveNumber();
			else if (editingField === 'name') handleSaveName();
		}
	}
</script>

<tr
	class="transition-colors
		{isDragging ? 'bg-base-200 opacity-50' : ''}
		{isDropTarget ? 'bg-primary/10' : ''}
		{selected ? 'bg-base-300/50' : ''}"
	draggable="true"
	ondragstart={onDragStart}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}
	ondragend={onDragEnd}
>
	<!-- Checkbox -->
	<td class="w-10">
		<input
			type="checkbox"
			class="checkbox checkbox-sm checkbox-primary"
			checked={selected}
			onchange={(e) => onSelect(e.currentTarget.checked)}
		/>
	</td>

	<!-- Drag Handle -->
	<td class="w-10 cursor-grab">
		<GripVertical class="h-4 w-4 text-base-content/30" />
	</td>

	<!-- Channel Number -->
	<td class="w-16 text-center font-mono text-sm text-base-content/70">
		{#if editingField === 'number'}
			<div class="flex items-center justify-center gap-1">
				<input
					type="number"
					class="input-bordered input w-14 text-center font-mono input-xs"
					bind:value={editValue}
					onblur={handleSaveNumber}
					onkeydown={handleKeydown}
					min="1"
					disabled={saving}
				/>
				{#if saving}
					<Loader2 class="h-3 w-3 animate-spin text-base-content/50" />
				{/if}
			</div>
		{:else}
			<span
				class="cursor-pointer rounded px-1 hover:bg-base-200"
				ondblclick={startEditNumber}
				role="button"
				tabindex="0"
				onkeydown={(e) => e.key === 'Enter' && startEditNumber()}
				title={m.livetv_channelLineupRow_doubleClickToEdit()}
			>
				{displayNumber}
			</span>
		{/if}
	</td>

	<!-- Logo -->
	<td class="w-12">
		{#if item.displayLogo && !logoFailed}
			<img
				bind:this={logoEl}
				src={item.displayLogo}
				alt={item.displayName}
				class="h-8 w-8 rounded bg-base-100 object-contain"
			/>
		{:else}
			<div class="flex h-8 w-8 items-center justify-center rounded bg-base-300">
				<Tv class="h-4 w-4 text-base-content/30" />
			</div>
		{/if}
	</td>

	<!-- Name -->
	<td>
		{#if editingField === 'name'}
			<div class="flex items-center gap-1">
				<input
					type="text"
					class="input-bordered input w-full max-w-xs input-xs"
					bind:value={editValue}
					onblur={handleSaveName}
					onkeydown={handleKeydown}
					placeholder={item.channel.name}
					disabled={saving}
				/>
				{#if saving}
					<Loader2 class="h-3 w-3 animate-spin text-base-content/50" />
				{/if}
			</div>
		{:else}
			<div class="flex flex-col">
				<span
					class="inline-block w-fit cursor-pointer rounded px-1 font-medium hover:bg-base-200"
					ondblclick={startEditName}
					role="button"
					tabindex="0"
					onkeydown={(e) => e.key === 'Enter' && startEditName()}
					title={m.livetv_channelLineupRow_doubleClickToEdit()}
				>
					{item.displayName}
				</span>
				{#if item.customName && item.customName !== item.channel.name}
					<span class="text-xs text-base-content/50">{item.channel.name}</span>
				{/if}
			</div>
		{/if}
	</td>

	<!-- Source (Account) -->
	<td class="hidden md:table-cell">
		<span class="badge badge-ghost badge-sm">{item.accountName}</span>
	</td>

	<!-- Now Playing (EPG) -->
	<td class="hidden max-w-75 lg:table-cell">
		{#if epgNow?.now}
			<button
				type="button"
				class="flex w-full flex-col gap-0.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-base-200"
				onclick={() => onShowSchedule?.(item)}
				title={m.livetv_channelLineupRow_viewSchedule()}
			>
				<span class="truncate text-sm font-medium" title={epgNow.now.title}>
					{epgNow.now.title}
				</span>
				<div class="flex items-center gap-2">
					<progress
						class="progress h-1.5 w-20 progress-primary"
						value={epgNow.now.progress * 100}
						max="100"
					></progress>
					<span class="text-xs text-base-content/50">
						{m.livetv_channelLineupRow_minutesLeft({ count: epgNow.now.remainingMinutes })}
					</span>
				</div>
			</button>
		{:else}
			<div class="tooltip tooltip-left" data-tip="No program data. Check EPG status above.">
				<span class="flex items-center gap-1 text-sm text-base-content/40">
					<Info class="h-3 w-3" />
					{m.livetv_channelLineupRow_noEpg()}
				</span>
			</div>
		{/if}
	</td>

	<!-- Actions -->
	<td class="w-24">
		<div class="flex items-center gap-1">
			<button
				class="btn btn-ghost btn-xs"
				onclick={onEdit}
				title={m.livetv_channelLineupRow_editChannel()}
			>
				<Pencil class="h-3.5 w-3.5" />
			</button>
			<button
				class="btn btn-ghost text-error btn-xs hover:bg-error/10"
				onclick={onRemove}
				title={m.livetv_channelLineupRow_removeFromLineup()}
			>
				<Trash2 class="h-3.5 w-3.5" />
			</button>
		</div>
	</td>
</tr>
