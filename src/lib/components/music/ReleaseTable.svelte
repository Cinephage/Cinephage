<script lang="ts" generics="T extends ReleaseRow">
	/**
	 * One release table for every place a music release is chosen: the album
	 * page, the track search modal and the artist discography modal. The three
	 * used to be copies that drifted (one had no icon, one had a different row
	 * hover); the columns, quality label and grab button live here once.
	 */
	import { Download, LoaderCircle } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { musicQualityLabel } from './release-quality.js';
	import type { ReleaseRow } from './release-row.js';

	interface Props {
		rows: T[];
		grabbing: string | null;
		onGrab: (row: T) => void;
		containerClass?: string;
	}

	let { rows, grabbing, onGrab, containerClass = 'bg-base-200' }: Props = $props();

	function gib(bytes: number | null): string {
		if (!bytes) return '–';
		return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
	}
</script>

<div class="overflow-hidden rounded-lg {containerClass}">
	<table class="table table-sm">
		<thead>
			<tr class="border-base-content/10 bg-base-200/40">
				<th>{m.music_titleHeader()}</th>
				<th class="w-32">{m.music_indexer()}</th>
				<th class="w-24 text-right">{m.music_size()}</th>
				<th class="w-32">{m.music_quality()}</th>
				<th class="w-20 text-right">{m.music_seeders()}</th>
				<th class="w-16"><span class="sr-only">{m.common_actions()}</span></th>
			</tr>
		</thead>
		<tbody>
			{#each rows as candidate (candidate.title + (candidate.indexerName ?? ''))}
				<tr class="border-base-content/5 hover:bg-base-200/40">
					<td class="max-w-0 truncate" title={candidate.title}>
						<span class="font-medium">{candidate.title}</span>
						{#if candidate.accepted === false && candidate.reasons?.length}
							<span class="ml-2 text-xs text-warning">{candidate.reasons[0]}</span>
						{/if}
					</td>
					<td class="text-xs text-base-content/55">{candidate.indexerName ?? '–'}</td>
					<td class="text-right font-mono text-xs text-base-content/60 tabular-nums">
						{gib(candidate.size)}
					</td>
					<td class="whitespace-nowrap">
						<span
							class="badge badge-sm whitespace-nowrap"
							class:badge-ghost={candidate.accepted === false}
						>
							{musicQualityLabel(candidate)}
						</span>
					</td>
					<td class="text-right tabular-nums">{candidate.seeders ?? '–'}</td>
					<td class="text-right">
						<button
							class="btn gap-1 btn-ghost btn-xs"
							disabled={grabbing !== null}
							title={candidate.accepted === false
								? (candidate.reasons?.[0] ?? m.music_grabFailed())
								: (candidate.tierLabel ?? '')}
							onclick={() => onGrab(candidate)}
						>
							{#if grabbing === candidate.guid}
								<LoaderCircle class="h-3 w-3 animate-spin" />
							{:else}
								<Download class="h-3 w-3" />
							{/if}
							{m.music_grab()}
						</button>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
