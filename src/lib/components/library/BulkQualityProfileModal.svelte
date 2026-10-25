<script lang="ts">
	import { X, Loader2 } from '@lucide/svelte';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { mediaTypeCountLabel, type MediaType } from '#lib/utils/media-type.js';
	import * as m from '#lib/paraglide/messages.js';
	import type { QualityProfileOption } from '#lib/types/profile.js';

	interface Props {
		open: boolean;
		selectedCount: number;
		qualityProfiles: QualityProfileOption[];
		saving: boolean;
		mediaType: MediaType;
		onSave: (profileId: string | null) => void;
		onCancel: () => void;
	}

	let { open, selectedCount, qualityProfiles, saving, mediaType, onSave, onCancel }: Props =
		$props();

	let qualityProfileId = $state('');

	// Reset when modal opens
	$effect(() => {
		if (open) {
			qualityProfileId = '';
		}
	});

	const defaultProfile = $derived(qualityProfiles.find((p) => p.isDefault));
	const nonDefaultProfiles = $derived(qualityProfiles.filter((p) => p.id !== defaultProfile?.id));
	const currentProfile = $derived(
		qualityProfiles.find((p) => p.id === qualityProfileId) ?? defaultProfile
	);

	const itemLabel = $derived(mediaTypeCountLabel(mediaType, selectedCount));

	function handleSave() {
		onSave(qualityProfileId || null);
	}
</script>

<ModalWrapper {open} onClose={onCancel} maxWidth="md" labelledBy="bulk-profile-modal-title">
	<div class="mb-4 flex items-center justify-between">
		<h3 id="bulk-profile-modal-title" class="text-lg font-bold">
			{m.library_bulkQualityProfile_title()}
		</h3>
		<button
			type="button"
			class="btn btn-circle btn-ghost btn-sm"
			onclick={onCancel}
			aria-label={m.action_close()}
		>
			<X class="h-4 w-4" />
		</button>
	</div>

	<div class="mb-4 rounded-lg bg-base-200 p-3">
		<div class="font-medium">
			{m.library_bulkQualityProfile_selectedCount({ count: selectedCount })}
		</div>
		<div class="text-sm text-base-content/60">
			{m.library_bulkQualityProfile_description()}
		</div>
	</div>

	<div class="form-control">
		<label class="label" for="bulk-quality-profile">
			<span class="label-text font-medium"
				>{m.library_bulkQualityProfile_qualityProfileLabel()}</span
			>
		</label>
		<select
			id="bulk-quality-profile"
			bind:value={qualityProfileId}
			class="select-bordered select w-full"
		>
			{#if defaultProfile}
				<option value="" hidden
					>{m.library_bulkQualityProfile_defaultOption({
						name: defaultProfile?.name ?? m.common_default()
					})}</option
				>
			{/if}
			<option value={defaultProfile?.id ?? ''}
				>{m.library_bulkQualityProfile_defaultOption({
					name: defaultProfile?.name ?? m.common_default()
				})}</option
			>
			{#each nonDefaultProfiles as profile (profile.id)}
				<option value={profile.id}>{profile.name}</option>
			{/each}
		</select>
		<div class="label">
			<span class="label-text-alt text-base-content/60">
				{#if currentProfile}
					{currentProfile.description}
				{:else}
					{m.library_bulkQualityProfile_profileHint({ count: selectedCount })}
				{/if}
			</span>
		</div>
	</div>

	<div class="modal-action">
		<button type="button" class="btn btn-ghost" onclick={onCancel} disabled={saving}>
			{m.action_cancel()}
		</button>
		<button type="button" class="btn btn-primary" onclick={handleSave} disabled={saving}>
			{#if saving}
				<Loader2 class="h-4 w-4 animate-spin" />
			{/if}
			{m.library_bulkQualityProfile_applyButton({ count: selectedCount, items: itemLabel })}
		</button>
	</div>
</ModalWrapper>
