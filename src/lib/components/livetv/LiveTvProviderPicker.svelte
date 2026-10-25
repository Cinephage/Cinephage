<script lang="ts">
	import { Tv, Radio, List } from '@lucide/svelte';
	import { providerDefinitions } from './providerDefinitions';
	import type { LiveTvProviderType } from '#lib/types/livetv.js';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		onSelect: (providerType: LiveTvProviderType) => void;
		onCancel: () => void;
	}

	let { onSelect, onCancel }: Props = $props();
</script>

<div class="space-y-4">
	<p class="text-base-content/70">{m.livetv_providerPicker_heading()}</p>

	<div class="space-y-2">
		{#each providerDefinitions as provider (provider.id)}
			<button
				type="button"
				class="card w-full cursor-pointer border-2 border-transparent bg-base-200 text-left transition-all hover:border-primary hover:bg-primary/5"
				onclick={() => onSelect(provider.id)}
			>
				<div class="card-body p-4">
					<div class="flex items-start gap-4">
						<div class="rounded-lg bg-primary/10 p-3">
							{#if provider.icon === 'Tv'}
								<Tv class="h-6 w-6 text-primary" />
							{:else if provider.icon === 'Radio'}
								<Radio class="h-6 w-6 text-primary" />
							{:else if provider.icon === 'List'}
								<List class="h-6 w-6 text-primary" />
							{/if}
						</div>
						<div class="flex-1">
							<div class="flex items-center gap-2">
								<h3 class="font-semibold">{provider.name}</h3>
								{#if provider.requiresAuth}
									<span class="badge badge-ghost badge-sm">{provider.authDescription}</span>
								{:else}
									<span class="badge badge-ghost badge-sm">{m.livetv_providerPicker_noAuth()}</span>
								{/if}
							</div>
							<p class="mt-1 text-sm text-base-content/60">{provider.description}</p>

							<!-- Features -->
							<div class="mt-2 flex flex-wrap gap-1">
								{#if provider.features.supportsEpg}
									<span class="badge badge-ghost badge-xs"
										>{m.livetv_providerPicker_epgBadge()}</span
									>
								{/if}
								{#if provider.features.supportsArchive}
									<span class="badge badge-ghost badge-xs"
										>{m.livetv_providerPicker_archiveBadge()}</span
									>
								{/if}
								{#if provider.features.supportsAutoRefresh}
									<span class="badge badge-ghost badge-xs"
										>{m.livetv_providerPicker_autoRefreshBadge()}</span
									>
								{/if}
							</div>
						</div>
					</div>
				</div>
			</button>
		{/each}
	</div>
</div>

<div class="modal-action">
	<button class="btn btn-ghost" onclick={onCancel}>Cancel</button>
</div>
