<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { goto, refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import type { PageData } from './$types';
	import type { ScoringProfile, ScoringProfileFormData } from '#lib/types/profile.js';
	import type { UICustomFormat } from '#lib/types/format.js';
	import type { CustomFormatFormData } from '#lib/components/formats/index.js';
	import { ProfileList, ProfileModal } from '#lib/components/profiles/index.js';
	import { FormatList, CustomFormatModal } from '#lib/components/formats/index.js';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import { SettingsPage } from '#lib/components/ui/settings/index.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { Sliders, Layers, Clock } from '@lucide/svelte';
	import { DelayProfileList } from '#lib/components/delayProfiles/index.js';
	import {
		createScoringProfile,
		updateScoringProfile,
		deleteScoringProfile
	} from '#lib/api/settings.js';
	import { createCustomFormat, updateCustomFormat, deleteCustomFormat } from '#lib/api/indexers.js';
	import type {
		ScoringProfileCreate,
		ScoringProfileUpdate,
		CustomFormatCreate,
		CustomFormatUpdateBody
	} from '#lib/validation/schemas.js';

	let { data }: { data: PageData } = $props();

	// Tab state - derived from URL
	const activeTab = $derived(page.url.searchParams.get('tab') || 'profiles');

	function setTab(tab: string) {
		const url = new URL(page.url.href);
		url.searchParams.set('tab', tab);
		goto(url.toString(), { replace: true });
	}

	// ===================
	// Profile Modal State
	// ===================
	let profileModalOpen = $state(false);
	let profileModalMode = $state<'add' | 'edit' | 'view'>('add');
	let selectedProfile = $state<ScoringProfile | null>(null);
	let profileSaving = $state(false);
	let profileError = $state<string | null>(null);
	let profileErrorPrefix = $state<string | null>(null);
	let profileErrorEmphasis = $state<string | null>(null);
	let profileErrorSuffix = $state<string | null>(null);

	// Profile delete confirmation
	let profileDeleteConfirmOpen = $state(false);
	let profileDeleteTarget = $state<ScoringProfile | null>(null);

	function openAddProfileModal() {
		profileModalMode = 'add';
		selectedProfile = null;
		profileError = null;
		profileErrorPrefix = null;
		profileErrorEmphasis = null;
		profileErrorSuffix = null;
		profileModalOpen = true;
	}

	function openEditProfileModal(profile: ScoringProfile) {
		profileModalMode = 'edit';
		selectedProfile = profile;
		profileError = null;
		profileErrorPrefix = null;
		profileErrorEmphasis = null;
		profileErrorSuffix = null;
		profileModalOpen = true;
	}

	function closeProfileModal() {
		profileModalOpen = false;
		selectedProfile = null;
		profileError = null;
		profileErrorPrefix = null;
		profileErrorEmphasis = null;
		profileErrorSuffix = null;
	}

	async function handleProfileSave(formData: ScoringProfileFormData) {
		profileSaving = true;
		profileError = null;
		profileErrorPrefix = null;
		profileErrorEmphasis = null;
		profileErrorSuffix = null;

		try {
			if (profileModalMode === 'add') {
				await createScoringProfile(formData as ScoringProfileCreate);
			} else {
				await updateScoringProfile({ id: selectedProfile?.id, ...formData } as {
					id: string;
				} & ScoringProfileUpdate);
			}

			await refreshAll();
			closeProfileModal();
		} catch (e) {
			profileError = e instanceof Error ? e.message : 'An unexpected error occurred';
			const duplicateMatch = profileError.match(/^Profile with name '(.+)' already exists$/);
			if (duplicateMatch) {
				profileErrorPrefix = "Profile with name '";
				profileErrorEmphasis = duplicateMatch[1] ?? '';
				profileErrorSuffix = "' already exists";
			}
		} finally {
			profileSaving = false;
		}
	}

	async function handleProfileReset(profileId: string) {
		profileSaving = true;
		profileError = null;

		try {
			await updateScoringProfile({ id: profileId, formatScores: {} });

			await refreshAll();
		} catch (e) {
			profileError = e instanceof Error ? e.message : 'An unexpected error occurred';
		} finally {
			profileSaving = false;
		}
	}

	function confirmProfileDelete(profile: ScoringProfile) {
		profileDeleteTarget = profile;
		profileDeleteConfirmOpen = true;
	}

	async function handleProfileDelete() {
		if (!profileDeleteTarget) return;

		try {
			await deleteScoringProfile(profileDeleteTarget.id);

			await refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : m.settings_quality_failedToDeleteProfile());
		} finally {
			profileDeleteConfirmOpen = false;
			profileDeleteTarget = null;
		}
	}

	async function handleSetDefault(profile: ScoringProfile) {
		try {
			await updateScoringProfile({
				id: profile.id,
				isDefault: true
			});

			await refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : m.settings_quality_failedToSetDefault());
		}
	}

	// ===================
	// Format Modal State
	// ===================
	let formatModalOpen = $state(false);
	let formatModalMode = $state<'add' | 'edit' | 'view'>('add');
	let selectedFormat = $state<UICustomFormat | null>(null);
	let formatSaving = $state(false);
	let formatError = $state<string | null>(null);

	// Format delete confirmation
	let formatDeleteConfirmOpen = $state(false);
	let formatDeleteTarget = $state<UICustomFormat | null>(null);

	function openAddFormatModal() {
		formatModalMode = 'add';
		selectedFormat = null;
		formatError = null;
		formatModalOpen = true;
	}

	function openViewFormatModal(format: UICustomFormat) {
		formatModalMode = 'view';
		selectedFormat = format;
		formatError = null;
		formatModalOpen = true;
	}

	function openEditFormatModal(format: UICustomFormat) {
		formatModalMode = 'edit';
		selectedFormat = format;
		formatError = null;
		formatModalOpen = true;
	}

	function closeFormatModal() {
		formatModalOpen = false;
		selectedFormat = null;
		formatError = null;
	}

	async function handleFormatSave(formData: CustomFormatFormData) {
		formatSaving = true;
		formatError = null;

		try {
			if (formatModalMode === 'add') {
				await createCustomFormat(formData as CustomFormatCreate);
			} else {
				await updateCustomFormat(
					(selectedFormat?.id as string) ?? '',
					formData as CustomFormatUpdateBody
				);
			}

			await refreshAll();
			closeFormatModal();
		} catch (e) {
			formatError = e instanceof Error ? e.message : 'An unexpected error occurred';
		} finally {
			formatSaving = false;
		}
	}

	function confirmFormatDelete(format: UICustomFormat) {
		formatDeleteTarget = format;
		formatDeleteConfirmOpen = true;
	}

	async function handleFormatDelete() {
		if (!formatDeleteTarget) return;

		try {
			await deleteCustomFormat(formatDeleteTarget.id);

			await refreshAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : m.settings_quality_failedToDeleteFormat());
		} finally {
			formatDeleteConfirmOpen = false;
			formatDeleteTarget = null;
		}
	}

	// ===================
	// Delay Profiles State
	// ===================
	// DelayProfileList is now a self-contained component at
	// #lib/components/delayProfiles. All dp* state, functions, modal, and
	// delete confirmation live there. This page just renders it.
