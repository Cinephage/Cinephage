<script lang="ts">
	import { RefreshCw } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { TokenPicker } from '#lib/components/naming/index.js';

	interface NamingToken {
		token: string;
		description: string;
		context?: string;
	}

	interface Props {
		validatingFormats: boolean;
		loadingPreviews: boolean;
		hasChanges: boolean;
		invalidFormatFields: string[];
		validationWarningFields: string[];
		formatFieldLabels: Record<string, string>;
		tokens: Record<string, NamingToken[]>;
		activeFieldId: string;
		activeContext: 'movie' | 'series' | 'general';
		onInsertToken: (token: string) => void;
	}

	let {
		validatingFormats,
		loadingPreviews,
		hasChanges,
		invalidFormatFields,
		validationWarningFields,
		formatFieldLabels,
		tokens,
		activeFieldId,
		activeContext,
		onInsertToken
	}: Props = $props();
</script>

<div class="space-y-4 lg:sticky lg:top-4">
	<!-- Review Outcome -->
	<div class="card bg-base-200">
		<div class="card-body p-4">
			<div class="flex items-center justify-between gap-3">
				<h2 class="card-title text-base">{m.settings_naming_reviewOutcome()}</h2>
				{#if validatingFormats}
					<div class="flex items-center gap-2 text-xs text-base-content/60">
						<RefreshCw class="h-3.5 w-3.5 animate-spin text-primary" />
						{m.settings_naming_validating()}
					</div>
				{/if}
			</div>
			<div class="mt-4 space-y-3 text-sm text-base-content/70">
				<div class="rounded-xl border border-base-300 bg-base-100 p-3">
					<p class="font-medium">{m.settings_naming_draftVsSaved()}</p>
					<p class="mt-1">
						{#if hasChanges}
							{m.settings_naming_draftChangesExist()}
						{:else}
							{m.settings_naming_draftAndSavedMatch()}
						{/if}
					</p>
				</div>
				<div class="rounded-xl border border-base-300 bg-base-100 p-3">
					<p class="font-medium">{m.settings_naming_formatValidation()}</p>
					{#if invalidFormatFields.length > 0}
						<ul class="mt-2 space-y-1 text-sm text-error">
							{#each invalidFormatFields as field (field)}
								<li>
									{m.settings_naming_hasSyntaxIssues({ field: formatFieldLabels[field] ?? field })}
								</li>
							{/each}
						</ul>
					{:else if validationWarningFields.length > 0}
						<ul class="mt-2 space-y-1 text-sm text-warning">
							{#each validationWarningFields as field (field)}
								<li>
									{m.settings_naming_hasWarnings({ field: formatFieldLabels[field] ?? field })}
								</li>
							{/each}
						</ul>
					{:else}
						<p class="mt-1">{m.settings_naming_allFieldsClean()}</p>
					{/if}
				</div>
				<div class="rounded-xl border border-base-300 bg-base-100 p-3">
					<p class="font-medium">{m.settings_naming_nextStep()}</p>
					<p class="mt-1">
						{m.settings_naming_nextStepDesc()}
					</p>
				</div>
			</div>
		</div>
	</div>

	<!-- Token Picker -->
	<div class="card bg-base-200">
		<div class="card-body p-4">
			<div class="mb-4 flex items-center justify-between gap-3">
				<h2 class="card-title text-base">{m.settings_naming_tokenBrowser()}</h2>
				{#if loadingPreviews}
					<div class="flex items-center gap-2 text-xs text-base-content/60">
						<RefreshCw class="h-3.5 w-3.5 animate-spin text-primary" />
						{m.settings_naming_updatingPreviews()}
					</div>
				{/if}
			</div>
			<TokenPicker {tokens} {activeFieldId} context={activeContext} onInsert={onInsertToken} />
		</div>
	</div>
</div>
