<script lang="ts">
	import type { ScoringProfile } from '#lib/types/profile.js';
	import { Settings, Trash2, Lock, Star, Check, Film, Tv, Sliders } from '@lucide/svelte';
	import { toNullableNumber } from '#lib/utils/number.js';

	interface Props {
		profiles: ScoringProfile[];
		onEdit: (profile: ScoringProfile) => void;
		onDelete: (profile: ScoringProfile) => void;
		onSetDefault: (profile: ScoringProfile) => void;
	}

	let { profiles, onEdit, onDelete, onSetDefault }: Props = $props();

	// Format size limit display
	function formatMovieSize(profile: ScoringProfile): string {
		if (profile.id === 'streamer') return 'Auto';
		const min = toNullableNumber(profile.movieMinSizeGb);
		const max = toNullableNumber(profile.movieMaxSizeGb);
		const formatValue = (value: number) => {
			if (value < 1) {
				const mb = value * 1024;
				const label = Number.isInteger(mb) ? mb.toString() : mb.toFixed(0);
				return `${label} MB`;
			}
			const label = Number.isInteger(value) ? value.toString() : value.toFixed(1);
			return `${label} GB`;
		};

		if (min !== null && max !== null) {
			const minLabel = formatValue(min);
			const maxLabel = formatValue(max);
			const sameUnit = (min < 1 && max < 1) || (min >= 1 && max >= 1);

			if (sameUnit) {
				const unit = min < 1 ? 'MB' : 'GB';
				const minValue = min < 1 ? min * 1024 : min;
				const maxValue = max < 1 ? max * 1024 : max;
				const minText = Number.isInteger(minValue)
					? minValue.toString()
					: unit === 'MB'
						? minValue.toFixed(0)
						: minValue.toFixed(1);
				const maxText = Number.isInteger(maxValue)
					? maxValue.toString()
					: unit === 'MB'
						? maxValue.toFixed(0)
						: maxValue.toFixed(1);
				return `${minText} ${unit} - ${maxText} ${unit}`;
			}

			return `${minLabel} - ${maxLabel}`;
		}
		if (min !== null) return `${formatValue(min)}+`;
		if (max !== null) return `< ${formatValue(max)}`;
		return '-';
	}

	function formatEpisodeSize(profile: ScoringProfile): string {
		if (profile.id === 'streamer') return 'Auto';
		const min = toNullableNumber(profile.episodeMinSizeMb);
		const max = toNullableNumber(profile.episodeMaxSizeMb);
		const formatValue = (value: number) => {
			if (value >= 1024) {
				const gb = value / 1024;
				const label = Number.isInteger(gb) ? gb.toString() : gb.toFixed(1);
				return `${label} GB`;
			}
			const label = Number.isInteger(value) ? value.toString() : value.toFixed(0);
			return `${label} MB`;
		};

		if (min !== null && max !== null) {
			const minLabel = formatValue(min);
			const maxLabel = formatValue(max);
			const sameUnit = (min < 1024 && max < 1024) || (min >= 1024 && max >= 1024);

			if (sameUnit) {
				const unit = min < 1024 ? 'MB' : 'GB';
				const minValue = min < 1024 ? min : min / 1024;
				const maxValue = max < 1024 ? max : max / 1024;
				const minText = Number.isInteger(minValue) ? minValue.toString() : minValue.toFixed(1);
				const maxText = Number.isInteger(maxValue) ? maxValue.toString() : maxValue.toFixed(1);
				return `${minText} ${unit} - ${maxText} ${unit}`;
			}

			return `${minLabel} - ${maxLabel}`;
		}
		if (min !== null) return `${formatValue(min)}+`;
		if (max !== null) return `< ${formatValue(max)}`;
		return '-';
	}
</script>

