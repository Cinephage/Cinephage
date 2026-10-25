<script lang="ts">
	import { FolderOpen, BarChart3, Search, Captions, TriangleAlert } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { getWritableRootFoldersForMediaType } from '#lib/utils/root-folders.js';
	import * as m from '#lib/paraglide/messages.js';
	import { formatBytes } from '#lib/utils/format.js';
	import type { RootFolderWithSpaceAndDefault as RootFolder } from '#lib/types/downloadClient.js';
	import type { SubtitleRequirement } from '#lib/shared/language-profile.js';
	import SubtitleRequirementsSection from '#lib/components/subtitles/SubtitleRequirementsSection.svelte';

	interface ScoringProfile {
		id: string;
		name: string;
		description?: string;
		isBuiltIn: boolean;
		isDefault?: boolean;
		minResolution?: string | null;
		maxResolution?: string | null;
	}

	/** The subtitle profile a new item will inherit, plus the level it came from. */
	interface EffectiveSubtitleProfileInfo {
		profile: { id: string; name: string };
		source: 'movie' | 'series' | 'library' | 'default';
	}

	interface Props {
		mediaType: 'movie' | 'tv';
		rootFolders: RootFolder[];
		scoringProfiles: ScoringProfile[];
		selectedRootFolder: string;
		selectedScoringProfile: string;
		searchOnAdd: boolean;
		wantsSubtitles: boolean;
		/** Resolved subtitle profile for a NEW item; undefined while loading, null when unset. */
		effectiveSubtitleProfile?: EffectiveSubtitleProfileInfo | null;
		/** Available language profiles for the add-time picker. */
		languageProfiles?: Array<{ id: string; name: string }>;
		/** Effective requirements for a NEW item (seeds the customize editor). */
		effectiveSubtitleRequirements?: SubtitleRequirement[] | null;
		/** Add-time language profile override ('' = inherit). */
		selectedLanguageProfile?: string;
		/** Add-time per-item subtitle requirement override (null = inherit). */
		subtitleRequirementsOverride?: SubtitleRequirement[] | null;
		requiredMediaSubType?: 'standard' | 'anime';
		onSearchOnAddInput?: () => void;
		onWantsSubtitlesInput?: () => void;
	}

	let {
		mediaType,
		rootFolders,
		scoringProfiles,
		selectedRootFolder = $bindable(),
		selectedScoringProfile = $bindable(),
		searchOnAdd = $bindable(),
		wantsSubtitles = $bindable(),
		effectiveSubtitleProfile,
		languageProfiles = [],
		effectiveSubtitleRequirements = null,
		selectedLanguageProfile = $bindable(''),
		subtitleRequirementsOverride = $bindable<SubtitleRequirement[] | null>(null),
		requiredMediaSubType,
		onSearchOnAddInput,
		onWantsSubtitlesInput
	}: Props = $props();

	let customizingSubtitles = $state(false);

	const filteredRootFolders = $derived(
		getWritableRootFoldersForMediaType(rootFolders, mediaType, requiredMediaSubType)
	);
	const selectedRootFolderObj = $derived(
		filteredRootFolders.find((f) => f.id === selectedRootFolder)
	);
	const selectedProfileObj = $derived(scoringProfiles.find((p) => p.id === selectedScoringProfile));

	const effectiveSubtitleSource = $derived(
		effectiveSubtitleProfile?.source === 'default'
			? m.library_subtitleProfile_sourceDefault()
			: effectiveSubtitleProfile?.source === 'library'
				? m.library_subtitleProfile_sourceLibrary()
				: m.library_subtitleProfile_sourceItem()
	);
</script>

