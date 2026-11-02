<script lang="ts">
	/**
	 * Subtitle requirements section for media details pages (movie/series/
	 * episode). Renders the item's EFFECTIVE subtitle requirements with live
	 * per-row status and, when editable, add/remove/reorder controls that
	 * persist a per-item override (null = reset to inherited).
	 *
	 * The requirement list is the only thing this edits — audio preference,
	 * minimum score, and upgrade policy still come from the language profile
	 * chain (spec: per-item language customization, 2026-09-14).
	 */
	import { untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { requirementKey, type SubtitleRequirement } from '#lib/shared/language-profile.js';
	import { ALL_LANGUAGE_OPTIONS, getLanguageName } from '#lib/shared/languages.js';

	interface Props {
		/** Effective requirements in force (override or profile chain). */
		requirements: SubtitleRequirement[];
		/** requirementKeys of requirements NOT currently satisfied on disk. */
		missingKeys?: string[];
		/** Where the effective list came from ('movie'|'series'|'episode'|'library'|'default'). */
		source?: string | null;
		/** Name of the governing profile (for the inherited label). */
		profileName?: string | null;
		/** True when probed audio languages contradict the effective audio
		 * preference (import verifier, phase D) — renders a warning badge. */
		audioShortfall?: boolean;
		editable?: boolean;
		saving?: boolean;
		/** Persist the list; called with null to clear the override. */
		onSave?: (requirements: SubtitleRequirement[] | null) => Promise<void> | void;
		/** Fire a targeted search for one requirement row. */
		onSearch?: (requirement: SubtitleRequirement) => void;
	}

	let {
		requirements,
		missingKeys = [],
		source = null,
		profileName = null,
		audioShortfall = false,
		editable = false,
		saving = false,
		onSave,
		onSearch
	}: Props = $props();

	const VARIANT_OPTIONS = ['regular', 'forced', 'both'] as const;
	const ACCESSIBILITY_OPTIONS = ['any', 'prefer-hi', 'require-hi', 'exclude-hi'] as const;

	// Working copy for editing; initialized from props so SSR renders the
	// requirement rows ($effect below never runs server-side).
	let list = $state<SubtitleRequirement[]>(
		untrack(() => requirements.map((requirement) => ({ ...requirement })))
	);
	let dirty = $state(false);

	$effect(() => {
		// Re-sync the working copy whenever the server-provided list changes
		// (after save or prop refresh) — but never clobber in-flight edits.
		// Reads `requirements` so prop changes re-run this effect.
		void requirements;
		if (!dirty) {
			list = requirements.map((requirement) => ({ ...requirement }));
		}
	});

	let canSave = $derived(list.length > 0 && list.length <= 10);
	let isCustomized = $derived(source === 'movie' || source === 'series' || source === 'episode');

	function addRequirement() {
		dirty = true;
		list.push({ tag: 'en', variant: 'regular', accessibility: 'any' });
	}

	function removeRequirement(index: number) {
		dirty = true;
		list.splice(index, 1);
	}

	function move(index: number, delta: -1 | 1) {
		const target = index + delta;
		if (target < 0 || target >= list.length) return;
		dirty = true;
		const [item] = list.splice(index, 1);
		list.splice(target, 0, item);
	}

	async function save() {
		if (!onSave || !canSave) return;
		await onSave(list.map((requirement) => ({ ...requirement })));
		dirty = false;
	}

	async function reset() {
		if (!onSave) return;
		await onSave(null);
		dirty = false;
	}

	function isMissing(requirement: SubtitleRequirement): boolean {
		return missingKeys.includes(requirementKey(requirement));
	}
</script>

<section class="rounded-box border border-base-300 bg-base-100 p-4">
	<div class="mb-2 flex items-center justify-between gap-2">
		<h3 class="text-sm font-semibold">{m.library_subtitleRequirements_title()}</h3>
		{#if isCustomized}
			<span class="badge badge-sm badge-primary">{m.library_subtitleRequirements_customized()}</span
			>
		{:else if profileName}
			<span class="badge badge-ghost badge-sm">{profileName}</span>
		{/if}
		{#if audioShortfall}
			<span class="badge badge-sm badge-warning" title={m.library_audioShortfall_title()}>
				{m.library_audioShortfall_badge()}
			</span>
		{/if}
	</div>

	{#if editable}
		<p class="mb-3 text-xs text-base-content/60">{m.library_subtitleRequirements_help()}</p>
	{/if}

	<ul class="flex flex-col gap-1.5">
		{#each list as requirement, index (requirementKey(requirement) + index)}
			<li class="flex flex-wrap items-center gap-2 rounded-lg bg-base-200/50 px-2.5 py-1.5">
				<span
					class="badge badge-sm {isMissing(requirement) ? 'badge-warning' : 'badge-success'}"
					title={isMissing(requirement)
						? m.library_subtitleRequirements_missing()
						: m.library_subtitleRequirements_met()}
				>
					{isMissing(requirement)
						? m.library_subtitleRequirements_missing()
						: m.library_subtitleRequirements_met()}
				</span>

				{#if editable}
					<select
						class="select-bordered select w-36 select-xs"
						bind:value={requirement.tag}
						onchange={() => (dirty = true)}
						aria-label={getLanguageName(requirement.tag)}
					>
						{#each ALL_LANGUAGE_OPTIONS as option (option.code)}
							<option value={option.code}>{option.name}</option>
						{/each}
					</select>
					<select
						class="select-bordered select select-xs"
						bind:value={requirement.variant}
						onchange={() => (dirty = true)}
						aria-label={m.library_subtitleRequirements_variant()}
					>
						{#each VARIANT_OPTIONS as variant (variant)}
							<option value={variant}>{variant}</option>
						{/each}
					</select>
					<select
						class="select-bordered select select-xs"
						bind:value={requirement.accessibility}
						onchange={() => (dirty = true)}
						aria-label={m.library_subtitleRequirements_accessibility()}
					>
						{#each ACCESSIBILITY_OPTIONS as accessibility (accessibility)}
							<option value={accessibility}>{accessibility}</option>
						{/each}
					</select>
					<button
						type="button"
						class="btn btn-ghost btn-xs"
						disabled={index === 0}
						onclick={() => move(index, -1)}
						aria-label={m.library_subtitleRequirements_moveUp()}
					>
						↑
					</button>
					<button
						type="button"
						class="btn btn-ghost btn-xs"
						disabled={index === list.length - 1}
						onclick={() => move(index, 1)}
						aria-label={m.library_subtitleRequirements_moveDown()}
					>
						↓
					</button>
					<button
						type="button"
						class="btn btn-ghost text-error btn-xs"
						disabled={list.length <= 1}
						onclick={() => removeRequirement(index)}
						aria-label={m.library_subtitleRequirements_remove()}
					>
						✕
					</button>
					{#if onSearch}
						<button
							type="button"
							class="btn btn-ghost btn-xs"
							onclick={() => onSearch(requirement)}
							title={m.library_subtitleRequirements_searchRow()}
						>
							⌕
						</button>
					{/if}
				{:else}
					<span class="text-sm">
						{getLanguageName(requirement.tag)}
						<span class="text-base-content/50">
							· {requirement.variant}
							{#if requirement.accessibility !== 'any'}· {requirement.accessibility}{/if}
						</span>
					</span>
				{/if}
			</li>
		{/each}
	</ul>

	{#if editable && onSave}
		<div class="mt-3 flex items-center gap-2">
			<button type="button" class="btn btn-ghost btn-xs" onclick={addRequirement}>
				+ {m.library_subtitleRequirements_add()}
			</button>
			{#if isCustomized}
				<button type="button" class="btn btn-ghost btn-xs" disabled={saving} onclick={reset}>
					{m.library_subtitleRequirements_reset()}
				</button>
			{/if}
			{#if dirty}
				<button
					type="button"
					class="btn btn-primary btn-xs"
					disabled={!canSave || saving}
					onclick={save}
				>
					{#if saving}
						<span class="loading loading-xs loading-spinner"></span>
					{/if}
					{m.library_subtitleRequirements_save()}
				</button>
			{/if}
		</div>
	{/if}
</section>