</script>

<svelte:head>
	<title>{m.nav_qualitySettings()}</title>
</svelte:head>

<SettingsPage title={m.settings_quality_heading()} subtitle={m.settings_quality_subtitle()}>
	<!-- Tabs -->
	<div role="tablist" class="tabs-boxed tabs w-fit">
		<button
			type="button"
			role="tab"
			class="tab gap-2"
			class:tab-active={activeTab === 'profiles'}
			onclick={() => setTab('profiles')}
		>
			<Sliders class="h-4 w-4" />
			{m.settings_quality_tabProfiles()}
		</button>
		<button
			type="button"
			role="tab"
			class="tab gap-2"
			class:tab-active={activeTab === 'formats'}
			onclick={() => setTab('formats')}
		>
			<Layers class="h-4 w-4" />
			{m.settings_quality_tabFormats()}
		</button>
		<button
			type="button"
			role="tab"
			class="tab gap-2"
			class:tab-active={activeTab === 'delay-profiles'}
			onclick={() => setTab('delay-profiles')}
		>
			<Clock class="h-4 w-4" />
			{m.settings_quality_delay_tab()}
		</button>
	</div>

	<!-- Tab Content -->
	{#if activeTab === 'profiles'}
		<div class="-mt-2">
			<p class="text-sm text-base-content/60">
				{m.settings_quality_profilesDescription()}
			</p>
		</div>
		<ProfileList
			profiles={data.profiles}
			onAdd={openAddProfileModal}
			onEdit={openEditProfileModal}
			onDelete={confirmProfileDelete}
			onSetDefault={handleSetDefault}
		/>
	{:else if activeTab === 'formats'}
		<div class="-mt-2">
			<p class="text-sm text-base-content/60">
				{m.settings_quality_formatsDescription()}
			</p>
		</div>
		<FormatList
			formats={data.formats as UICustomFormat[]}
			onView={openViewFormatModal}
			onEdit={openEditFormatModal}
			onCreate={openAddFormatModal}
			onDelete={confirmFormatDelete}
		/>
	{:else if activeTab === 'delay-profiles'}
		<DelayProfileList delayProfiles={data.delayProfiles} />
	{/if}
</SettingsPage>

<!-- Profile Modal -->
<ProfileModal
	open={profileModalOpen}
	mode={profileModalMode}
	profile={selectedProfile}
	allProfiles={data.profiles.map((p) => ({ id: p.id, name: p.name, isBuiltIn: p.isBuiltIn }))}
	allFormats={data.formats.map((f) => ({ id: f.id, name: f.name, category: f.category }))}
	defaultCopyFromId={data.defaultProfileId}
	saving={profileSaving}
	error={profileError}
	errorPrefix={profileErrorPrefix}
	errorEmphasis={profileErrorEmphasis}
	errorSuffix={profileErrorSuffix}
	onClose={closeProfileModal}
	onSave={handleProfileSave}
	onReset={handleProfileReset}
/>

<!-- Profile Delete Confirmation -->
<ConfirmationModal
	open={profileDeleteConfirmOpen}
	title={m.settings_quality_confirmDeleteTitle()}
	message={m.settings_quality_confirmDeleteProfileMessage({
		name: profileDeleteTarget?.name ?? ''
	})}
	confirmLabel={m.action_delete()}
	confirmVariant="error"
	onConfirm={handleProfileDelete}
	onCancel={() => (profileDeleteConfirmOpen = false)}
/>

<!-- Format Modal -->
<CustomFormatModal
	open={formatModalOpen}
	mode={formatModalMode}
	format={selectedFormat}
	saving={formatSaving}
	error={formatError}
	onClose={closeFormatModal}
	onSave={handleFormatSave}
/>

<!-- Format Delete Confirmation -->
<ConfirmationModal
	open={formatDeleteConfirmOpen}
	title={m.settings_quality_confirmDeleteTitle()}
	message={m.settings_quality_confirmDeleteFormatMessage({ name: formatDeleteTarget?.name ?? '' })}
	confirmLabel={m.action_delete()}
	confirmVariant="error"
	onConfirm={handleFormatDelete}
	onCancel={() => (formatDeleteConfirmOpen = false)}
/>
