<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import type {
		FormatCondition,
		FormatCategory,
		UICustomFormat,
		CustomFormatFormData
	} from '#lib/types/format.js';
	import { FORMAT_CATEGORY_LABELS, FORMAT_CATEGORY_ORDER } from '#lib/types/format.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import FormatConditionBuilder from './FormatConditionBuilder.svelte';
	import { X, Save, Loader2, FlaskConical, Check, AlertTriangle, Info } from '@lucide/svelte';
	import { testCustomFormat } from '#lib/api/indexers.js';

	interface Props {
		open: boolean;
		mode: 'add' | 'edit' | 'view';
		format?: UICustomFormat | null;
		saving?: boolean;
		error?: string | null;
		onClose: () => void;
		onSave: (data: CustomFormatFormData) => void;
	}

	let {
		open,
		mode,
		format = null,
		saving = false,
		error = null,
		onClose,
		onSave
	}: Props = $props();

	// Form state
	let name = $state('');
	let description = $state('');
	let category = $state<FormatCategory>('other');
	let tagsInput = $state('');
	let conditions = $state<FormatCondition[]>([]);
	let enabled = $state(true);

	// Test state
	let testReleaseName = $state('');
	let testResult = $state<{ matched: boolean; details?: string } | null>(null);
	let testing = $state(false);

	// Initialize form when format changes
	$effect(() => {
		if (open) {
			if (format) {
				name = format.name;
				description = format.description || '';
				category = format.category;
				tagsInput = format.tags.join(', ');
				conditions = [...format.conditions];
				enabled = format.enabled;
			} else {
				// Reset form for new format
				name = '';
				description = '';
				category = 'other';
				tagsInput = '';
				conditions = [];
				enabled = true;
			}
			testReleaseName = '';
			testResult = null;
		}
	});

	function handleSave() {
		const tags = tagsInput
			.split(',')
			.map((t) => t.trim())
			.filter((t) => t.length > 0);

		onSave({
			name,
			description: description || undefined,
			category,
			tags,
			conditions,
			enabled
		});
	}

	function handleConditionsUpdate(newConditions: FormatCondition[]) {
		conditions = newConditions;
	}

	async function testFormat() {
		if (!testReleaseName.trim()) return;

		testing = true;
		testResult = null;

		try {
			const data = await testCustomFormat({
				releaseName: testReleaseName,
				conditions
			});

			testResult = {
				matched: data.matched,
				details: data.matched
					? `Matched ${data.matchedConditions}/${data.totalConditions} conditions`
					: `Did not match. ${data.failedConditions} required conditions failed.`
			};
		} catch {
			testResult = { matched: false, details: 'Test request failed' };
		} finally {
			testing = false;
		}
	}

	const isReadonly = $derived(mode === 'view' || (format?.isBuiltIn ?? false));
	const modalTitle = $derived(
		mode === 'add'
			? m.formats_createCustomFormat()
			: format?.isBuiltIn
				? m.formats_viewFormat()
				: m.formats_editFormat()
	);
</script>

