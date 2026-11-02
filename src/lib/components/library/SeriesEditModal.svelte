<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { X, FolderOpen, Info } from '@lucide/svelte';
	import { FolderBrowser } from '#lib/components/library/index.js';
	import { ModalWrapper, ModalFooter } from '#lib/components/ui/modal/index.js';
	import { sortRootFoldersForMediaType } from '#lib/utils/root-folders.js';
	import { isLikelyAnimeMedia } from '#lib/shared/anime-classification.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { formatBytes } from '#lib/utils/format.js';
	import type { RootFolderWithSpace as RootFolder } from '#lib/types/downloadClient.js';
	import { getLibraryClassificationSettings } from '#lib/api/settings.js';
	import { getTmdb } from '#lib/api/discover.js';
	import { getSeriesEpisodeGroups } from '#lib/api/library.js';

	interface SeriesData {
		tmdbId: number;
		title: string;
		year: number | null;
		monitored: boolean | null;
		scoringProfileId: string | null;
		rootFolderId: string | null;
		episodeFileCount?: number | null;
		seasonFolder: boolean | null;
		wantsSubtitles: boolean | null;
		seriesType: string | null;
		path?: string | null;
		episodeGroupId?: string | null;
		id?: string | null;
		/** Subtitle language profile override; null = inherit (library/instance default). */
		languageProfileId?: string | null;
		metadataLanguageMode?: 'inherit' | 'original' | 'explicit' | null;
		metadataLanguageValue?: string | null;
		/** @deprecated Legacy single-string view derived from the pair. */
		metadataLanguage?: string | null;
		preferOriginalTitle?: boolean | null;
	}

	interface QualityProfileOption {
		id: string;
		name: string;
		description: string;
		isBuiltIn: boolean;
		isDefault: boolean;
	}

	interface TmdbTvDetails {
		name?: string | null;
		original_name?: string | null;
		original_language?: string | null;
		origin_country?: string[] | null;
		production_countries?: Array<{ iso_3166_1?: string }> | null;
		genres?: Array<{ id?: number; name?: string }> | null;
	}

	interface DelayProfileOption {
		id: string;
		name: string;
	}

	/** Entry for the subtitle-profile override select. */
	interface LanguageProfileOption {
		id: string;
		name: string;
	}

	/**
	 * The profile governing the item and the level it was resolved from
	 * (per-item override > owning library > instance default), as returned by
	 * the series loader's `effectiveLanguageProfile`.
	 */
	interface EffectiveLanguageProfileInfo {
		profile: { id: string; name: string };
		source: 'movie' | 'series' | 'library' | 'default';
	}

	interface Props {
		open: boolean;
		series: SeriesData;
		qualityProfiles: QualityProfileOption[];
		delayProfiles: DelayProfileOption[];
		languageProfiles?: LanguageProfileOption[];
		effectiveLanguageProfile?: EffectiveLanguageProfileInfo | null;
		rootFolders: RootFolder[];
		saving: boolean;
		onClose: () => void;
		onSave: (data: SeriesEditData) => void;
	}

	export interface SeriesEditData {
		monitored: boolean;
		scoringProfileId: string | null;
		delayProfileId: string | null;
		rootFolderId: string | null;
		moveFilesOnRootChange: boolean;
		seasonFolder: boolean;
		wantsSubtitles: boolean;
		/** Subtitle language profile override; null clears the override (inherit). */
		languageProfileId: string | null;
		seriesType: 'standard' | 'anime' | 'daily';
		folderPath?: string;
		episodeGroupId?: string | null;
		metadataLanguageMode: 'inherit' | 'original' | 'explicit';
		metadataLanguageValue: string | null;
		preferOriginalTitle?: boolean | null;
	}

	let {
		open,
		series,
		qualityProfiles,
		delayProfiles,
		languageProfiles = [],
		effectiveLanguageProfile = null,
		rootFolders,
		saving,
		onClose,
		onSave
	}: Props = $props();

	// Form state (defaults only, effect syncs from props)
	let monitored = $state(true);
	let qualityProfileId = $state('');
	let delayProfileId = $state<string | null>(null);
	let rootFolderId = $state('');
	let seasonFolder = $state(true);
	let wantsSubtitles = $state(true);
	let seriesType = $state<'standard' | 'anime' | 'daily'>('standard');
	let moveFilesOnRootChange = $state(false);
	let moveOptionTouched = $state(false);
	let folderPath = $state('');
	let showFolderPicker = $state(false);
	let animeRootWarningShown = $state(false);
	let enforceAnimeSubtype = $state(false);
	let detectedAnime = $state(false);
	let episodeGroupOption = $state<string>('');
	let episodeGroupOptions = $state<
		Array<{
			value: string;
			label: string;
			type: string;
		}>
	>([]);
	let episodeGroupsLoading = $state(false);
	let metadataLanguageMode = $state<'inherit' | 'original' | 'explicit'>('inherit');
	let metadataLanguageValue = $state<string | null>('en-US');
	let preferOriginalTitle = $state<boolean | null>(null);
	/** Subtitle profile override; '' = inherit (no per-item override). */
	let languageProfileOverride = $state('');

	const LOCALE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
		{ value: 'ar-SA', label: 'Arabic' },
		{ value: 'zh-CN', label: 'Chinese (zh-CN)' },
		{ value: 'zh-TW', label: 'Chinese (zh-TW)' },
		{ value: 'da-DK', label: 'Danish' },
		{ value: 'nl-NL', label: 'Dutch' },
		{ value: 'en-US', label: 'English' },
		{ value: 'fi-FI', label: 'Finnish' },
		{ value: 'fr-FR', label: 'French' },
		{ value: 'de-DE', label: 'German' },
		{ value: 'he-IL', label: 'Hebrew' },
		{ value: 'hi-IN', label: 'Hindi' },
		{ value: 'it-IT', label: 'Italian' },
		{ value: 'ja-JP', label: 'Japanese' },
		{ value: 'ko-KR', label: 'Korean' },
		{ value: 'no-NO', label: 'Norwegian' },
		{ value: 'pl-PL', label: 'Polish' },
		{ value: 'pt-BR', label: 'Portuguese' },
		{ value: 'ru-RU', label: 'Russian' },
		{ value: 'es-ES', label: 'Spanish' },
		{ value: 'sv-SE', label: 'Swedish' },
		{ value: 'th-TH', label: 'Thai' },
		{ value: 'tr-TR', label: 'Turkish' }
	];

	/**
	 * Read the metadata language pair, falling back to the deprecated legacy
	 * single-string field when the pair is absent.
	 */
	function resolveMetadataLanguage(source: {
		metadataLanguageMode?: 'inherit' | 'original' | 'explicit' | null;
		metadataLanguageValue?: string | null;
		metadataLanguage?: string | null;
	}): { mode: 'inherit' | 'original' | 'explicit'; value: string | null } {
		if (source.metadataLanguageMode) {
			const mode = source.metadataLanguageMode;
			return {
				mode,
				value: mode === 'explicit' ? (source.metadataLanguageValue ?? 'en-US') : null
			};
		}

		const legacy = source.metadataLanguage;
		if (!legacy) return { mode: 'inherit', value: null };
		if (legacy.toLowerCase() === 'original') return { mode: 'original', value: null };
		return { mode: 'explicit', value: legacy };
	}

	const requiredMediaSubType = $derived(
		enforceAnimeSubtype ? (detectedAnime ? ('anime' as const) : ('standard' as const)) : undefined
	);
	const eligibleRootFolders = $derived(
		sortRootFoldersForMediaType(rootFolders, 'tv', requiredMediaSubType)
	);
	const selectedRootFolderObj = $derived(rootFolders.find((folder) => folder.id === rootFolderId));
	const selectedRootFolderOutOfPolicy = $derived(
		requiredMediaSubType === 'anime' &&
			!!selectedRootFolderObj &&
			(selectedRootFolderObj.mediaSubType ?? 'standard') !== 'anime'
	);
	const hasExistingFiles = $derived((series.episodeFileCount ?? 0) > 0);
	const rootFolderChanged = $derived((rootFolderId || null) !== (series.rootFolderId ?? null));
	const canMoveExistingFiles = $derived(hasExistingFiles && rootFolderChanged && !!rootFolderId);
	async function loadAnimeRoutingContext(tmdbId: number) {
		try {
			const [classificationData, details] = await Promise.all([
				getLibraryClassificationSettings(),
				getTmdb(`tv/${tmdbId}`)
			]);

			let nextEnforceAnimeSubtype = false;
			let nextDetectedAnime = false;

			nextEnforceAnimeSubtype = classificationData?.enforceAnimeSubtype === true;

			const tvDetails = details as TmdbTvDetails;
			nextDetectedAnime = isLikelyAnimeMedia({
				genres: tvDetails.genres,
				originalLanguage: tvDetails.original_language,
				originCountries: tvDetails.origin_country,
				productionCountries: tvDetails.production_countries,
				title: tvDetails.name,
				originalTitle: tvDetails.original_name
			});

			detectedAnime = nextDetectedAnime;
			enforceAnimeSubtype = nextEnforceAnimeSubtype;
		} catch {
			enforceAnimeSubtype = false;
			detectedAnime = false;
		}
	}

	async function loadEpisodeGroups(seriesId: string) {
		episodeGroupsLoading = true;
		try {
			const data = (await getSeriesEpisodeGroups(seriesId)) as {
				success?: boolean;
				episodeGroups?: Array<{ id: string; name: string; type: number }>;
				selectedGroupId?: string | null;
			} | null;
			if (data?.success && Array.isArray(data.episodeGroups)) {
				episodeGroupOptions = [
					{ value: '', label: 'Default (TMDB)', type: '' },
					...data.episodeGroups.map((g) => ({
						value: g.id,
						label: g.name,
						type: getEpisodeGroupTypeLabel(g.type)
					}))
				];
				episodeGroupOption = data.selectedGroupId ?? '';
			}
		} catch {
			episodeGroupOptions = [{ value: '', label: 'Default (TMDB)', type: '' }];
			episodeGroupOption = '';
		} finally {
			episodeGroupsLoading = false;
		}
	}

	function getEpisodeGroupTypeLabel(type: number): string {
		switch (type) {
			case 1:
				return 'TVDB Order';
			case 2:
				return 'Seasons';
			case 3:
				return 'DVD/Blu-ray';
			case 4:
				return 'Streaming';
			case 5:
				return 'Arcs';
			case 6:
				return 'Cours';
			default:
				return `Type ${type}`;
		}
	}

	const seriesTypeOptions: Array<{
		value: 'standard' | 'anime' | 'daily';
		label: string;
		description: string;
	}> = [
		{
			value: 'standard',
			label: m.library_seriesEdit_standard(),
			description: m.library_seriesEdit_standardDesc()
		},
		{
			value: 'anime',
			label: m.library_seriesEdit_anime(),
			description: m.library_seriesEdit_animeDesc()
		},
		{
			value: 'daily',
			label: m.library_seriesEdit_daily(),
			description: m.library_seriesEdit_dailyDesc()
		}
	];

	function normalizeSeriesType(value: string | null | undefined): 'standard' | 'anime' | 'daily' {
		return value === 'anime' || value === 'daily' ? value : 'standard';
	}

	// Reset form when modal opens
	$effect(() => {
		if (open) {
			monitored = series.monitored ?? true;
			qualityProfileId = series.scoringProfileId ?? '';
			delayProfileId = (series as { delayProfileId?: string | null }).delayProfileId ?? null;
			rootFolderId = series.rootFolderId ?? '';
			seasonFolder = series.seasonFolder ?? true;
			wantsSubtitles = series.wantsSubtitles ?? true;
			seriesType = normalizeSeriesType(series.seriesType);
			moveFilesOnRootChange = false;
			moveOptionTouched = false;
			animeRootWarningShown = false;
			enforceAnimeSubtype = false;
			detectedAnime = false;
			folderPath = series.path ?? '';
			episodeGroupOption = series.episodeGroupId ?? '';
			const resolvedMetadataLanguage = resolveMetadataLanguage(series);
			metadataLanguageMode = resolvedMetadataLanguage.mode;
			metadataLanguageValue = resolvedMetadataLanguage.value;
			// Preserve the tri-state: null = inherit the instance default.
			preferOriginalTitle = series.preferOriginalTitle ?? null;
			languageProfileOverride = series.languageProfileId ?? '';
			void loadAnimeRoutingContext(series.tmdbId);
			if (series.id) {
				void loadEpisodeGroups(series.id);
			}
		}
	});

	$effect(() => {
		if (!open) return;
		if (!rootFolderId) return;
		const stillAllowed = eligibleRootFolders.some((folder) => folder.id === rootFolderId);
		if (!stillAllowed && !selectedRootFolderOutOfPolicy) {
			rootFolderId = '';
		}
	});

	$effect(() => {
		if (!open) return;
		if (rootFolderId) return;
		if (eligibleRootFolders.length > 0) {
			rootFolderId = eligibleRootFolders[0].id;
		}
	});

	$effect(() => {
		if (!open || animeRootWarningShown) return;
		if (!enforceAnimeSubtype || requiredMediaSubType !== 'anime') return;
		if (eligibleRootFolders.length > 0) return;

		toasts.warning(m.library_seriesEdit_animeRootWarningTitle(), {
			description: m.library_seriesEdit_animeRootWarningDesc()
		});
		animeRootWarningShown = true;
	});

	$effect(() => {
		if (!open) return;
		if (!canMoveExistingFiles) {
			moveFilesOnRootChange = false;
			moveOptionTouched = false;
			return;
		}
		if (!moveOptionTouched) {
			moveFilesOnRootChange = true;
		}
	});

	// Get profile data for labels/description
	let defaultProfile = $derived(qualityProfiles.find((p) => p.isDefault));
	let nonDefaultProfiles = $derived(qualityProfiles.filter((p) => p.id !== defaultProfile?.id));

	// Subtitle profile inheritance: when no per-item override is selected the
	// loader-resolved effective profile applies; surface where it came from.
	const subtitleProfileHelper = $derived.by(() => {
		if (languageProfileOverride || !effectiveLanguageProfile) return null;
		const source =
			effectiveLanguageProfile.source === 'library'
				? m.library_subtitleProfile_sourceLibrary()
				: effectiveLanguageProfile.source === 'default'
					? m.library_subtitleProfile_sourceDefault()
					: m.library_subtitleProfile_sourceItem();
		return m.library_subtitleProfile_inherited({
			name: effectiveLanguageProfile.profile.name,
			source
		});
	});

	const folderPathChanged = $derived(folderPath.trim() !== (series.path ?? '').trim());
	const resolvedFolderPath = $derived(
		selectedRootFolderObj?.path && folderPath.trim()
			? `${selectedRootFolderObj.path}/${folderPath.trim()}`
			: null
	);

	function handleSave() {
		onSave({
			monitored,
			scoringProfileId: qualityProfileId || null,
			delayProfileId,
			rootFolderId: rootFolderId || null,
			moveFilesOnRootChange,
			seasonFolder,
			wantsSubtitles,
			languageProfileId: languageProfileOverride || null,
			seriesType,
			...(folderPathChanged && folderPath.trim() ? { folderPath: folderPath.trim() } : {}),
			episodeGroupId: episodeGroupOption || null,
			metadataLanguageMode,
			metadataLanguageValue: metadataLanguageMode === 'explicit' ? metadataLanguageValue : null,
			preferOriginalTitle
		});
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="lg" labelledBy="series-edit-modal-title">
	<!-- Header -->
	<div class="mb-4 flex items-center justify-between">
		<h3 id="series-edit-modal-title" class="text-lg font-bold">{m.library_seriesEdit_title()}</h3>
		<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
			<X class="h-4 w-4" />
		</button>
	</div>

	<!-- Series info -->
	<div class="mb-6 rounded-lg bg-base-200 p-3">
		<div class="font-medium">{series.title}</div>
		{#if series.year}
			<div class="text-sm text-base-content/60">{series.year}</div>
		{/if}
	</div>

	<!-- Form -->
	<div class="space-y-6">
		<!-- Monitoring -->
		<section>
			<h4
				class="mb-3 border-b border-base-300 pb-1.5 text-xs font-semibold tracking-wider text-base-content/50 uppercase"
			>
				Monitoring
			</h4>
			<div class="space-y-3">
				<div class="grid grid-cols-2 gap-3">
					<label class="label cursor-pointer">
						<span class="label-text text-xs text-base-content/80">{m.common_monitored()}</span>
						<input
							type="checkbox"
							class="toggle toggle-primary toggle-sm"
							bind:checked={monitored}
						/>
					</label>
					<label class="label cursor-pointer">
						<span class="label-text text-xs text-base-content/80"
							>{m.library_seriesEdit_autoDownloadSubtitles()}</span
						>
						<input
							type="checkbox"
							class="toggle toggle-primary toggle-sm"
							bind:checked={wantsSubtitles}
						/>
					</label>
				</div>
				<div class="form-control w-full">
					<label class="label py-0.5" for="series-quality-profile">
						<span class="label-text text-xs text-base-content/80"
							>{m.library_seriesEdit_qualityProfile()}</span
						>
					</label>
					<select
						id="series-quality-profile"
						bind:value={qualityProfileId}
						class="select-bordered select w-full select-sm"
					>
						{#if defaultProfile}
							<option value="" hidden
								>{defaultProfile?.name ?? m.common_default()} ({m.common_default()})</option
							>
						{/if}
						<option value={defaultProfile?.id ?? ''}
							>{defaultProfile?.name ?? m.common_default()} ({m.common_default()})</option
						>
						{#each nonDefaultProfiles as profile (profile.id)}
							<option value={profile.id}>{profile.name}</option>
						{/each}
					</select>
				</div>
				<div class="form-control w-full">
					<label class="label py-0.5" for="series-language-profile">
						<span class="label-text text-xs text-base-content/80"
							>{m.library_subtitleProfile_label()}</span
						>
					</label>
					<select
						id="series-language-profile"
						bind:value={languageProfileOverride}
						class="select-bordered select w-full select-sm"
					>
						<option value="">{m.library_subtitleProfile_inherit()}</option>
						{#each languageProfiles as profile (profile.id)}
							<option value={profile.id}>{profile.name}</option>
						{/each}
					</select>
					{#if subtitleProfileHelper}
						<p class="mt-1 text-xs text-base-content/60">{subtitleProfileHelper}</p>
						<p class="mt-1 text-xs text-base-content/60">{m.library_subtitleProfile_help()}</p>
					{/if}
				</div>
				<div class="grid grid-cols-2 gap-3">
					<div class="form-control w-full">
						<label class="label py-0.5" for="series-type">
							<span class="label-text text-xs text-base-content/80"
								>{m.library_seriesEdit_seriesType()}</span
							>
						</label>
						<select
							id="series-type"
							bind:value={seriesType}
							class="select-bordered select w-full select-sm"
						>
							{#each seriesTypeOptions as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
					</div>
					<div class="form-control w-full">
						<label class="label py-0.5" for="episode-group">
							<span class="label-text text-xs text-base-content/80">Episode Ordering</span>
						</label>
						{#if episodeGroupsLoading}
							<select id="episode-group" disabled class="select-bordered select w-full select-sm">
								<option>Loading...</option>
							</select>
						{:else}
							<select
								id="episode-group"
								bind:value={episodeGroupOption}
								class="select-bordered select w-full select-sm"
							>
								{#each episodeGroupOptions as option (option.value)}
									<option value={option.value}>
										{option.label}
										{#if option.type}({option.type}){/if}
									</option>
								{/each}
							</select>
						{/if}
					</div>
				</div>
			</div>
		</section>

		<!-- Scheduling -->
		{#if delayProfiles.length > 0}
			<section>
				<h4
					class="mb-3 border-b border-base-300 pb-1.5 text-xs font-semibold tracking-wider text-base-content/50 uppercase"
				>
					Scheduling
				</h4>
				<div class="form-control w-full">
					<label class="label py-0.5" for="series-delay-profile">
						<span class="label-text text-xs text-base-content/80">Delay Profile</span>
					</label>
					<select
						id="series-delay-profile"
						bind:value={delayProfileId}
						class="select-bordered select w-full select-sm"
					>
						<option value={null}>None</option>
						{#each delayProfiles as profile (profile.id)}
							<option value={profile.id}>{profile.name}</option>
						{/each}
					</select>
				</div>
			</section>
		{/if}

		<!-- Files -->
		<section>
			<h4
				class="mb-3 border-b border-base-300 pb-1.5 text-xs font-semibold tracking-wider text-base-content/50 uppercase"
			>
				Files
			</h4>
			<div class="space-y-3">
				<label class="label cursor-pointer">
					<span class="label-text text-xs text-base-content/80"
						>{m.library_seriesEdit_seasonFolders()}</span
					>
					<input
						type="checkbox"
						class="toggle toggle-primary toggle-sm"
						bind:checked={seasonFolder}
					/>
				</label>

				<div class="form-control w-full">
					<label class="label py-0.5" for="series-root-folder">
						<span class="label-text text-xs text-base-content/80"
							>{m.library_seriesEdit_rootFolder()}</span
						>
					</label>
					<select
						id="series-root-folder"
						bind:value={rootFolderId}
						class="select-bordered select w-full select-sm"
					>
						{#if !rootFolderId}
							<option value="" disabled>{m.common_notSet()}</option>
						{/if}
						{#if selectedRootFolderOutOfPolicy && selectedRootFolderObj}
							<option value={selectedRootFolderObj.id}
								>{selectedRootFolderObj.path} (current)</option
							>
						{/if}
						{#each eligibleRootFolders as folder (folder.id)}
							<option value={folder.id}>
								{folder.path}
								{#if folder.freeSpaceBytes}
									({formatBytes(folder.freeSpaceBytes)} {m.library_seriesEdit_free()})
								{/if}
							</option>
						{/each}
					</select>
					{#if enforceAnimeSubtype}
						<div class="mt-1 text-xs text-base-content/70">
							Limited to <strong>{requiredMediaSubType === 'anime' ? 'Anime' : 'Standard'}</strong> root
							folders.
						</div>
					{/if}
				</div>

				{#if canMoveExistingFiles}
					<label class="label cursor-pointer">
						<span class="label-text text-xs text-warning"
							>Move existing files to new root folder</span
						>
						<input
							type="checkbox"
							class="toggle toggle-primary toggle-sm"
							bind:checked={moveFilesOnRootChange}
							onchange={() => {
								moveOptionTouched = true;
							}}
						/>
					</label>
				{/if}

				{#if series.path}
					<div class="form-control w-full">
						<label class="label py-0.5" for="series-folder-path">
							<span class="label-text flex items-center gap-1 text-xs text-base-content/80">
								Folder name
								<span
									class="tooltip tooltip-right"
									data-tip="Folder name relative to the root folder. Edit only if the name on disk no longer matches; saving will update the database and trigger a rescan to re-link existing files."
								>
									<Info class="h-3 w-3 text-base-content/40" />
								</span>
							</span>
						</label>
						{#if showFolderPicker}
							<FolderBrowser
								value={selectedRootFolderObj?.path ?? '/'}
								onSelect={(selected) => {
									const root = selectedRootFolderObj?.path ?? '';
									folderPath =
										root && selected.startsWith(root + '/')
											? selected.slice(root.length + 1)
											: selected;
									showFolderPicker = false;
								}}
								onCancel={() => (showFolderPicker = false)}
							/>
						{:else}
							<div class="join w-full">
								<input
									id="series-folder-path"
									type="text"
									class="input-bordered input join-item flex-1 font-mono input-sm"
									bind:value={folderPath}
								/>
								<button
									type="button"
									class="btn join-item border border-base-300 btn-ghost btn-sm"
									onclick={() => (showFolderPicker = true)}
									title="Browse"
								>
									<FolderOpen class="h-4 w-4" />
								</button>
							</div>
						{/if}
						{#if resolvedFolderPath}
							<p class="mt-1 font-mono text-xs text-base-content/50">{resolvedFolderPath}</p>
						{/if}
						{#if folderPathChanged}
							<p class="mt-1 text-xs text-warning">
								Folder name changed. A rescan will run after saving.
							</p>
						{/if}
					</div>
				{/if}
			</div>
		</section>

		<!-- Metadata -->
		<section>
			<h4
				class="mb-3 border-b border-base-300 pb-1.5 text-xs font-semibold tracking-wider text-base-content/50 uppercase"
			>
				{m.library_metadata_section()}
			</h4>
			<div class="grid grid-cols-2 gap-3">
				<div class="form-control w-full">
					<label class="label py-0.5" for="series-metadata-language-mode">
						<span class="label-text text-xs text-base-content/80"
							>{m.library_metadata_languageLabel()}</span
						>
					</label>
					<select
						id="series-metadata-language-mode"
						bind:value={metadataLanguageMode}
						class="select-bordered select w-full select-sm"
					>
						<option value="inherit">{m.library_metadata_inheritGlobal()}</option>
						<option value="original">{m.library_metadata_originalLanguage()}</option>
						<option value="explicit">{m.library_metadata_explicitLocale()}</option>
					</select>
				</div>
				<div class="form-control w-full">
					<label class="label py-0.5" for="series-metadata-language-value">
						<span class="label-text text-xs text-base-content/80"
							>{m.library_metadata_locale()}</span
						>
					</label>
					<select
						id="series-metadata-language-value"
						bind:value={metadataLanguageValue}
						disabled={metadataLanguageMode !== 'explicit'}
						class="select-bordered select w-full select-sm"
					>
						{#each LOCALE_OPTIONS as option (option.value)}
							<option value={option.value}>{option.label}</option>
						{/each}
					</select>
				</div>
				<div class="flex items-center justify-between gap-2">
					<label class="label cursor-pointer">
						<span class="label-text text-xs text-base-content/80"
							>{m.library_metadata_preferOriginalTitle()}</span
						>
						<input
							type="checkbox"
							class="toggle toggle-primary toggle-sm"
							checked={preferOriginalTitle === true}
							onchange={(event) => (preferOriginalTitle = event.currentTarget.checked)}
						/>
					</label>
					{#if preferOriginalTitle !== null}
						<button
							type="button"
							class="btn btn-ghost btn-xs"
							onclick={() => (preferOriginalTitle = null)}
						>
							{m.library_subtitleRequirements_reset()}
						</button>
					{/if}
				</div>
			</div>
		</section>
	</div>

	<!-- Actions -->
	<ModalFooter
		onCancel={onClose}
		onSave={handleSave}
		{saving}
		saveLabel={m.library_seriesEdit_saveChanges()}
	/>
</ModalWrapper>
