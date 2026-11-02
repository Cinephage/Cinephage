<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import ReviewItemList from './ReviewItemList.svelte';
	import type { DetectionGroup, DetectionSection } from './types.js';

	type ReviewStatus = 'needsInput' | 'ready' | 'skipped' | 'imported';

	let {
		reviewDetectionSections = [],
		reviewMovieSections = [],
		reviewTvSections = [],
		selectedGroupId = null,
		importedGroupIds = [],
		skippedGroupIds = [],
		canImportGroup = (_group: DetectionGroup) => false,
		suggestsTvFromMovie = (_group: DetectionGroup) => false,
		getSeriesSectionStatus = (_section: DetectionSection) => 'needsInput' as ReviewStatus,
		getGroupSelectedMatch = (_group: DetectionGroup) =>
			null as import('./types.js').MatchResult | null,
		getGroupActionLabel = (_group: DetectionGroup) => null as 'link' | 'enroll' | null,
		onSwitchGroup = (_id: string) => {},
		onSelectReviewSeriesSection = (_id: string) => {}
	}: {
		reviewDetectionSections: DetectionSection[];
		reviewMovieSections: DetectionSection[];
		reviewTvSections: DetectionSection[];
		selectedGroupId: string | null;
		importedGroupIds: string[];
		skippedGroupIds: string[];
		canImportGroup: (group: DetectionGroup) => boolean;
		suggestsTvFromMovie: (group: DetectionGroup) => boolean;
		getSeriesSectionStatus: (section: DetectionSection) => ReviewStatus;
		getGroupSelectedMatch: (group: DetectionGroup) => import('./types.js').MatchResult | null;
		getGroupActionLabel: (group: DetectionGroup) => 'link' | 'enroll' | null;
		onSwitchGroup: (id: string) => void;
		onSelectReviewSeriesSection: (id: string) => void;
	} = $props();
</script>

<div class="rounded-xl border border-base-300 bg-base-100 p-3">
	{#if reviewDetectionSections.length === 0}
		<div
			class="rounded-lg border border-dashed border-base-300 p-4 text-center text-sm text-base-content/60"
		>
			{m.library_import_noDetectedItemsMatch()}
		</div>
	{:else}
		<ReviewItemList
			movieSections={reviewMovieSections}
			tvSections={reviewTvSections}
			{selectedGroupId}
			{importedGroupIds}
			{skippedGroupIds}
			{canImportGroup}
			{suggestsTvFromMovie}
			{getSeriesSectionStatus}
			{getGroupSelectedMatch}
			{getGroupActionLabel}
			onSelectGroup={onSwitchGroup}
			onSelectSeries={onSelectReviewSeriesSection}
		/>
	{/if}
</div>
