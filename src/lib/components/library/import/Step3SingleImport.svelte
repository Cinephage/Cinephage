<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { Check, Clock, Loader2 } from '@lucide/svelte';
	import type { MediaType, DetectionGroup, MatchResult } from './types.js';

	interface DestinationLibrary {
		id: string;
		name: string;
		slug: string;
		mediaType: MediaType;
		mediaSubType?: string | null;
		isDefault?: boolean;
		isDefaultFolder?: boolean;
		defaultRootFolderId?: string | null;
		defaultRootFolderPath?: string | null;
	}

	interface ImportRouteContext {
		mediaType: MediaType;
		tmdbId: number;
		libraryId: string | null;
		title: string | null;
		year: number | null;
	}

	let {
		activeGroup,
		selectedMatch,
		selectedMediaType = 'movie' as MediaType,
		importTarget = $bindable('new' as 'new' | 'existing'),
		destinationLibrariesForType = [],
		selectedRootFolder = $bindable(''),
		importMode = $bindable('move' as 'move' | 'copy' | 'symlink'),
		preferHardlink = $bindable(true),
		backgroundImport = $bindable(false),
		loadingRootFolders = false,
		seasonNumber = 1,
		episodeNumber = 1,
		batchSeasonOverride = null,
		canProceedToImport = false,
		executingImport = false,
		selectedMatchContextMismatch = false,
		routeImportContext = null,
		onGoToStep = (_step: number) => {},
		onExecuteImport = () => {},
		onRootFolderChange = () => {}
	}: {
		// eslint-disable-next-line svelte/no-unused-props
		activeGroup: DetectionGroup;
		// eslint-disable-next-line svelte/no-unused-props
		selectedMatch: MatchResult;
		selectedMediaType: MediaType;
		importTarget: 'new' | 'existing';
		destinationLibrariesForType: DestinationLibrary[];
		selectedRootFolder: string;
		importMode: 'move' | 'copy' | 'symlink';
		preferHardlink: boolean;
		backgroundImport: boolean;
		loadingRootFolders: boolean;
		seasonNumber: number;
		episodeNumber: number;
		batchSeasonOverride: number | null;
		canProceedToImport: boolean;
		executingImport: boolean;
		selectedMatchContextMismatch: boolean;
		routeImportContext: ImportRouteContext | null;
		onGoToStep: (step: number) => void;
		onExecuteImport: () => void;
		onRootFolderChange: () => void;
	} = $props();

	function formatMediaTypeLabel(mediaType: MediaType): string {
		return mediaType === 'movie' ? m.library_import_movieLabel() : m.library_import_tvShowLabel();
	}
</script>

