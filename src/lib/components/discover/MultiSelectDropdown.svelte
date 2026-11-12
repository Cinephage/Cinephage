<script lang="ts">
	import { ChevronDown, Search } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	export interface DropdownOption {
		id: string;
		label: string;
		title?: string;
		/** Renders a heading above the first option carrying it. */
		group?: string;
	}

	interface Props {
		id: string;
		label: string;
		options: DropdownOption[];
		selected: string[];
		onToggle: (id: string) => void;
		onClear?: () => void;
		mode?: 'single' | 'multiple';
		searchable?: boolean;
		placeholder?: string;
	}

	let {
		id,
		label,
		options,
		selected,
		onToggle,
		onClear,
		mode = 'multiple',
		searchable = false,
		placeholder = ''
	}: Props = $props();

	let open = $state(false);
	let query = $state('');
	let root = $state<HTMLDivElement | null>(null);

	const filtered = $derived(
		query.trim()
			? options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()))
			: options
	);

	const summary = $derived.by(() => {
		if (selected.length === 0) return placeholder;
		if (selected.length > 2) return m.common_selected({ count: selected.length });
		return options
			.filter((option) => selected.includes(option.id))
			.map((option) => option.label)
			.join(', ');
	});

	// The panel floats over the drawer's scroll area, so it closes on the way out
	// rather than trapping the pointer.
	$effect(() => {
		if (!open) return;
		const onPointerDown = (event: MouseEvent) => {
			if (root && !root.contains(event.target as Node)) open = false;
		};
		const onKeydown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') open = false;
		};
		document.addEventListener('mousedown', onPointerDown);
		document.addEventListener('keydown', onKeydown);
		return () => {
			document.removeEventListener('mousedown', onPointerDown);
			document.removeEventListener('keydown', onKeydown);
		};
	});

	function choose(optionId: string) {
		onToggle(optionId);
		if (mode === 'single') open = false;
	}
</script>

<div class="form-control relative" bind:this={root}>
	<span class="label text-sm font-bold tracking-wide text-base-content/70 uppercase">
		{label}
		{#if selected.length > 1}
			<span class="badge badge-sm badge-primary">{selected.length}</span>
		{/if}
	</span>

	<button
		type="button"
		class="flex w-full items-center justify-between gap-2 rounded-lg border border-base-300 bg-base-200 px-3 py-2 text-left text-sm transition-colors hover:bg-base-200/70 focus:border-primary/50 focus:ring-1 focus:ring-primary/20 focus:outline-none"
		aria-expanded={open}
		aria-controls="{id}-options"
		onclick={() => (open = !open)}
	>
		<span class="truncate {selected.length === 0 ? 'text-base-content/40' : ''}">{summary}</span>
		<ChevronDown
			class="h-4 w-4 shrink-0 text-base-content/50 transition-transform duration-200 {open
				? 'rotate-180'
				: ''}"
		/>
	</button>

	{#if open}
		<div
			id="{id}-options"
			class="absolute top-full right-0 left-0 z-20 mt-1 max-h-96 overflow-y-auto rounded-lg border border-base-300 bg-base-100 p-1 shadow-xl"
		>
			{#if searchable}
				<div class="relative mb-1">
					<Search
						class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-base-content/40"
					/>
					<input
						class="input w-full pl-7 input-sm"
						placeholder={m.discover_filter_searchList()}
						bind:value={query}
					/>
				</div>
			{/if}

			{#each filtered as option, index (option.id)}
				{#if option.group && filtered[index - 1]?.group !== option.group}
					<p class="mt-2 mb-1 px-2 text-xs font-bold tracking-wide text-base-content/40 uppercase">
						{option.group}
					</p>
				{/if}
				<label
					class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-base-200"
				>
					<input
						type={mode === 'single' ? 'radio' : 'checkbox'}
						class="checkbox checkbox-sm checkbox-primary"
						checked={selected.includes(option.id)}
						onchange={() => choose(option.id)}
					/>
					<span class="truncate" title={option.title ?? option.label}>{option.label}</span>
				</label>
			{:else}
				<p class="px-2 py-1.5 text-sm text-base-content/50">{m.discover_filter_noMatches()}</p>
			{/each}

			{#if onClear && selected.length > 0}
				<button
					type="button"
					class="mt-1 w-full rounded px-2 py-1.5 text-left text-sm text-base-content/60 transition-colors hover:bg-base-200"
					onclick={() => {
						onClear();
						open = false;
					}}
				>
					{m.action_clear()}
				</button>
			{/if}
		</div>
	{/if}
</div>
