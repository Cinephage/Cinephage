<script lang="ts">
	import { CheckCircle2, XCircle } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface TestResultData {
		success: boolean;
		error?: string;
	}

	interface Props {
		result: TestResultData | null;
		successMessage?: string;
		successDetails?: string;
	}

	let { result, successMessage = m.ui_modal_testPassed(), successDetails }: Props = $props();
</script>

{#if result}
	<div class="mt-6 alert {result.success ? 'alert-success' : 'alert-error'}">
		{#if result.success}
			<CheckCircle2 class="h-5 w-5" />
			<div>
				<span class="font-medium">{successMessage}</span>
				{#if successDetails}
					<p class="text-sm opacity-80">{successDetails}</p>
				{/if}
			</div>
		{:else}
			<XCircle class="h-5 w-5" />
			<div>
				<span class="font-medium">{m.ui_modal_testFailed()}</span>
				{#if result.error}
					<p class="text-sm opacity-80">{result.error}</p>
				{/if}
			</div>
		{/if}
	</div>
{/if}