<div class="space-y-4">
	<div class="rounded-xl border border-base-300 bg-base-100 p-4 sm:p-5">
		<h2 class="text-lg font-semibold">{m.library_import_importTargetHeading()}</h2>
		<p class="mt-1 text-sm text-base-content/70">
			{m.library_import_importTargetHint()}
		</p>
		<div class="mt-4 grid gap-2 sm:grid-cols-2">
			<label
				class="flex cursor-pointer items-start gap-3 rounded-lg border border-base-300 p-3 {selectedMatch.inLibrary
					? 'opacity-60'
					: ''}"
			>
				<input
					type="radio"
					name="import-target"
					class="radio mt-1 radio-primary"
					checked={importTarget === 'new'}
					onchange={() => !selectedMatch?.inLibrary && (importTarget = 'new')}
					disabled={selectedMatch?.inLibrary}
				/>
				<div>
					<div class="font-medium">{m.library_import_createNew()}</div>
					<div class="text-sm text-base-content/70">
						{m.library_import_createNewHint()}
					</div>
				</div>
			</label>
			<label
				class="flex cursor-pointer items-start gap-3 rounded-lg border border-base-300 p-3 {selectedMatch.inLibrary
					? ''
					: 'opacity-60'}"
			>
				<input
					type="radio"
					name="import-target"
					class="radio mt-1 radio-primary"
					checked={importTarget === 'existing'}
					onchange={() => selectedMatch?.inLibrary && (importTarget = 'existing')}
					disabled={!selectedMatch?.inLibrary}
				/>
				<div>
					<div class="font-medium">{m.library_import_matchExisting()}</div>
					<div class="text-sm text-base-content/70">
						{m.library_import_matchExistingHint()}
					</div>
				</div>
			</label>
		</div>
	</div>

	{#if importTarget === 'new'}
		<div class="rounded-xl border border-base-300 bg-base-100 p-4 sm:p-5">
			<h3 class="font-semibold">{m.library_import_destinationRootFolder()}</h3>
			{#if loadingRootFolders}
				<div class="mt-2 flex items-center gap-2 text-sm text-base-content/70">
					<Loader2 class="h-4 w-4 animate-spin" />
					{m.library_import_loadingFolders()}
				</div>
			{:else if destinationLibrariesForType.length === 0}
				<div class="mt-3 alert text-sm alert-warning">
					<span>{m.library_import_noWritableFolders()}</span>
				</div>
			{:else}
				<select
					class="select-bordered select mt-3 w-full"
					bind:value={selectedRootFolder}
					onchange={onRootFolderChange}
				>
					<option disabled value="">{m.library_import_selectRootFolder()}</option>
					{#each destinationLibrariesForType as library (library.id)}
						<option value={library.id}
							>{library.name}
							{#if library.defaultRootFolderPath}
								- {library.defaultRootFolderPath}
							{/if}</option
						>
					{/each}
				</select>
			{/if}
		</div>
	{:else}
		<div class="rounded-xl border border-base-300 bg-base-100 p-4 sm:p-5">
			<h3 class="font-semibold">{m.library_import_existingItemMatch()}</h3>
			<div class="mt-2 text-sm text-base-content/70">
				{m.library_import_importingIntoExisting()}
				<span class="font-medium text-base-content">{selectedMatch.title}</span>
			</div>
		</div>
	{/if}

	<!-- Import Method -->
	<div class="rounded-xl border border-base-300 bg-base-100 p-4 sm:p-5">
		<h3 class="font-semibold">{m.library_import_importMethodHeading()}</h3>
		<div class="mt-3 grid gap-2 sm:grid-cols-3">
			<label
				class="flex items-start gap-3 rounded-lg border p-3 transition-colors
					{importMode === 'move' ? 'border-primary bg-primary/5' : 'border-base-300'}
					{executingImport ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}"
			>
				<input
					type="radio"
					name="import-method"
					class="radio mt-0.5 radio-primary"
					value="move"
					bind:group={importMode}
					disabled={executingImport}
				/>
				<div>
					<div class="font-medium">{m.library_import_importMethodMove()}</div>
					<div class="text-sm text-base-content/70">{m.library_import_importMethodMoveDesc()}</div>
				</div>
			</label>
			<label
				class="flex items-start gap-3 rounded-lg border p-3 transition-colors
					{importMode === 'copy' ? 'border-primary bg-primary/5' : 'border-base-300'}
					{executingImport ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}"
			>
				<input
					type="radio"
					name="import-method"
					class="radio mt-0.5 radio-primary"
					value="copy"
					bind:group={importMode}
					disabled={executingImport}
				/>
				<div>
					<div class="font-medium">{m.library_import_importMethodCopy()}</div>
					<div class="text-sm text-base-content/70">{m.library_import_importMethodCopyDesc()}</div>
				</div>
			</label>
			<label
				class="flex items-start gap-3 rounded-lg border p-3 transition-colors
					{importMode === 'symlink' ? 'border-primary bg-primary/5' : 'border-base-300'}
					{executingImport ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}"
			>
				<input
					type="radio"
					name="import-method"
					class="radio mt-0.5 radio-primary"
					value="symlink"
					bind:group={importMode}
					disabled={executingImport}
				/>
				<div>
					<div class="font-medium">{m.library_import_importMethodSymlink()}</div>
					<div class="text-sm text-base-content/70">
						{m.library_import_importMethodSymlinkDesc()}
					</div>
				</div>
			</label>
		</div>
		<label
			class="mt-3 flex items-start gap-3 rounded-lg border p-3 transition-colors
				{importMode === 'copy' ? 'border-primary/40 bg-base-200/50' : 'border-base-300 opacity-50'}
				{executingImport || importMode !== 'copy' ? 'cursor-not-allowed' : 'cursor-pointer'}"
		>
			<input
				type="checkbox"
				class="checkbox mt-0.5 checkbox-primary"
				bind:checked={preferHardlink}
				disabled={executingImport || importMode !== 'copy'}
			/>
			<div>
				<div class="font-medium">{m.library_import_preferHardlinkLabel()}</div>
				<div class="text-sm text-base-content/70">{m.library_import_preferHardlinkDesc()}</div>
			</div>
		</label>
	</div>

	<div class="rounded-xl border border-base-300 bg-base-100 p-4 sm:p-5">
		<h3 class="font-semibold">{m.library_import_summaryHeading()}</h3>
		{#if selectedMatchContextMismatch && routeImportContext}
			<div class="mt-3 alert text-sm alert-warning">
				<span>
					{m.library_import_importOpenedFor()}
					<strong
						>{routeImportContext.title || `TMDB ${routeImportContext.tmdbId}`}
						{#if routeImportContext.year}
							({routeImportContext.year})
						{/if}</strong
					>, {m.library_import_butSelectedMatchIs()}
					<strong
						>{selectedMatch.title}
						{#if selectedMatch.year}
							({selectedMatch.year})
						{/if}</strong
					>.
				</span>
			</div>
		{/if}
		<div class="mt-2 space-y-1 text-sm">
			<div>
				<span class="text-base-content/60">{m.library_import_summarySource()}</span>
				{activeGroup.sourcePath}
			</div>
			<div>
				<span class="text-base-content/60">{m.library_import_summaryMatch()}</span>
				{selectedMatch.title}
				{#if selectedMatch.year}
					({selectedMatch.year})
				{/if}
			</div>
			<div>
				<span class="text-base-content/60">{m.library_import_summaryType()}</span>
				{formatMediaTypeLabel(selectedMediaType)}
			</div>
			{#if selectedMediaType === 'tv'}
				<div>
					{#if activeGroup.detectedFileCount > 1}
						<span class="text-base-content/60">{m.library_import_summaryDetectedEpisodes()}</span>
						{m.library_import_summaryFilesCount({ count: activeGroup.detectedFileCount })}
						{#if activeGroup.detectedSeasons && activeGroup.detectedSeasons.length > 0}
							({m.library_import_summarySeasonsInline({
								seasons: activeGroup.detectedSeasons.join(', ')
							})})
						{/if}
						{#if batchSeasonOverride !== null}
							<span class="ml-2 text-base-content/70"
								>{m.library_import_summaryOverrideSeason({ season: batchSeasonOverride })}</span
							>
						{/if}
					{:else}
						<span class="text-base-content/60">{m.library_import_summaryEpisode()}</span>
						{#if activeGroup.parsedEpisodes && activeGroup.parsedEpisodes.length > 1}
							S{seasonNumber}E{activeGroup.parsedEpisodes[0]}-E{activeGroup.parsedEpisodes[
								activeGroup.parsedEpisodes.length - 1
							]}
						{:else}
							S{seasonNumber}E{episodeNumber}
						{/if}
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<label
		class="flex cursor-pointer items-center justify-between gap-4 rounded-xl border p-4 transition-colors sm:p-5
			{backgroundImport ? 'border-primary bg-primary/5' : 'border-base-300 bg-base-100'}
			{executingImport ? 'cursor-not-allowed opacity-50' : ''}"
	>
		<span class="flex items-start gap-3">
			<span
				class="mt-0.5 rounded-lg p-2 {backgroundImport
					? 'bg-primary/10 text-primary'
					: 'bg-base-200 text-base-content/60'}"
			>
				<Clock class="h-4 w-4" />
			</span>
			<span>
				<span class="block font-medium">{m.library_import_runInBackground()}</span>
				<span class="block text-sm text-base-content/70"
					>{m.library_import_runInBackgroundHint()}</span
				>
			</span>
		</span>
		<input
			type="checkbox"
			class="toggle toggle-primary"
			bind:checked={backgroundImport}
			disabled={executingImport}
		/>
	</label>

	<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
		<button class="btn btn-ghost" onclick={() => onGoToStep(2)}>{m.action_back()}</button>
		<button
			class="btn btn-primary"
			onclick={onExecuteImport}
			disabled={!canProceedToImport || executingImport}
		>
			{#if executingImport}
				<Loader2 class="h-4 w-4 animate-spin" />
				{m.library_import_importing()}
			{:else}
				<Check class="h-4 w-4" />
				{m.library_import_startImport()}
			{/if}
		</button>
	</div>
</div>
