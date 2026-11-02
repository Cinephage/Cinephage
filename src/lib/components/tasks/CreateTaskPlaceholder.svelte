<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen, onClose }: Props = $props();
</script>

<ModalWrapper open={isOpen} {onClose} maxWidth="lg" labelledBy="create-custom-task-modal-title">
	<div>
		<div class="mb-4 flex items-center justify-between">
			<h3 id="create-custom-task-modal-title" class="text-lg font-bold">
				{m.task_createModal_title()}
			</h3>
			<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>✕</button>
		</div>

		<div class="py-6 text-center">
			<div
				class="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-primary/10"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="32"
					height="32"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="text-primary"
				>
					<circle cx="12" cy="12" r="10" />
					<line x1="12" y1="8" x2="12" y2="16" />
					<line x1="8" y1="12" x2="16" y2="12" />
				</svg>
			</div>

			<h4 class="mb-2 text-xl font-semibold">{m.task_createModal_comingSoon()}</h4>
			<p class="mb-6 text-base-content/70">{m.task_createModal_description()}</p>

			<ul class="mx-auto mb-6 max-w-xs space-y-2 text-left text-sm">
				<li class="flex items-start gap-2">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="mt-0.5 shrink-0 text-success"
					>
						<polyline points="20 6 9 17 4 12" />
					</svg>
					<span>{m.task_createModal_feature_schedules()}</span>
				</li>
				<li class="flex items-start gap-2">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="mt-0.5 shrink-0 text-success"
					>
						<polyline points="20 6 9 17 4 12" />
					</svg>
					<span>{m.task_createModal_feature_filters()}</span>
				</li>
				<li class="flex items-start gap-2">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="mt-0.5 shrink-0 text-success"
					>
						<polyline points="20 6 9 17 4 12" />
					</svg>
					<span>{m.task_createModal_feature_chains()}</span>
				</li>
				<li class="flex items-start gap-2">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						class="mt-0.5 shrink-0 text-success"
					>
						<polyline points="20 6 9 17 4 12" />
					</svg>
					<span>{m.task_createModal_feature_logic()}</span>
				</li>
			</ul>

			<div class="text-sm text-base-content/50">{m.task_createModal_stayTuned()}</div>
		</div>

		<div class="modal-action">
			<button class="btn btn-primary" onclick={onClose}>{m.task_createModal_gotIt()}</button>
		</div>
	</div>
</ModalWrapper>