{#if profiles.length === 0}
	<div class="py-12 text-center text-base-content/60">
		<Sliders class="mx-auto mb-4 h-12 w-12 opacity-40" />
		<p class="text-lg font-medium">No profiles configured</p>
		<p class="mt-1 text-sm">Add a profile to manage quality preferences</p>
	</div>
{:else}
	<div class="space-y-3 sm:hidden">
		{#each profiles as profile (profile.id)}
			<div class="card border border-base-300/60 bg-base-200/40">
				<div class="card-body gap-3 p-4">
					<div class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
						<div class="flex min-w-0 items-start gap-3">
							<div class="mt-0.5 h-4 w-4 flex-none">
								{#if profile.isBuiltIn}
									<Lock class="h-4 w-4 text-base-content/40" />
								{:else}
									<Settings class="h-4 w-4 text-base-content/40" />
								{/if}
							</div>
							<div class="min-w-0">
								<div class="font-bold">{profile.name}</div>
								{#if profile.description}
									<div class="mt-0.5 text-sm wrap-break-word whitespace-normal opacity-50">
										{profile.description}
									</div>
								{/if}
							</div>
						</div>
						<div class="flex min-w-18 shrink-0 items-start justify-end gap-1">
							{#if profile.id !== 'streamer'}
								<button
									class="btn h-8 w-8 min-w-8 btn-ghost p-0 btn-xs"
									onclick={() => onEdit(profile)}
									title="Edit"
								>
									<Settings class="h-4 w-4 flex-none" />
								</button>
							{/if}
							{#if !profile.isBuiltIn}
								<button
									class="btn h-8 w-8 min-w-8 btn-ghost p-0 text-error btn-xs"
									onclick={() => onDelete(profile)}
									title="Delete"
								>
									<Trash2 class="h-4 w-4 flex-none" />
								</button>
							{/if}
						</div>
					</div>

					<div class="flex flex-wrap items-center gap-2">
						<span class="badge {profile.isBuiltIn ? 'badge-ghost' : 'badge-outline badge-primary'}">
							{profile.isBuiltIn ? 'Built-in' : 'Custom'}
						</span>
						{#if profile.isDefault}
							<span class="badge gap-1 badge-success">
								<Check class="h-3 w-3" />
								Default
							</span>
						{/if}
					</div>

					<div class="grid grid-cols-2 gap-3 text-sm">
						<div>
							<div class="text-xs tracking-wide text-base-content/50 uppercase">Movie Size</div>
							<div class="font-mono">{formatMovieSize(profile)}</div>
						</div>
						<div>
							<div class="text-xs tracking-wide text-base-content/50 uppercase">Episode Size</div>
							<div class="font-mono">{formatEpisodeSize(profile)}</div>
						</div>
					</div>

					{#if !profile.isDefault}
						<button
							class="btn w-fit btn-ghost btn-xs"
							onclick={() => onSetDefault(profile)}
							title="Set as default"
						>
							<Star class="h-3.5 w-3.5" />
							Set as default
						</button>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	<div class="hidden overflow-x-auto sm:block">
		<table class="table">
			<thead>
				<tr>
					<th class="w-[40%]">Name</th>
					<th>Type</th>
					<th>
						<div class="flex items-center gap-1">
							<Film class="h-3.5 w-3.5" />
							Movie Size
						</div>
					</th>
					<th>
						<div class="flex items-center gap-1">
							<Tv class="h-3.5 w-3.5" />
							Episode Size
						</div>
					</th>
					<th>Default</th>
					<th class="text-right">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each profiles as profile (profile.id)}
					<tr class="hover">
						<td class="w-[40%]">
							<div class="flex items-center gap-3">
								{#if profile.isBuiltIn}
									<Lock class="h-4 w-4 text-base-content/40" />
								{:else}
									<Settings class="h-4 w-4 text-base-content/40" />
								{/if}
								<div>
									<div class="font-bold">{profile.name}</div>
									{#if profile.description}
										<div class="max-w-[70ch] text-sm wrap-break-word whitespace-normal opacity-50">
											{profile.description}
										</div>
									{/if}
								</div>
							</div>
						</td>
						<td>
							<span
								class="badge {profile.isBuiltIn ? 'badge-ghost' : 'badge-outline badge-primary'}"
							>
								{profile.isBuiltIn ? 'Built-in' : 'Custom'}
							</span>
						</td>
						<td>
							<span class="font-mono text-sm">{formatMovieSize(profile)}</span>
						</td>
						<td>
							<span class="font-mono text-sm">{formatEpisodeSize(profile)}</span>
						</td>
						<td>
							{#if profile.isDefault}
								<span class="badge gap-1 badge-success">
									<Check class="h-3 w-3" />
									Yes
								</span>
							{:else}
								<button
									class="btn btn-ghost btn-xs"
									onclick={() => onSetDefault(profile)}
									title="Set as default"
								>
									<Star class="h-3.5 w-3.5" />
								</button>
							{/if}
						</td>
						<td>
							<div class="flex justify-end gap-1">
								{#if profile.id !== 'streamer'}
									<button class="btn btn-ghost btn-sm" onclick={() => onEdit(profile)} title="Edit">
										<Settings class="h-4 w-4" />
									</button>
								{/if}
								{#if !profile.isBuiltIn}
									<button
										class="btn btn-ghost text-error btn-sm"
										onclick={() => onDelete(profile)}
										title="Delete"
									>
										<Trash2 class="h-4 w-4" />
									</button>
								{/if}
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
