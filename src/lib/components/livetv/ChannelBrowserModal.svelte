<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { X } from '@lucide/svelte';
	import type { LiveTvAccount, LiveTvCategory, CachedChannel } from '#lib/types/livetv.js';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import * as m from '#lib/paraglide/messages.js';
	import ChannelBrowserFilters from './ChannelBrowserFilters.svelte';
	import ChannelBrowserActions from './ChannelBrowserActions.svelte';
	import ChannelBrowserList from './ChannelBrowserList.svelte';
	import ChannelBrowserPagination from './ChannelBrowserPagination.svelte';
	import {
		getAccounts,
		getCategories,
		getChannels,
		addToLineup,
		getChannelCategories,
		createChannelCategory,
		addLineupBackup
	} from '#lib/api/livetv.js';

	type BrowserMode = 'add-to-lineup' | 'select-backup';

	interface Props {
		open: boolean;
		lineupChannelIds: Set<string>;
		onClose: () => void;
		onChannelsAdded: () => void;
		mode?: BrowserMode;
		lineupItemId?: string;
		excludeChannelId?: string;
		onBackupSelected?: (accountId: string, channelId: string) => void;
	}

	let {
		open,
		lineupChannelIds,
		onClose,
		onChannelsAdded,
		mode = 'add-to-lineup',
		lineupItemId,
		excludeChannelId,
		onBackupSelected
	}: Props = $props();

	const isBackupMode = $derived(mode === 'select-backup');

	let accounts = $state<LiveTvAccount[]>([]);
	let categories = $state<LiveTvCategory[]>([]);
	let channels = $state<CachedChannel[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);

	let selectedAccountId = $state('');
	let selectedCategoryId = $state('');
	let searchQuery = $state('');
	let debouncedSearch = $state('');
	let showAdded = $state(false);

	let page = $state(1);
	let pageSize = $state(50);
	let total = $state(0);
	let totalPages = $state(0);

	let selectedIds = new SvelteSet<string>();
	let addingIds = new SvelteSet<string>();
	let bulkAdding = $state(false);
	let addingCategory = $state(false);

	let localLineupIds = new SvelteSet<string>();

	let wasOpen = $state(false);

	let searchDebounceTimer: ReturnType<typeof setTimeout>;

	let addingBackup = $state(false);

	const isExcluded = (channelId: string) => {
		if (isBackupMode) {
			return channelId === excludeChannelId;
		}
		if (showAdded) {
			return false;
		}
		return localLineupIds.has(channelId);
	};

	const isInLineup = (channelId: string) => localLineupIds.has(channelId);

	const selectableChannels = $derived(channels.filter((c) => !isExcluded(c.id)));
	const visibleChannels = $derived(showAdded || isBackupMode ? channels : selectableChannels);

	const allVisibleSelected = $derived(
		selectableChannels.length > 0 && selectableChannels.every((c) => selectedIds.has(c.id))
	);

	const someVisibleSelected = $derived(
		selectableChannels.some((c) => selectedIds.has(c.id)) && !allVisibleSelected
	);
	const selectedCategory = $derived(
		categories.find((category) => category.id === selectedCategoryId)
	);

	$effect(() => {
		const justOpened = open && !wasOpen;
		wasOpen = open;

		if (justOpened) {
			selectedIds.clear();
			selectedAccountId = '';
			selectedCategoryId = '';
			searchQuery = '';
			debouncedSearch = '';
			page = 1;
			error = null;
			pageSize = showAdded ? 50 : 200;
			localLineupIds.clear();
			for (const id of lineupChannelIds) {
				localLineupIds.add(id);
			}
			loadAccounts();
			loadChannels();
		}
	});

	$effect(() => {
		if (open && wasOpen) {
			localLineupIds.clear();
			for (const id of lineupChannelIds) {
				localLineupIds.add(id);
			}
		}
	});

	$effect(() => {
		const query = searchQuery;
		clearTimeout(searchDebounceTimer);
		searchDebounceTimer = setTimeout(() => {
			if (debouncedSearch !== query) {
				debouncedSearch = query;
				page = 1;
			}
		}, 300);
	});

	$effect(() => {
		if (open) {
			if (selectedAccountId) {
				loadCategories(selectedAccountId);
			} else {
				categories = [];
				selectedCategoryId = '';
			}
		}
	});

	$effect(() => {
		if (open) {
			void selectedAccountId;
			void selectedCategoryId;
			void debouncedSearch;
			void page;
			loadChannels();
		}
	});

	async function loadAccounts() {
		try {
			const result = (await getAccounts()) as unknown as {
				accounts?: LiveTvAccount[];
			};
			accounts = result.accounts?.filter((a: LiveTvAccount) => a.enabled) || [];
		} catch (e) {
			toasts.error(m.livetv_channelBrowserModal_failedToLoadAccounts(), {
				description:
					e instanceof Error ? e.message : m.livetv_channelBrowserModal_failedToLoadAccounts()
			});
		}
	}

	async function loadCategories(_accountId: string) {
		try {
			const data = (await getCategories()) as unknown as { categories?: LiveTvCategory[] };
			categories = data.categories || [];
			selectedCategoryId = '';
		} catch (e) {
			toasts.error(m.livetv_channelBrowserModal_failedToLoadCategories(), {
				description:
					e instanceof Error ? e.message : m.livetv_channelBrowserModal_failedToLoadCategories()
			});
			categories = [];
		}
	}

	async function loadChannels() {
		loading = true;
		error = null;

		const params: Record<string, string> = {};
		params.page = String(page);
		params.pageSize = String(pageSize);

		if (selectedAccountId) {
			params.accountIds = selectedAccountId;
		}
		if (selectedCategoryId) {
			params.categoryIds = selectedCategoryId;
		}
		if (debouncedSearch) {
			params.search = debouncedSearch;
		}

		try {
			const result = await getChannels(params);
			if (!result.success)
				throw new Error(result.error || m.livetv_channelBrowserModal_failedToLoadChannels());
			channels = result.channels || [];
			total = result.total || 0;
			totalPages = result.totalPages || 1;
		} catch (e) {
			error = e instanceof Error ? e.message : m.livetv_channelBrowserModal_failedToLoadChannels();
			channels = [] as CachedChannel[];
		} finally {
			loading = false;
		}
	}

	function toggleSelection(channelId: string) {
		if (isInLineup(channelId)) return;

		if (selectedIds.has(channelId)) {
			selectedIds.delete(channelId);
		} else {
			selectedIds.add(channelId);
		}
	}

	function toggleAllVisible() {
		if (allVisibleSelected) {
			for (const channel of selectableChannels) {
				selectedIds.delete(channel.id);
			}
		} else {
			for (const channel of selectableChannels) {
				selectedIds.add(channel.id);
			}
		}
	}

	function clearSelection() {
		selectedIds.clear();
	}

	async function addSingleChannel(channel: CachedChannel) {
		if (isInLineup(channel.id) || addingIds.has(channel.id)) return;

		addingIds.add(channel.id);

		try {
			await addToLineup([{ accountId: channel.accountId, channelId: channel.id }]);

			localLineupIds.add(channel.id);

			if (selectedIds.has(channel.id)) {
				selectedIds.delete(channel.id);
			}

			onChannelsAdded();
		} catch (e) {
			toasts.error(m.livetv_channelBrowserModal_failedToAddChannel(), {
				description:
					e instanceof Error ? e.message : m.livetv_channelBrowserModal_failedToAddChannel()
			});
		} finally {
			addingIds.delete(channel.id);
		}
	}

	async function addSelectedChannels() {
		if (selectedIds.size === 0 || bulkAdding) return;

		bulkAdding = true;

		const channelsToAdd = channels
			.filter((c) => selectedIds.has(c.id))
			.map((c) => ({ accountId: c.accountId, channelId: c.id }));

		try {
			await addToLineup(channelsToAdd);

			for (const id of selectedIds) {
				localLineupIds.add(id);
			}

			selectedIds.clear();
			onChannelsAdded();
		} catch (e) {
			error = e instanceof Error ? e.message : m.livetv_channelBrowserModal_failedToAddChannels();
		} finally {
			bulkAdding = false;
		}
	}

	async function getAllChannelsForSelectedCategory(): Promise<CachedChannel[]> {
		if (!selectedAccountId || !selectedCategoryId) {
			return [];
		}

		const categoryChannels: CachedChannel[] = [];
		let currentPage = 1;
		let hasMore = true;
		const fetchPageSize = 500;

		while (hasMore) {
			const params: Record<string, string> = {
				page: String(currentPage),
				pageSize: String(fetchPageSize),
				accountIds: selectedAccountId,
				categoryIds: selectedCategoryId
			};

			const result = await getChannels(params);
			if (!result.success) {
				throw new Error(result.error || m.livetv_channelBrowserModal_failedToLoadChannels());
			}

			const pageChannels = (result.channels ?? []) as CachedChannel[];
			categoryChannels.push(...pageChannels);

			const totalPagesForQuery = Math.max(1, Number(result.totalPages || 1));
			currentPage++;
			hasMore = currentPage <= totalPagesForQuery;
		}

		return categoryChannels;
	}

	async function getOrCreateLineupCategoryId(name: string): Promise<string> {
		const normalizedName = name.trim();
		if (!normalizedName) {
			throw new Error('Selected category has no name');
		}

		const existingData = await getChannelCategories();
		const existingCategories = (existingData.categories ?? []) as Array<{
			id: string;
			name: string;
		}>;
		const existing = existingCategories.find(
			(category) => category.name?.trim().toLowerCase() === normalizedName.toLowerCase()
		);
		if (existing?.id) {
			return existing.id;
		}

		const createData = (await createChannelCategory({ name: normalizedName })) as unknown as {
			category?: { id?: string };
		};
		const categoryId = createData.category?.id as string | undefined;
		if (!categoryId) {
			throw new Error(m.livetv_channelBrowserModal_failedToCreate());
		}

		return categoryId;
	}

	async function addSelectedCategoryChannels() {
		if (!selectedAccountId || !selectedCategoryId || addingCategory) return;

		addingCategory = true;
		error = null;

		try {
			const lineupCategoryName = selectedCategory?.title?.trim();
			if (!lineupCategoryName) {
				throw new Error(m.livetv_channelBrowserModal_failedToAddCategory());
			}
			const lineupCategoryId = await getOrCreateLineupCategoryId(lineupCategoryName);
			const categoryChannels = await getAllChannelsForSelectedCategory();

			if (categoryChannels.length === 0) {
				return;
			}

			await addToLineup(
				categoryChannels.map((channel) => ({
					accountId: channel.accountId,
					channelId: channel.id,
					categoryId: lineupCategoryId
				}))
			);

			for (const channel of categoryChannels) {
				localLineupIds.add(channel.id);
				selectedIds.delete(channel.id);
			}

			onChannelsAdded();
			await loadChannels();
		} catch (e) {
			error = e instanceof Error ? e.message : m.livetv_channelBrowserModal_failedToAddCategory();
		} finally {
			addingCategory = false;
		}
	}

	async function selectAsBackup(channel: CachedChannel) {
		if (!lineupItemId || !onBackupSelected || addingBackup) return;
		if (channel.id === excludeChannelId) return;

		addingBackup = true;
		try {
			await addLineupBackup(lineupItemId, {
				accountId: channel.accountId,
				channelId: channel.id
			});

			onBackupSelected(channel.accountId, channel.id);
			onClose();
		} catch (e) {
			error = e instanceof Error ? e.message : m.livetv_channelBrowserModal_failedToAddBackup();
		} finally {
			addingBackup = false;
		}
	}

	function handleFilterChange() {
		page = 1;
		selectedIds.clear();
	}

	function onAccountChange(accountId: string) {
		selectedAccountId = accountId;
		handleFilterChange();
	}

	function onCategoryChange(categoryId: string) {
		selectedCategoryId = categoryId;
		handleFilterChange();
	}

	function onSearchInput(value: string) {
		searchQuery = value;
	}

	function onToggleAdded() {
		showAdded = !showAdded;
		pageSize = showAdded ? 50 : 200;
		page = 1;
		selectedIds.clear();
	}

	function onPagePrevious() {
		page = page - 1;
	}

	function onPageNext() {
		page = page + 1;
	}