<ModalWrapper {open} {onClose} maxWidth="2xl" labelledBy="custom-format-modal-title">
	<!-- Header -->
	<div class="mb-6 flex items-center justify-between">
		<h3 id="custom-format-modal-title" class="text-xl font-bold">{modalTitle}</h3>
		<button type="button" class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
			<X class="h-4 w-4" />
		</button>
	</div>

	{#if error}
		<div class="mb-4 alert alert-error">
			<span>{error}</span>
		</div>
	{/if}

	{#if format?.isBuiltIn}
		<div class="mb-4 alert alert-info">
			<span>{m.formats_builtinReadOnly()}</span>
		</div>
	{/if}

	<div class="space-y-4">
		<!-- Basic Info -->
		<div class="grid gap-4 sm:grid-cols-2">
			<!-- Name -->
			<div class="form-control">
				<label class="label" for="format-name">
					<span class="label-text">{m.formats_nameLabel()}</span>
				</label>
				<input
					id="format-name"
					type="text"
					class="input-bordered input input-sm"
					bind:value={name}
					disabled={isReadonly}
					placeholder={m.formats_namePlaceholder()}
				/>
			</div>

			<!-- Category -->
			<div class="form-control">
				<label class="label" for="format-category">
					<span class="label-text">{m.formats_categoryLabel()}</span>
				</label>
				<select
					id="format-category"
					class="select-bordered select select-sm"
					bind:value={category}
					disabled={isReadonly}
				>
					{#each FORMAT_CATEGORY_ORDER as cat (cat)}
						<option value={cat}>{FORMAT_CATEGORY_LABELS[cat]}</option>
					{/each}
				</select>
			</div>
		</div>

		<!-- Description -->
		<div class="form-control">
			<label class="label" for="format-description">
				<span class="label-text">{m.formats_descriptionLabel()}</span>
			</label>
			<textarea
				id="format-description"
				class="textarea-bordered textarea h-16 textarea-sm"
				bind:value={description}
				disabled={isReadonly}
				placeholder={m.formats_descriptionPlaceholder()}></textarea>
		</div>

		<!-- Tags -->
		<div class="form-control">
			<label class="label" for="format-tags">
				<span class="label-text">{m.formats_tagsLabel()}</span>
			</label>
			<input
				id="format-tags"
				type="text"
				class="input-bordered input input-sm"
				bind:value={tagsInput}
				disabled={isReadonly}
				placeholder={m.formats_tagsPlaceholder()}
			/>
		</div>

		<!-- Score info -->
		<div class="alert bg-base-200 text-sm">
			<Info class="h-4 w-4" />
			<span>
				{m.formats_scoreInfo()}
			</span>
		</div>

		<!-- Enabled toggle -->
		{#if !format?.isBuiltIn}
			<div class="form-control">
				<label class="label cursor-pointer justify-start gap-4">
					<input
						type="checkbox"
						class="toggle toggle-primary"
						bind:checked={enabled}
						disabled={isReadonly}
					/>
					<div class="min-w-0">
						<span class="label-text">{m.formats_enabledLabel()}</span>
						<p class="text-xs text-base-content/60">{m.formats_enabledHint()}</p>
					</div>
				</label>
			</div>
		{/if}

		<!-- Conditions -->
		<div class="divider">{m.formats_conditionsDivider()}</div>

		<FormatConditionBuilder {conditions} readonly={isReadonly} onUpdate={handleConditionsUpdate} />

		<!-- Test Section -->
		<div class="divider">{m.formats_testDivider()}</div>

		<div class="rounded-lg bg-base-200 p-4">
			<p class="mb-3 text-sm text-base-content/70">
				{m.formats_testDescription()}
			</p>

			<div class="flex gap-2">
				<input
					type="text"
					class="input-bordered input flex-1 font-mono input-sm"
					bind:value={testReleaseName}
					placeholder={m.formats_testPlaceholder()}
				/>
				<button
					type="button"
					class="btn gap-1 btn-secondary btn-sm"
					onclick={testFormat}
					disabled={testing || conditions.length === 0}
				>
					{#if testing}
						<Loader2 class="h-4 w-4 animate-spin" />
					{:else}
						<FlaskConical class="h-4 w-4" />
					{/if}
					{m.formats_testButton()}
				</button>
			</div>

			{#if testResult}
				<div
					class="mt-3 flex items-center gap-2 text-sm"
					class:text-success={testResult.matched}
					class:text-warning={!testResult.matched}
				>
					{#if testResult.matched}
						<Check class="h-4 w-4" />
					{:else}
						<AlertTriangle class="h-4 w-4" />
					{/if}
					<span>{testResult.matched ? m.formats_testMatched() : m.formats_testNotMatched()}</span>
					{#if testResult.details}
						<span class="text-base-content/60">- {testResult.details}</span>
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<!-- Footer -->
	<div class="modal-action mt-6 border-t border-base-300 pt-4">
		<button type="button" class="btn btn-ghost" onclick={onClose}>
			{isReadonly ? 'Close' : 'Cancel'}
		</button>
		{#if !isReadonly}
			<button
				type="button"
				class="btn gap-2 btn-primary"
				onclick={handleSave}
				disabled={saving || !name || conditions.length === 0}
			>
				{#if saving}
					<Loader2 class="h-4 w-4 animate-spin" />
				{:else}
					<Save class="h-4 w-4" />
				{/if}
				Save
			</button>
		{/if}
	</div>
</ModalWrapper>
