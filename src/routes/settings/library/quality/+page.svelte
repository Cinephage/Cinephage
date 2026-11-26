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
	import { handleTablistKeydown } from '#lib/utils/tabs.js';
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

	/**
	 * Music rows wear the same ScoringProfile shape the table and dialog already
	 * speak, so both kinds share one list and one editor instead of a parallel UI.
	 */
	const musicProfiles = $derived<ScoringProfile[]>(
		data.musicProfiles.map((profile) => ({
			id: profile.id,
			name: profile.name,
			description: profile.description ?? '',
			tags: [],
			upgradesAllowed: true,
			preventDowngrades: false,
			minScore: 0,
			upgradeUntilScore: -1,
			minScoreIncrement: 0,
			resolutionOrder: [],
			formatScores: {},
			isDefault: profile.isDefault,
			isBuiltIn: profile.isBuiltIn,
			mediaKind: 'music' as const,
			musicTiers: profile.tiers,
			allowFallback: profile.allowFallback,
			musicMinSizeMb: profile.minSizeMb,
			musicMaxSizeMb: profile.maxSizeMb
		}))
	);

	// Tab state - derived from URL
	const activeTab = $derived(page.url.searchParams.get('tab') || 'profiles');
	const tabs = ['profiles', 'formats', 'delay-profiles'] as const;
	type QualityTab = (typeof tabs)[number];
	// The tab that takes part in the Tab order, even if the URL names an unknown tab.
	const focusableTab = $derived<QualityTab>(tabs.find((tab) => tab === activeTab) ?? tabs[0]);

	function setTab(tab: string) {
		const url = new URL(page.url.href);
		url.searchParams.set('tab', tab);
		// reset: false keeps focus on the tab that arrow-key navigation just moved to.
		goto(url.toString(), { replace: true, reset: false });
	}

	// ===================
	// Profile Modal State
	// ===================
	let profileModalOpen = $state(false);
	let profileModalMode = $state<'add' | 'edit' | 'view'>('add');
	let profileModalMediaKind = $state<'video' | 'music'>('video');
	let selectedProfile = $state<ScoringProfile | null>(null);
	let profileSaving = $state(false);
	let profileError = $state<string | null>(null);
	let profileErrorPrefix = $state<string | null>(null);
	let profileErrorEmphasis = $state<string | null>(null);
	let profileErrorSuffix = $state<string | null>(null);

	// Profile delete confirmation
	let profileDeleteConfirmOpen = $state(false);
	let profileDeleteTarget = $state<ScoringProfile | null>(null);

	/** The dialog copies only from profiles of the kind it is editing. */
	const modalAllProfiles = $derived.by(() => {
		if (profileModalMediaKind === 'music') {
			return musicProfiles.map((profile) => ({
				id: profile.id,
				name: profile.name,
				isBuiltIn: profile.isBuiltIn,
				musicTiers: profile.musicTiers,
				allowFallback: profile.allowFallback,
				musicMinSizeMb: profile.musicMinSizeMb,
				musicMaxSizeMb: profile.musicMaxSizeMb
			}));
		}
		return data.profiles.map((profile) => ({
			id: profile.id,
			name: profile.name,
			isBuiltIn: profile.isBuiltIn
		}));
	});

	function openProfileModal(
		mode: 'add' | 'edit' | 'view',
		mediaKind: 'video' | 'music',
		profile: ScoringProfile | null
	) {
		profileModalMode = mode;
		profileModalMediaKind = mediaKind;
		selectedProfile = profile;
		profileError = null;
		profileErrorPrefix = null;
		profileErrorEmphasis = null;
		profileErrorSuffix = null;
		profileModalOpen = true;
	}

	function openAddProfileModal() {
		openProfileModal('add', 'video', null);
	}

	function openAddMusicProfileModal() {
		openProfileModal('add', 'music', null);
	}

	function openEditProfileModal(profile: ScoringProfile) {
		openProfileModal('edit', profile.mediaKind ?? 'video', profile);
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
			if (formData.mediaKind === 'music') {
				const payload = {
					name: formData.name ?? '',
					description: formData.description ?? '',
					mediaKind: 'music' as const,
					musicTiers: formData.musicTiers ?? [],
					musicAllowFallback: formData.musicAllowFallback ?? true,
					musicMinSizeMb: formData.musicMinSizeMb ?? null,
					musicMaxSizeMb: formData.musicMaxSizeMb ?? null
				};
				let profileId = selectedProfile?.id ?? null;
				if (profileModalMode === 'add') {
					const created = await createScoringProfile(payload as ScoringProfileCreate);
					profileId = created.id;
				} else if (profileId) {
					await updateScoringProfile({ id: profileId, ...payload } as {
						id: string;
					} & ScoringProfileUpdate);
				}

				// The music default is a settings key, not scoring_profiles.is_default.
				if (formData.isDefault && profileId) {
					const response = await fetch('/api/music/settings', {
						method: 'PATCH',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ defaultProfileId: profileId })
					});
					if (!response.ok) {
						const body = (await response.json().catch(() => ({}))) as { error?: string };
						throw new Error(body.error ?? 'Could not set the default music profile');
					}
				}
			} else if (profileModalMode === 'add') {
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
			if (profile.mediaKind === 'music') {
				const response = await fetch('/api/music/settings', {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ defaultProfileId: profile.id })
				});
				if (!response.ok) {
					const body = (await response.json().catch(() => ({}))) as { error?: string };
					throw new Error(body.error ?? 'Could not set the default music profile');
				}
			} else {
				await updateScoringProfile({
					id: profile.id,
					isDefault: true
				});
			}

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
	<!-- svelte-ignore a11y_interactive_supports_focus (focus is on the tabs: roving tabindex) -->
	<div
		role="tablist"
		aria-label={m.settings_quality_heading()}
		class="tabs-boxed tabs w-fit"
		onkeydown={(e) => handleTablistKeydown(e, tabs, focusableTab, setTab)}
	>
		<button
			type="button"
			role="tab"
			id="quality-tab-profiles"
			data-tab="profiles"
			aria-selected={activeTab === 'profiles'}
			aria-controls="quality-tabpanel"
			tabindex={focusableTab === 'profiles' ? 0 : -1}
			class="tab gap-2"
			class:tab-active={activeTab === 'profiles'}
			onclick={() => setTab('profiles')}
		>
			<Sliders class="h-4 w-4" aria-hidden="true" />
			{m.settings_quality_tabProfiles()}
		</button>
		<button
			type="button"
			role="tab"
			id="quality-tab-formats"
			data-tab="formats"
			aria-selected={activeTab === 'formats'}
			aria-controls="quality-tabpanel"
			tabindex={focusableTab === 'formats' ? 0 : -1}
			class="tab gap-2"
			class:tab-active={activeTab === 'formats'}
			onclick={() => setTab('formats')}
		>
			<Layers class="h-4 w-4" aria-hidden="true" />
			{m.settings_quality_tabFormats()}
		</button>
		<button
			type="button"
			role="tab"
			id="quality-tab-delay-profiles"
			data-tab="delay-profiles"
			aria-selected={activeTab === 'delay-profiles'}
			aria-controls="quality-tabpanel"
			tabindex={focusableTab === 'delay-profiles' ? 0 : -1}
			class="tab gap-2"
			class:tab-active={activeTab === 'delay-profiles'}
			onclick={() => setTab('delay-profiles')}
		>
			<Clock class="h-4 w-4" aria-hidden="true" />
			{m.settings_quality_delay_tab()}
		</button>
	</div>

	<!-- Tab Content -->
	<div
		id="quality-tabpanel"
		role="tabpanel"
		aria-labelledby="quality-tab-{activeTab}"
		tabindex="0"
		class="space-y-6"
	>
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
			<div class="divider my-6"></div>
			<div class="space-y-4">
				<div>
					<h2 class="text-lg font-semibold">{m.music_profilesTitle()}</h2>
					<p class="mt-1 max-w-3xl text-sm text-base-content/60">
						{m.music_profilesDescription()}
					</p>
				</div>
				<ProfileList
					profiles={musicProfiles}
					mediaKind="music"
					onAdd={openAddMusicProfileModal}
					onEdit={openEditProfileModal}
					onDelete={confirmProfileDelete}
					onSetDefault={handleSetDefault}
				/>
			</div>
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
	</div>
</SettingsPage>

<!-- Profile Modal -->
<ProfileModal
	open={profileModalOpen}
	mode={profileModalMode}
	mediaKind={profileModalMediaKind}
	profile={selectedProfile}
	allProfiles={modalAllProfiles}
	allFormats={data.formats.map((f) => ({ id: f.id, name: f.name, category: f.category }))}
	indexers={data.indexers}
	defaultCopyFromId={profileModalMediaKind === 'music'
		? (data.musicDefaultId ?? '')
		: data.defaultProfileId}
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
