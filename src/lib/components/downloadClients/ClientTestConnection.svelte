<script lang="ts">
	import { Loader2, XCircle } from '@lucide/svelte';
	import { TestResult } from '#lib/components/ui/modal/index.js';
	import type { ConnectionTestResult } from '#lib/types/downloadClient.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		testing: boolean;
		testResult: ConnectionTestResult | null;
		saving: boolean;
		error: string | null;
		isFormValid: boolean;
		mode: 'add' | 'edit';
		onTest: () => void;
		onSave: () => void;
		onClose: () => void;
		onDelete?: () => void;
	}

	let {
		testing,
		testResult = null,
		saving,
		error = null,
		isFormValid,
		mode,
		onTest,
		onSave,
		onClose,
		onDelete
	}: Props = $props();

	const successDetails = $derived(
		testResult?.greeting
			? `Server greeting: ${testResult.greeting}`
			: testResult?.details
				? `Version: ${testResult.details.version} (API ${testResult.details.apiVersion})${testResult.details.savePath ? ` | Save Path: ${testResult.details.savePath}` : ''}`
				: undefined
	);
</script>

{#if error}
	<div class="mt-6 alert alert-error">
		<XCircle class="h-5 w-5" />
		<div>
			<div class="font-medium">{m.common_failedToSave()}</div>
			<div class="text-sm opacity-80">{error}</div>
		</div>
	</div>
{/if}

<TestResult result={testResult} {successDetails} />

<div class="modal-action">
	{#if mode === 'edit' && onDelete}
		<button class="btn mr-auto btn-outline btn-error" onclick={onDelete}>{m.common_delete()}</button
		>
	{/if}

	<button class="btn btn-ghost" onclick={onTest} disabled={testing || saving || !isFormValid}>
		{#if testing}
			<Loader2 class="h-4 w-4 animate-spin" />
		{/if}
		{m.action_test()}
	</button>

	<button class="btn btn-ghost" onclick={onClose}>{m.action_cancel()}</button>

	<button class="btn btn-primary" onclick={onSave} disabled={saving || testing || !isFormValid}>
		{#if saving}
			<Loader2 class="h-4 w-4 animate-spin" />
		{/if}
		{m.action_save()}
	</button>
</div>
