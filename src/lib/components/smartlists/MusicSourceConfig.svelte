<script lang="ts">
	import { ListMusic, Music, Radio } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';

	interface Props {
		/** The editor's whole source vocabulary; a music list uses the two music values. */
		sourceType: 'tmdb-discover' | 'external-json' | 'playlist' | 'musicbrainz-new-releases';
		url: string;
		trackLimit: number;
		releaseTypes: string[];
		lookbackDays: number;
		artistLimit: number;
	}

	let {
		sourceType = $bindable('playlist'),
		url = $bindable(''),
		trackLimit = $bindable(50),
		releaseTypes = $bindable(['Album', 'EP']),
		lookbackDays = $bindable(30),
		artistLimit = $bindable(30)
	}: Props = $props();

	const RELEASE_TYPES = ['Album', 'EP', 'Single', 'Other'];

	const musicSource = $derived(
		sourceType === 'musicbrainz-new-releases' ? 'musicbrainz-new-releases' : 'playlist'
	);

	function toggleReleaseType(type: string, checked: boolean) {
		releaseTypes = checked
			? [...new Set([...releaseTypes, type])]
			: releaseTypes.filter((value) => value !== type);
	}
</script>

<div class="rounded-lg border border-base-300 bg-base-100 p-4">
	<div class="mb-3 flex items-center gap-2 text-sm font-medium">
		<Music class="h-4 w-4 text-primary" />
		{m.smartlists_music_sourceTitle()}
	</div>

	<div class="join mb-4 w-full">
		<button
			class="btn join-item flex-1 btn-sm {musicSource === 'playlist' ? 'btn-active' : ''}"
			onclick={() => (sourceType = 'playlist')}
		>
			<ListMusic class="h-4 w-4" />
			{m.smartlists_music_playlist()}
		</button>
		<button
			class="btn join-item flex-1 btn-sm {musicSource === 'musicbrainz-new-releases'
				? 'btn-active'
				: ''}"
			onclick={() => (sourceType = 'musicbrainz-new-releases')}
		>
			<Radio class="h-4 w-4" />
			{m.smartlists_music_newReleases()}
		</button>
	</div>

	{#if musicSource === 'playlist'}
		<div class="space-y-3">
			<div class="form-control">
				<label class="label py-1" for="playlistUrl">
					<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
						>{m.smartlists_music_playlistUrl()}</span
					>
				</label>
				<input
					id="playlistUrl"
					type="url"
					bind:value={url}
					placeholder="https://open.spotify.com/playlist/…"
					class="input-bordered input w-full input-sm"
				/>
				<p class="mt-1 text-xs text-base-content/60">
					{m.smartlists_music_playlistHint()}
				</p>
			</div>

			<div class="form-control">
				<label class="label py-1" for="trackLimit">
					<span class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
						>{m.smartlists_music_trackLimit()}</span
					>
				</label>
				<input
					id="trackLimit"
					type="number"
					bind:value={trackLimit}
					min="1"
					max="200"
					class="input-bordered input w-full input-sm"
				/>
			</div>
		</div>
	{:else}
		<div class="space-y-3">
			<div class="form-control">
				<span
					class="label-text mb-1 text-xs font-medium tracking-wide text-base-content/60 uppercase"
					>{m.smartlists_music_releaseTypes()}</span
				>
				<div class="flex flex-wrap gap-3">
					{#each RELEASE_TYPES as type (type)}
						<label class="flex cursor-pointer items-center gap-2 text-sm">
							<input
								type="checkbox"
								class="checkbox checkbox-sm checkbox-primary"
								checked={releaseTypes.includes(type)}
								onchange={(event) => toggleReleaseType(type, event.currentTarget.checked)}
							/>
							{type}
						</label>
					{/each}
				</div>
			</div>

			<div class="grid grid-cols-2 gap-3">
				<div class="form-control">
					<label class="label py-1" for="lookbackDays">
						<span
							class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
							>{m.smartlists_music_lookback()}</span
						>
					</label>
					<input
						id="lookbackDays"
						type="number"
						bind:value={lookbackDays}
						min="1"
						max="365"
						class="input-bordered input w-full input-sm"
					/>
				</div>
				<div class="form-control">
					<label class="label py-1" for="artistLimit">
						<span
							class="label-text text-xs font-medium tracking-wide text-base-content/60 uppercase"
							>{m.smartlists_music_artistLimit()}</span
						>
					</label>
					<input
						id="artistLimit"
						type="number"
						bind:value={artistLimit}
						min="1"
						max="100"
						class="input-bordered input w-full input-sm"
					/>
				</div>
			</div>
			<p class="text-xs text-base-content/60">
				{m.smartlists_music_newReleasesHint()}
			</p>
		</div>
	{/if}
</div>
