<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { Plus, Trash2, Pencil, Star, Globe, Copy, Loader2 } from '@lucide/svelte';
	import { getResponseErrorMessage } from '#lib/utils/http.js';
	import { getLanguageName } from '#lib/shared/languages.js';
	import { requirementKey } from '#lib/shared/language-profile.js';
	import type { LanguageProfileV2 } from '#lib/shared/language-profile.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { SettingsSection } from '#lib/components/ui/settings/index.js';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { deleteLanguageProfile, updateLanguageSettings, ApiError } from '#lib/api/index.js';
	import LanguageProfileEditModal from './LanguageProfileEditModal.svelte';
	import { variantLabel, accessibilityLabel } from './labels';

	/** Server-load profile row: v2 shape plus timestamps. */
	interface LanguageProfile extends LanguageProfileV2 {
		createdAt?: string;
		updatedAt?: string;
	}

	interface Props {
		/** All language profiles. */
		profiles: LanguageProfile[];
		/** The default profile id (language_settings.defaultProfileId). */
		defaultProfileId: string | null;
	}

	let { profiles, defaultProfileId }: Props = $props();

	// Add/edit/duplicate modal state
	let modalOpen = $state(false);
	let modalMode = $state<'add' | 'edit'>('add');
	let modalSource = $state<LanguageProfile | null>(null);

	function openAddModal() {
		modalMode = 'add';
		modalSource = null;
		modalOpen = true;
	}

	function openEditModal(profile: LanguageProfile) {
		modalMode = 'edit';
		modalSource = profile;
		modalOpen = true;
	}

	function openDuplicateModal(profile: LanguageProfile) {
		modalMode = 'add';
		modalSource = profile;
		modalOpen = true;
	}

	// Default-profile selection: instant save with optimistic feedback.
	// `optimisticDefaultId` holds the pending choice until the loader confirms
	// it (success) or it is rolled back (failure).
	let optimisticDefaultId = $state<string | null>(null);
	let settingDefault = $state(false);
	const activeDefaultId = $derived(optimisticDefaultId ?? defaultProfileId);

	async function setDefaultProfile(profile: LanguageProfile) {
		if (settingDefault || profile.id === activeDefaultId) return;
		optimisticDefaultId = profile.id;
		settingDefault = true;
		try {
			await updateLanguageSettings({ defaultProfileId: profile.id });
			await refreshAll();
			toasts.success(m.settings_languages_defaultSaved());
		} catch (error) {
			toasts.error(
				error instanceof ApiError
					? getResponseErrorMessage(error.response, m.settings_languages_defaultSaveFailed())
					: error instanceof Error
						? error.message
						: m.settings_languages_defaultSaveFailed()
			);
		} finally {
			optimisticDefaultId = null;
			settingDefault = false;
		}
	}

	// Delete confirmation
	let confirmDeleteOpen = $state(false);
	let deleteTarget = $state<LanguageProfile | null>(null);
	let deleting = $state(false);
	interface ProfileUsage {
		directMovies: number;
		directSeries: number;
		viaLibraries: number;
		smartLists: number;
		isInstanceDefault: boolean;
	}
	let deleteUsage = $state<ProfileUsage | null>(null);
	let deleteUsageFailed = $state(false);

	function confirmDelete(profile: LanguageProfile) {
		deleteTarget = profile;
		deleteUsage = null;
		deleteUsageFailed = false;
		confirmDeleteOpen = true;
		// Non-critical: powers the impact preview inside the confirm dialog.
		fetch(`/api/subtitles/language-profiles/${profile.id}?usage=1`)
			.then((response) =>
				response.ok ? response.json() : Promise.reject(new Error(String(response.status)))
			)
			.then((data) => (deleteUsage = data))
			.catch(() => (deleteUsageFailed = true));
	}

	async function handleConfirmDelete() {
		if (!deleteTarget) return;
		deleting = true;
		try {
			await deleteLanguageProfile(deleteTarget.id);
			await refreshAll();
			confirmDeleteOpen = false;
			deleteTarget = null;
		} catch (error) {
			toasts.error(
				error instanceof ApiError
					? getResponseErrorMessage(error.response, m.settings_languages_profileDeleteFailed())
					: error instanceof Error
						? error.message
						: m.settings_languages_profileDeleteFailed()
			);
		} finally {
			deleting = false;
		}
	}