</script>

<ModalWrapper {open} {onClose} maxWidth="5xl" labelledBy="channel-browser-modal-title">
	<div class="mb-4 flex items-center justify-between">
		<div>
			<h3 id="channel-browser-modal-title" class="text-lg font-bold">
				{isBackupMode
					? m.livetv_channelBrowserModal_titleSelectBackup()
					: m.livetv_channelBrowserModal_titleBrowse()}
			</h3>
			<p class="text-sm text-base-content/60">
				{isBackupMode
					? m.livetv_channelBrowserModal_subtitleSelectBackup()
					: m.livetv_channelBrowserModal_subtitleBrowse()}
			</p>
		</div>
		<button class="btn btn-circle btn-ghost btn-sm" onclick={onClose}>
			<X class="h-4 w-4" />
		</button>
	</div>

	<ChannelBrowserFilters
		{accounts}
		{categories}
		{selectedAccountId}
		{selectedCategoryId}
		{searchQuery}
		{onAccountChange}
		{onCategoryChange}
		{onSearchInput}
	/>

	{#if !isBackupMode}
		<ChannelBrowserActions
			{total}
			selectedCount={selectedIds.size}
			selectableChannelCount={selectableChannels.length}
			{showAdded}
			{selectedAccountId}
			{selectedCategoryId}
			selectedCategoryName={selectedCategory?.title}
			selectedCategoryCount={selectedCategory?.channelCount ?? 0}
			{loading}
			{addingCategory}
			{bulkAdding}
			{onToggleAdded}
			onAddCategory={addSelectedCategoryChannels}
			onAddSelected={addSelectedChannels}
			onClearSelection={clearSelection}
			onToggleAllVisible={toggleAllVisible}
		/>
	{:else}
		<div class="mb-2 text-sm text-base-content/60">
			{m.livetv_channelBrowserModal_resultsCount({ count: total })}
		</div>
	{/if}

	{#if error}
		<div class="mb-2 alert alert-error">
			<span>{error}</span>
			<button class="btn btn-ghost btn-xs" onclick={loadChannels}>{m.common_retry()}</button>
		</div>
	{/if}

	<ChannelBrowserList
		{channels}
		{visibleChannels}
		{selectedIds}
		{addingIds}
		{loading}
		{isBackupMode}
		{addingBackup}
		{isExcluded}
		{isInLineup}
		{allVisibleSelected}
		{someVisibleSelected}
		{selectableChannels}
		{debouncedSearch}
		{selectedAccountId}
		{selectedCategoryId}
		onToggleSelection={toggleSelection}
		onAddSingleChannel={addSingleChannel}
		onSelectBackup={selectAsBackup}
		onToggleAllVisible={toggleAllVisible}
	/>

	<ChannelBrowserPagination
		{page}
		{totalPages}
		{loading}
		onPrevious={onPagePrevious}
		onNext={onPageNext}
	/>

	<div class="modal-action">
		<button class="btn" onclick={onClose}>{m.livetv_channelBrowserModal_done()}</button>
	</div>
</ModalWrapper>
