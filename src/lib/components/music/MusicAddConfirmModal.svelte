<script lang="ts">
	import { onMount } from 'svelte';
	import { Disc3, User } from '@lucide/svelte';
	import * as m from '#lib/paraglide/messages.js';
	import { ModalWrapper } from '#lib/components/ui/modal/index.js';

	type Props = {
		open: boolean;
		kind: 'album' | 'artist';
		title: string;
		subtitle?: string | null;
		/** Receives the chosen profile id, or null for "follow the library/default". */
		onAdd: (profileId: string | null) => void;
		onClose: () => void;
	};

	let { open, kind, title, subtitle = null, onAdd, onClose }: Props = $props();

	let profiles = $state<Array<{ id: string; name: string }>>([]);
	let defaultProfileName = $state<string | null>(null);
	let profileId = $state('');
	let loaded = $state(false);

	onMount(() => {
		void (async () => {
			try {
				const [profileResponse, settingsResponse] = await Promise.all([
					fetch('/api/scoring-profiles?mediaKind=music'),
					fetch('/api/music/settings')
				]);
				const profileBody = profileResponse.ok
					? ((await profileResponse.json()) as { profiles?: Array<{ id: string; name: string }> })
					: null;
				const settingsBody = settingsResponse.ok
					? ((await settingsResponse.json()) as {
							defaultProfileId?: string | null;
							effectiveProfile?: { id: string; name: string } | null;
						})
					: null;
				profiles = (profileBody?.profiles ?? []).map((profile) => ({
					id: profile.id,
					name: profile.name
				}));
				defaultProfileName =
					settingsBody?.effectiveProfile?.name ??
					profiles.find((profile) => profile.id === settingsBody?.defaultProfileId)?.name ??
					null;
				loaded = true;
			} catch {
				profiles = [];
			}
		})();
	});

	// A cancelled choice must not leak into the next add.
	$effect(() => {
		if (!open) profileId = '';
	});
</script>

<ModalWrapper {open} {onClose} maxWidth="md" labelledBy="music-add-confirm-title">
	<div class="flex items-start justify-between gap-4">
		<div class="flex min-w-0 items-start gap-3">
			<div class="mt-0.5 rounded-lg bg-primary/15 p-2 text-primary">
				{#if kind === 'artist'}
					<User class="h-4 w-4" />
				{:else}
					<Disc3 class="h-4 w-4" />
				{/if}
			</div>
			<div class="min-w-0">
				<h3 id="music-add-confirm-title" class="text-lg font-semibold">
					{kind === 'artist' ? m.music_addArtist() : m.music_addAlbum()}
				</h3>
				<p class="mt-1 text-sm break-words text-base-content/60">
					{title}{subtitle ? ` · ${subtitle}` : ''}
				</p>
			</div>
		</div>
		<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose} aria-label={m.action_close()}>
			✕
		</button>
	</div>

	<label class="form-control mt-5">
		<span class="mb-1 text-sm font-medium">{m.common_qualityProfile()}</span>
		<select class="select-bordered select w-full" bind:value={profileId} disabled={!loaded}>
			<option value="">
				{defaultProfileName
					? m.music_useDefaultProfile({ name: defaultProfileName })
					: m.common_default()}
			</option>
			{#each profiles as profile (profile.id)}
				<option value={profile.id}>{profile.name}</option>
			{/each}
		</select>
		<span class="mt-2 text-xs text-base-content/55">{m.music_addProfileHint()}</span>
	</label>

	<div class="mt-5 flex justify-end gap-2">
		<button class="btn btn-ghost btn-sm" onclick={onClose}>{m.action_cancel()}</button>
		<button
			class="btn btn-primary btn-sm"
			onclick={() => {
				onAdd(profileId || null);
				onClose();
			}}
		>
			{kind === 'artist' ? m.music_addArtist() : m.music_addAlbum()}
		</button>
	</div>
</ModalWrapper>