</script>

<SettingsSection
	title={m.settings_languages_profilesSection()}
	description={m.settings_languages_profilesHint()}
>
	{#snippet actions()}
		<button class="btn w-full gap-2 btn-primary btn-sm sm:w-auto" onclick={openAddModal}>
			<Plus class="h-4 w-4" />
			{m.settings_languages_profiles_addProfile()}
		</button>
	{/snippet}

	{#if profiles.length === 0}
		<div class="card bg-base-100 shadow-xl">
			<div class="card-body items-center text-center">
				<Globe class="h-12 w-12 text-base-content/30" />
				<p class="text-base-content/70">
					{m.settings_languages_profiles_noProfiles()}
				</p>
				<p class="text-sm text-base-content/50">
					{m.settings_languages_profiles_noProfilesHint()}
				</p>
				<button class="btn mt-2 gap-2 btn-primary btn-sm" onclick={openAddModal}>
					<Plus class="h-4 w-4" />
					{m.settings_languages_createFirst()}
				</button>
			</div>
		</div>
	{:else}
		<div class="grid gap-3 sm:gap-4">
			{#each profiles as profile (profile.id)}
				<div class="card bg-base-100 shadow-xl">
					<div class="card-body gap-3 p-4 sm:p-6">
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0 flex-1">
								<h3 class="card-title flex flex-wrap items-center gap-2 leading-tight">
									<span class="wrap-break-word">{profile.name}</span>
									{#if profile.id === activeDefaultId}
										<span class="badge gap-1 badge-primary">
											<Star class="h-3 w-3" />
											{m.common_default()}
										</span>
									{/if}
								</h3>
								{#if profile.audio?.languages?.length || profile.audio?.mode === 'require'}
									<div
										class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-base-content/60"
									>
										<span>
											{m.settings_languages_profiles_cardAudioLabel()}
											{profile.audio.preferOriginal
												? m.settings_languages_profiles_cardAudioPreferOriginal()
												: m.settings_languages_profiles_cardAudioNoPreference()}
											{#if profile.audio.languages?.length}
												&middot;
												{profile.audio.languages.map((code) => getLanguageName(code)).join(', ')}
											{/if}
										</span>
										{#if profile.audio?.mode === 'require'}
											<span
												class="badge badge-sm badge-warning"
												title={m.settings_languages_profiles_cardAudioRequireTitle()}
											>
												{m.settings_languages_profiles_cardAudioRequire()}
											</span>
										{/if}
									</div>
								{/if}
								<div class="mt-2 flex flex-wrap gap-2">
									{#each profile.subtitles as requirement, i (requirementKey(requirement) + i)}
										<span
											class="badge gap-1 badge-outline {i === profile.cutoffRank
												? 'border-warning/60'
												: ''}"
										>
											{getLanguageName(requirement.tag)}
											{#if requirement.variant !== 'regular'}
												<span class="text-xs">({variantLabel(requirement.variant)})</span>
											{/if}
											{#if requirement.accessibility !== 'any'}
												<span class="text-xs"
													>({accessibilityLabel(requirement.accessibility)})</span
												>
											{/if}
											{#if i === profile.cutoffRank}
												<span class="text-xs text-warning">
													{m.settings_languages_profiles_cutoff()}
												</span>
											{/if}
										</span>
									{/each}
								</div>
								<div class="mt-2 text-sm text-base-content/60">
									<span class="block sm:inline"
										>{m.settings_languages_profiles_minScore()}: {profile.minimumScore}</span
									>
									<span class="hidden sm:inline"> | </span>
									<span class="block sm:inline">
										{m.settings_languages_profiles_upgrades()}: {profile.upgradesAllowed
											? m.settings_languages_profiles_allowed()
											: m.common_disabled()}
									</span>
								</div>
							</div>
							<div class="flex shrink-0 gap-1 sm:gap-2">
								{#if profile.id !== activeDefaultId}
									<button
										class="btn btn-ghost btn-sm"
										onclick={() => setDefaultProfile(profile)}
										disabled={settingDefault}
										aria-label={m.settings_languages_setAsDefault()}
										title={m.settings_languages_setAsDefault()}
									>
										<Star class="h-4 w-4" />
									</button>
								{/if}
								<button
									class="btn btn-ghost btn-sm"
									onclick={() => openDuplicateModal(profile)}
									aria-label={m.settings_languages_duplicateProfile()}
									title={m.settings_languages_duplicateProfile()}
								>
									<Copy class="h-4 w-4" />
								</button>
								<button
									class="btn btn-ghost btn-sm"
									onclick={() => openEditModal(profile)}
									aria-label={m.settings_languages_profiles_editProfile()}
									title={m.settings_languages_profiles_editProfile()}
								>
									<Pencil class="h-4 w-4" />
								</button>
								<button
									class="btn btn-ghost text-error btn-sm"
									onclick={() => confirmDelete(profile)}
									aria-label={m.settings_languages_profiles_deleteProfile()}
									title={m.settings_languages_profiles_deleteProfile()}
								>
									<Trash2 class="h-4 w-4" />
								</button>
							</div>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</SettingsSection>

<!-- Add/Edit/Duplicate Modal -->
<LanguageProfileEditModal
	open={modalOpen}
	mode={modalMode}
	source={modalSource}
	onClose={() => (modalOpen = false)}
/>

<!-- Delete Confirmation Modal -->
<ConfirmationModal
	open={confirmDeleteOpen}
	title={m.ui_modal_confirmTitle()}
	messagePrefix={m.settings_integrations_deleteConfirmPrefix()}
	messageEmphasis={deleteTarget?.name ?? ''}
	messageSuffix={m.settings_integrations_deleteConfirmSuffix()}
	confirmLabel={m.action_delete()}
	confirmVariant="error"
	loading={deleting}
	onConfirm={handleConfirmDelete}
	onCancel={() => (confirmDeleteOpen = false)}
>
	<div class="mt-2 rounded-lg bg-base-200 px-4 py-3 text-sm">
		{#if deleteUsage}
			<ul class="list-disc space-y-0.5 pl-4">
				{#if deleteUsage.directMovies > 0 || deleteUsage.directSeries > 0}
					<li>
						{m.settings_languages_profiles_deleteImpactDirect({
							movies: deleteUsage.directMovies,
							series: deleteUsage.directSeries
						})}
					</li>
				{/if}
				{#if deleteUsage.viaLibraries > 0}
					<li>
						{m.settings_languages_profiles_deleteImpactLibraries({
							count: deleteUsage.viaLibraries
						})}
					</li>
				{/if}
				{#if deleteUsage.smartLists > 0}
					<li>
						{m.settings_languages_profiles_deleteImpactSmartLists({
							count: deleteUsage.smartLists
						})}
					</li>
				{/if}
				{#if deleteUsage.isInstanceDefault}
					<li>{m.settings_languages_profiles_deleteImpactDefault()}</li>
				{/if}
				<li class="text-base-content/60">
					{m.settings_languages_profiles_deleteImpactFallback()}
				</li>
			</ul>
		{:else if deleteUsageFailed}
			<p class="text-base-content/60">{m.settings_languages_deleteUsageUnavailable()}</p>
		{:else}
			<p class="flex items-center gap-2 text-base-content/60">
				<Loader2 class="h-4 w-4 animate-spin" />
				{m.common_loading()}
			</p>
		{/if}
	</div>
</ConfirmationModal>
