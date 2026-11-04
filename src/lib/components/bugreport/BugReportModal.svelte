<script lang="ts">
	import { ModalHeader, ModalWrapper } from '#lib/components/ui/modal/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { bugReport } from '#lib/stores/bug-report.svelte.js';
	import BugReportForm from './BugReportForm.svelte';
</script>

<ModalWrapper
	open={bugReport.open}
	onClose={bugReport.close}
	maxWidth="3xl"
	flexContent={true}
	labelledBy="bug-report-modal-title"
>
	<div class="flex min-h-0 flex-col">
		<ModalHeader title={m.bugreport_title()} onClose={bugReport.close} />
		{#key bugReport.supportId}
			<div class="min-h-0 flex-1 overflow-y-auto pr-1">
				<BugReportForm initialSupportId={bugReport.supportId} />
			</div>
		{/key}
	</div>
</ModalWrapper>