<!-- Root Folder Select -->
<div class="form-control min-w-0">
	<label class="label" for="root-folder">
		<span class="label-text flex items-center gap-2 font-medium">
			<FolderOpen class="h-4 w-4 shrink-0" />
			{m.common_rootFolder()}
		</span>
	</label>
	{#if filteredRootFolders.length === 0}
		<div class="alert text-sm alert-warning">
			<span
				>{#if requiredMediaSubType === 'anime'}
					No Anime root folders are available for this media type.
				{:else if requiredMediaSubType === 'standard'}
					No Standard root folders are available for this media type.
				{:else}
					{m.library_add_noRootFoldersConfigured({
						mediaType:
							mediaType === 'movie'
								? m.common_movies().toLowerCase()
								: m.common_tvShows().toLowerCase()
					})}
				{/if}

				<a href={resolve('settings/library/libraries')} class="link"
					>{m.library_add_addOneInSettings()}</a
				>
			</span>
		</div>
	{:else}
		<select
			id="root-folder"
			class="select-bordered select w-full max-w-full"
			bind:value={selectedRootFolder}
		>
			{#each filteredRootFolders as folder (folder.id)}
				<option value={folder.id}>
					{folder.name}
					{#if folder.freeSpaceBytes}
						({m.library_add_rootFolderFree({ free: formatBytes(folder.freeSpaceBytes) })})
					{/if}
				</option>
			{/each}
		</select>
		{#if selectedRootFolderObj}
			<p class="mt-1 truncate text-xs text-base-content/60" title={selectedRootFolderObj.path}>
				{selectedRootFolderObj.path}
			</p>
		{/if}
	{/if}
</div>

<!-- Quality Profile Select -->
<div class="form-control min-w-0">
	<label class="label" for="scoring-profile">
		<span class="label-text flex items-center gap-2 font-medium">
			<BarChart3 class="h-4 w-4 shrink-0" />
			{m.common_qualityProfile()}
		</span>
	</label>
	<select
		id="scoring-profile"
		class="select-bordered select w-full max-w-full"
		bind:value={selectedScoringProfile}
	>
		{#each scoringProfiles as profile (profile.id)}
			<option value={profile.id}>
				{profile.name}
			</option>
		{/each}
	</select>
	{#if selectedProfileObj?.description}
		<p class="mt-1 text-xs text-base-content/60">
			{selectedProfileObj.description}
		</p>
	{/if}
</div>

<!-- Search on Add Toggle -->
<label class="flex cursor-pointer items-start gap-4 py-2">
	<input
		type="checkbox"
		class="toggle mt-0.5 shrink-0 toggle-success"
		bind:checked={searchOnAdd}
		onchange={() => onSearchOnAddInput?.()}
	/>
	<div class="min-w-0">
		<span class="flex items-center gap-2 text-sm font-medium">
			<Search class="h-4 w-4 shrink-0" />
			{m.library_add_searchImmediately()}
		</span>
		<p class="text-xs text-base-content/60">
			{#if mediaType === 'movie'}
				{searchOnAdd
					? m.library_add_movie_searchImmediatelyDescYes()
					: m.library_add_movie_searchImmediatelyDescNo()}
			{:else}
				{searchOnAdd
					? m.library_add_searchImmediatelyDescYes()
					: m.library_add_searchImmediatelyDescNo()}
			{/if}
		</p>
	</div>
</label>

<!-- Auto-Download Subtitles Toggle -->
<label class="flex cursor-pointer items-start gap-4 py-2">
	<input
		type="checkbox"
		class="toggle mt-0.5 shrink-0 toggle-primary"
		bind:checked={wantsSubtitles}
		onchange={() => onWantsSubtitlesInput?.()}
	/>
	<div class="min-w-0">
		<span class="flex items-center gap-2 text-sm font-medium">
			<Captions class="h-4 w-4 shrink-0" />
			{m.library_add_autoDownloadSubtitles()}
		</span>
		<p class="text-xs text-base-content/60">
			{wantsSubtitles
				? m.library_add_autoDownloadSubtitlesYes()
				: m.library_add_autoDownloadSubtitlesNo()}
		</p>
		{#if wantsSubtitles && effectiveSubtitleProfile}
			<p class="mt-1 text-xs text-base-content/60">
				{m.library_add_subtitleProfileLine({
					name: effectiveSubtitleProfile.profile.name,
					source: effectiveSubtitleSource
				})}
			</p>
		{/if}
	</div>
</label>

{#if wantsSubtitles}
	<!-- Language Profile (add-time override) -->
	<div class="form-control min-w-0">
		<label class="label" for="add-language-profile">
			<span class="label-text text-sm font-medium">{m.library_subtitleProfile_label()}</span>
		</label>
		<select
			id="add-language-profile"
			class="select-bordered select w-full max-w-full select-sm"
			bind:value={selectedLanguageProfile}
		>
			<option value="">
				{effectiveSubtitleProfile
					? m.library_subtitleProfile_inherit()
					: m.library_subtitleProfile_sourceDefault()}
			</option>
			{#each languageProfiles as profile (profile.id)}
				<option value={profile.id}>{profile.name}</option>
			{/each}
		</select>
		<button
			type="button"
			class="btn mt-1 self-start btn-ghost px-0 text-base-content/70 btn-xs"
			onclick={() => (customizingSubtitles = !customizingSubtitles)}
			>{customizingSubtitles ? '▾' : '▸'} {m.library_subtitleRequirements_customized()}</button
		>

		{#if customizingSubtitles}
			<div class="mt-2">
				<SubtitleRequirementsSection
					requirements={subtitleRequirementsOverride ??
						effectiveSubtitleRequirements ?? [
							{ tag: 'en', variant: 'regular', accessibility: 'any' }
						]}
					editable
					onSave={(requirements) => {
						subtitleRequirementsOverride = requirements;
					}}
				/>
			</div>
		{/if}
	</div>
{/if}

{#if wantsSubtitles && effectiveSubtitleProfile === null}
	<div class="alert text-sm alert-warning" role="status">
		<TriangleAlert class="h-4 w-4 shrink-0" />
		<span>
			{m.library_add_noDefaultProfileWarning()}

			<a href={resolve('settings/library/languages')} class="link"
				>{m.library_add_noDefaultProfileWarningLink()}</a
			>
		</span>
	</div>
{/if}
