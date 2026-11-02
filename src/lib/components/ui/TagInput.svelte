<script lang="ts">
	import { X } from '@lucide/svelte';

	interface Props {
		values: string[];
		placeholder?: string;
		label?: string;
		hint?: string;
		normalize?: (v: string) => string;
	}

	let {
		values = $bindable([]),
		placeholder = 'Add and press Enter',
		label = '',
		hint = '',
		normalize = (v) => v.trim()
	}: Props = $props();

	let input = $state('');

	function add() {
		if (!input.trim()) {
			input = '';
			return;
		}
		const normalized = normalize(input);
		if (!normalized || values.includes(normalized)) {
			input = '';
			return;
		}
		values = [...values, normalized];
		input = '';
	}

	function remove(index: number) {
		values = values.filter((_, i) => i !== index);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			add();
		} else if (e.key === 'Backspace' && input === '' && values.length > 0) {
			values = values.slice(0, -1);
		}
	}
</script>

<div class="form-control">
	{#if label}
		<div class="label py-1">
			<span class="label-text">{label}</span>
		</div>
	{/if}

	<!--
		.input.input-sm gives DaisyUI's native border + :focus-within outline (same colour
		as every other field). Height is overridden inline so tags can wrap; width is left
		to DaisyUI's built-in clamp(3rem,20rem,100%) so it matches sibling inputs.
		The inner <input> gets outline-none so only the wrapper's focus ring is visible.
	-->
	<!-- Outer div acts as the compound input wrapper.
		 Mirrors layout.css's global :focus rule — border-color → transparent, outline → none,
		 inset box-shadow with --color-primary — applied via :focus-within since the div
		 itself is never directly focused (only the inner <input> is). -->
	<div
		class="input flex flex-wrap items-center gap-1 input-sm focus-within:border-transparent focus-within:[box-shadow:inset_0_0_0_2px_var(--color-primary,oklch(var(--p)))] focus-within:[outline:none]"
		style="height: auto; min-height: var(--size, 2rem); padding-block: 0.25rem;"
	>
		{#each values as tag, i (tag)}
			<span class="badge shrink-0 gap-1 text-xs badge-neutral">
				{tag}
				<button
					type="button"
					class="hover:text-error"
					onclick={() => remove(i)}
					aria-label="Remove {tag}"
				>
					<X class="h-3 w-3" />
				</button>
			</span>
		{/each}
		<!-- outline suppressed via inline style so browser UA and DaisyUI's :where rule
		     both lose to the highest-specificity rule, leaving only the outer ring visible. -->
		<input
			type="text"
			class="min-w-24 flex-1 bg-transparent text-sm"
			style="height: auto; width: auto; outline: none;"
			{placeholder}
			bind:value={input}
			onkeydown={handleKeydown}
			onblur={add}
		/>
	</div>

	{#if hint}
		<p class="mt-1 text-xs text-base-content/60">{hint}</p>
	{/if}
</div>
