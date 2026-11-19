<script lang="ts">
	/**
	 * Everything the library lists do with a selection: the floating action bar and
	 * the four dialogs behind it (quality profile, language profile, single-item
	 * delete, bulk delete).
	 *
	 * The page keeps the state machine and the API calls; this component owns the
	 * controls, so the three lists cannot drift on what a selection can do.
	 */
	import LibraryBulkActionBar from '#lib/components/library/LibraryBulkActionBar.svelte';
	import BulkQualityProfileModal from '#lib/components/library/BulkQualityProfileModal.svelte';
	import BulkLanguageProfileModal from '#lib/components/library/BulkLanguageProfileModal.svelte';
	import BulkDeleteModal from '#lib/components/library/BulkDeleteModal.svelte';
	import DeleteConfirmationModal from '#lib/components/ui/modal/DeleteConfirmationModal.svelte';
	import type { QualityProfileOption } from '#lib/types/profile.js';

	interface Props {
		/** Admin only — the whole block is hidden for viewer accounts. */
		show: boolean;
		selectedCount: number;
		selectedIds: string[];
		mediaType: 'movie' | 'tv';
		qualityProfiles: QualityProfileOption[];

		loading: boolean;
		currentAction: 'monitor' | 'unmonitor' | 'quality' | 'delete' | 'language' | null;

		/** Ids with an active download, for the delete warning. */
		downloadingIds: Set<string>;
		/** Set when the delete dialog targets one row instead of the selection. */
		pendingItem: { id: string; title: string; hasFile: boolean | null } | null;

		/** Dialog visibility — the page owns it. */
		qualityOpen: boolean;
		languageOpen: boolean;
		deleteOpen: boolean;

		onMonitor: () => void;
		onUnmonitor: () => void;
		onChangeQuality: () => void;
		onQualitySave: (profileId: string | null) => void;
		onQualityCancel: () => void;
		onLanguage: () => void;
		onLanguageClose: () => void;
		onLanguageApplied: (updated: number) => void;
		onDelete: () => void;
		onDeleteConfirm: (deleteFiles: boolean, removeFromLibrary: boolean) => void;
		onDeleteCancel: () => void;
		onClear: () => void;

		/** Kind-specific copy. */
		deleteTitle: string;
	}

	let {
		show,
		selectedCount,
		selectedIds,
		mediaType,
		qualityProfiles,
		loading,
		currentAction,
		downloadingIds,
		pendingItem,
		qualityOpen,
		languageOpen,
		deleteOpen,
		onMonitor,
		onUnmonitor,
		onChangeQuality,
		onQualitySave,
		onQualityCancel,
		onLanguage,
		onLanguageClose,
		onLanguageApplied,
		onDelete,
		onDeleteConfirm,
		onDeleteCancel,
		onClear,
		deleteTitle
	}: Props = $props();

	const deleteModalCount = $derived(pendingItem ? 1 : selectedCount);
	const pendingHasActiveDownload = $derived(
		pendingItem ? downloadingIds.has(pendingItem.id) : false
	);
	const bulkActiveDownloadCount = $derived(
		pendingItem ? 0 : selectedIds.filter((id) => downloadingIds.has(id)).length
	);
	/** The language-profile modal kept the older 'movie' | 'series' vocabulary. */
	const languageMediaType = $derived(mediaType === 'movie' ? 'movie' : 'series');
</script>

{#if show}
	<LibraryBulkActionBar
		{selectedCount}
		{loading}
		{currentAction}
		{mediaType}
		{onMonitor}
		{onUnmonitor}
		{onChangeQuality}
		{onLanguage}
		{onDelete}
		{onClear}
	/>
{/if}

<BulkQualityProfileModal
	open={qualityOpen}
	{selectedCount}
	{qualityProfiles}
	saving={loading && currentAction === 'quality'}
	{mediaType}
	onSave={onQualitySave}
	onCancel={onQualityCancel}
/>

<BulkLanguageProfileModal
	open={languageOpen}
	mediaType={languageMediaType}
	{selectedIds}
	onClose={onLanguageClose}
	onApplied={onLanguageApplied}
/>

<!-- Single item delete -->
<DeleteConfirmationModal
	open={deleteOpen && pendingItem !== null}
	title={deleteTitle}
	itemName={pendingItem?.title ?? ''}
	hasFiles={pendingItem?.hasFile ?? false}
	hasActiveDownload={pendingHasActiveDownload}
	loading={loading && currentAction === 'delete'}
	onConfirm={onDeleteConfirm}
	onCancel={onDeleteCancel}
/>

<!-- Bulk delete -->
<BulkDeleteModal
	open={deleteOpen && pendingItem === null}
	selectedCount={deleteModalCount}
	{mediaType}
	hasActiveDownloads={bulkActiveDownloadCount > 0}
	activeDownloadCount={bulkActiveDownloadCount}
	loading={loading && currentAction === 'delete'}
	onConfirm={onDeleteConfirm}
	onCancel={onDeleteCancel}
/>
