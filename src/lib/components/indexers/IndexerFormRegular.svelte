<script lang="ts">
	import { ChevronDown, Lock, Unlock, Globe, Shield } from '@lucide/svelte';
	import type { IndexerDefinition } from '#lib/types/indexer.js';
	import * as m from '#lib/paraglide/messages.js';
	import IndexerSettingsFields from './IndexerSettingsFields.svelte';
	import { SectionHeader, ToggleSetting } from '#lib/components/ui/modal/index.js';
	import { isSensitiveDefinitionSetting } from '#lib/shared/sensitiveSettings.js';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';

	interface Props {
		definition: IndexerDefinition | null;
		name: string;
		url: string;
		urlError: string;
		priority: number;
		/** User override for max requests/minute sent to this indexer. Null = use definition/default. */
		rateLimitPerMinute: number | null;
		enabled: boolean;
		settings: Record<string, string>;
		hasSensitiveSettings?: Record<string, boolean>;
		enableAutomaticSearch: boolean;
		enableInteractiveSearch: boolean;
		minimumSeeders: number;
		seedRatio: string;
		seedTime: number | '';
		packSeedTime: number | '';
		rejectDeadTorrents: boolean;
		rejectPasswordProtected: boolean;
		minimumCompletionPercentage: number;
		isTorrent: boolean;
		isUsenet: boolean;
		isStreaming: boolean;
		hasAuthSettings: boolean;
		definitionUrls: string[];
		alternateUrls: string[];
		prowlarrManaged?: boolean;
		jackettManaged?: boolean;
		/** Override URL shown in the read-only managed display (e.g. virtual path for Jackett). */
		managedDisplayUrl?: string;
		onNameChange: (value: string) => void;
		onUrlChange: (value: string) => void;
		onUrlBlur: () => void;
		onPriorityChange: (value: number) => void;
		onRateLimitPerMinuteChange: (value: number | null) => void;
		onEnabledChange: (value: boolean) => void;
		onSettingsChange: (settings: Record<string, string>) => void;
		onAutomaticSearchChange: (value: boolean) => void;
		onInteractiveSearchChange: (value: boolean) => void;
		onMinimumSeedersChange: (value: number) => void;
		onSeedRatioChange: (value: string) => void;
		onSeedTimeChange: (value: number | '') => void;
		onPackSeedTimeChange: (value: number | '') => void;
		onRejectDeadTorrentsChange: (value: boolean) => void;
		onRejectPasswordProtectedChange: (value: boolean) => void;
		onMinimumCompletionPercentageChange: (value: number) => void;
		additionalCategories?: number[];
		onAdditionalCategoriesChange?: (value: number[]) => void;
	}

	let {
		definition,
		name,
		url,
		urlError,
		priority,
		rateLimitPerMinute,
		enabled,
		settings,
		hasSensitiveSettings = {},
		enableAutomaticSearch,
		enableInteractiveSearch,
		minimumSeeders,
		seedRatio,
		seedTime,
		packSeedTime,
		rejectDeadTorrents,
		rejectPasswordProtected,
		minimumCompletionPercentage,
		isTorrent,
		isUsenet,
		isStreaming,
		hasAuthSettings,
		definitionUrls,
		alternateUrls,
		prowlarrManaged = false,
		jackettManaged = false,
		managedDisplayUrl = undefined,
		onNameChange,
		onUrlChange,
		onUrlBlur,
		onPriorityChange,
		onRateLimitPerMinuteChange,
		onEnabledChange,
		onSettingsChange,
		onAutomaticSearchChange,
		onInteractiveSearchChange,
		onMinimumSeedersChange,
		onSeedRatioChange,
		onSeedTimeChange,
		onPackSeedTimeChange,
		onRejectDeadTorrentsChange,
		onRejectPasswordProtectedChange,
		onMinimumCompletionPercentageChange,
		additionalCategories = [],
		onAdditionalCategoriesChange
	}: Props = $props();

	const MAX_NAME_LENGTH = 20;
	const nameTooLong = $derived(name.length > MAX_NAME_LENGTH);

	// Collapsible section states
	let authSettingsOpen = $state(true);
	let torrentSettingsOpen = $state(false);
	let usenetSettingsOpen = $state(false);
	let categoriesOpen = $state(false);

	// Show the category restriction panel for newznab/torznab/prowlarr/jackett definitions
	const isNewznabLike = $derived(
		definition?.id === 'newznab' ||
			definition?.id === 'torznab' ||
			definition?.id === 'prowlarr' ||
			definition?.id === 'jackett'
	);

	// Build a parent→children tree from the YAML-defined category map.
	// Parents have IDs where id % 1000 === 0 (2000, 5000, 6000, 8000).
	// Children group under Math.floor(childId / 1000) * 1000.
	type CatNode = { id: number; name: string; children: { id: number; name: string }[] };
	const categoryTree = $derived.by((): CatNode[] => {
		const raw = definition?.capabilities?.categories;
		if (!raw) return [];
		const groups = new SvelteMap<number, CatNode>();
		// First pass: parents
		for (const [idStr, catName] of Object.entries(raw)) {
			const id = parseInt(idStr, 10);
			if (isNaN(id)) continue;
			if (id % 1000 === 0) groups.set(id, { id, name: catName, children: [] });
		}
		// Second pass: children
		for (const [idStr, catName] of Object.entries(raw)) {
			const id = parseInt(idStr, 10);
			if (isNaN(id) || id % 1000 === 0) continue;
			const parentId = Math.floor(id / 1000) * 1000;
			groups.get(parentId)?.children.push({ id, name: catName });
		}
		return [...groups.values()].sort((a, b) => a.id - b.id);
	});

	// All category IDs from the static list (parents + children)
	const allCatIds = $derived(categoryTree.flatMap((g) => [g.id, ...g.children.map((c) => c.id)]));

	// Which IDs are currently selected. Re-initialises whenever the definition changes
	// (allCatIds) or the prop changes (switching between indexers in the modal).
	let selectedIds = $state<Set<number>>(new Set());

	$effect(() => {
		void allCatIds; // re-run when definition changes
		selectedIds =
			additionalCategories && additionalCategories.length > 0
				? new Set(additionalCategories)
				: new Set();
	});

	function emitChange(next: Set<number>) {
		onAdditionalCategoriesChange?.([...next]);
	}

	function toggleParent(group: CatNode) {
		const next = new SvelteSet(selectedIds);
		const allChildChecked =
			group.children.length === 0
				? next.has(group.id)
				: group.children.every((c) => next.has(c.id));
		if (allChildChecked) {
			next.delete(group.id);
			group.children.forEach((c) => next.delete(c.id));
		} else {
			next.add(group.id);
			group.children.forEach((c) => next.add(c.id));
		}
		selectedIds = next;
		emitChange(next);
	}

	function toggleChild(parentId: number, childId: number, siblings: { id: number }[]) {
		const next = new SvelteSet(selectedIds);
		if (next.has(childId)) {
			next.delete(childId);
		} else {
			next.add(childId);
		}
		// Keep parent in sync: check parent if all siblings checked, uncheck if none
		if (siblings.every((s) => next.has(s.id))) {
			next.add(parentId);
		} else {
			next.delete(parentId);
		}
		selectedIds = next;
		emitChange(next);
	}

	function selectAll() {
		const next = new Set(allCatIds);
		selectedIds = next;
		emitChange(next);
	}

	function clearAll() {
		const next = new Set<number>();
		selectedIds = next;
		emitChange(next);
	}

	const restrictionSummary = $derived.by(() => {
		if (allCatIds.length === 0) return '';
		if (selectedIds.size === 0) return 'Open search';
		return `${selectedIds.size} / ${allCatIds.length} categories`;
	});

	function shouldTreatSettingConfigured(name: string, type: string): boolean {
		return isSensitiveDefinitionSetting({ name, type })
			? Boolean(hasSensitiveSettings[name])
			: false;
	}

	const authSummary = $derived.by(() => {
		if (!definition?.settings) return 'No configuration required';

		const editableSettings = definition.settings.filter((s) => !s.type.startsWith('info'));

		if (editableSettings.length === 0) return 'No configuration required';

		const configuredCount = editableSettings.filter((s) => {
			const val = settings[s.name];
			return shouldTreatSettingConfigured(s.name, s.type) || (val && val.trim() !== '');
		}).length;

		if (configuredCount === 0) return 'Not configured';
		if (configuredCount === editableSettings.length) return 'Fully configured';
		return `${configuredCount}/${editableSettings.length} fields configured`;
	});

	const authIcon = $derived.by(() => {
		if (!definition?.settings) return Unlock;
		const editableSettings = definition.settings.filter((s) => !s.type.startsWith('info'));
		if (editableSettings.length === 0) return Globe;

		const configuredCount = editableSettings.filter((s) => {
			const val = settings[s.name];
			return shouldTreatSettingConfigured(s.name, s.type) || (val && val.trim() !== '');
		}).length;

		if (configuredCount === editableSettings.length) return Shield;
		if (configuredCount > 0) return Lock;
		return Unlock;
	});

	// Build a concise summary of current torrent settings for the collapsed header
	const torrentSummary = $derived.by(() => {
		const parts: string[] = [];
		parts.push(`Min Seeders: ${minimumSeeders}`);
		if (seedRatio) {
			parts.push(`Ratio: ${seedRatio}`);
		}
		if (seedTime !== '' && seedTime > 0) {
			parts.push(`Seed: ${seedTime}m`);
		}
		if (packSeedTime !== '' && packSeedTime > 0) {
			parts.push(`Pack: ${packSeedTime}m`);
		}
		parts.push(rejectDeadTorrents ? 'Reject Dead' : 'Allow Dead');
		return parts.join(' · ');
	});
</script>

<div class="space-y-4">
	<!-- Connection Section -->
	<SectionHeader title="Connection" />

	<div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
		<!-- Name -->
		<div class="form-control">
			<label class="label py-1" for="regular-name">
				<span class="label-text">Name</span>
				{#if !prowlarrManaged && !jackettManaged}
					<span
						class="label-text-alt text-xs {nameTooLong ? 'text-error' : 'text-base-content/60'}"
					>
						{name.length}/{MAX_NAME_LENGTH}
					</span>
				{/if}
			</label>
			{#if prowlarrManaged || jackettManaged}
				<p class="py-1.5 text-sm font-medium">{name}</p>
			{:else}
				<input
					id="regular-name"
					type="text"
					class="input-bordered input input-sm"
					value={name}
					oninput={(e) => onNameChange(e.currentTarget.value)}
					maxlength={MAX_NAME_LENGTH}
					placeholder={definition?.name ?? 'My Indexer'}
				/>
				{#if nameTooLong}
					<p class="label py-0">
						<span class="label-text-alt text-xs text-error">Max {MAX_NAME_LENGTH} characters.</span>
					</p>
				{/if}
			{/if}
		</div>

		<!-- URL -->
		<div class="form-control">
			<label class="label py-1" for="regular-url">
				<span class="label-text">URL</span>
				{#if !prowlarrManaged && !jackettManaged && alternateUrls.length > 0}
					<span class="label-text-alt text-xs text-base-content/60">
						+{alternateUrls.length} failover{alternateUrls.length > 1 ? 's' : ''}
					</span>
				{/if}
			</label>
			{#if prowlarrManaged || jackettManaged}
				<p class="py-1.5 font-mono text-xs break-all text-base-content/70">
					{managedDisplayUrl ?? url}
				</p>
			{:else if definitionUrls.length > 1}
				<select
					id="regular-url"
					class="select-bordered select select-sm"
					value={url}
					onchange={(e) => onUrlChange(e.currentTarget.value)}
				>
					{#each definitionUrls as availableUrl (availableUrl)}
						<option value={availableUrl}>
							{availableUrl}
							{#if availableUrl === definition?.siteUrl}(default){/if}
						</option>
					{/each}
				</select>
			{:else}
				<input
					id="regular-url"
					type="url"
					class="input-bordered input input-sm {urlError ? 'input-error' : ''}"
					value={url}
					oninput={(e) => onUrlChange(e.currentTarget.value)}
					onblur={onUrlBlur}
					placeholder="https://..."
				/>
				{#if urlError}
					<p class="label py-0">
						<span class="label-text-alt text-error">{urlError}</span>
					</p>
				{/if}
			{/if}
		</div>

		<!-- Priority -->
		<div class="form-control">
			<label class="label py-1" for="regular-priority">
				<span class="label-text">Priority</span>
				<span class="label-text-alt text-xs">1-100, lower = higher</span>
			</label>
			<input
				id="regular-priority"
				type="number"
				class="input-bordered input input-sm"
				value={priority}
				oninput={(e) => onPriorityChange(parseInt(e.currentTarget.value) || 25)}
				min="1"
				max="100"
			/>
		</div>

		<!-- Rate limit -->
		<div class="form-control">
			<label class="label py-1" for="regular-rate-limit">
				<span class="label-text">Rate limit</span>
				<span class="label-text-alt text-xs">requests/min, blank = default</span>
			</label>
			<input
				id="regular-rate-limit"
				type="number"
				class="input-bordered input input-sm"
				value={rateLimitPerMinute ?? ''}
				oninput={(e) => {
					const raw = e.currentTarget.value;
					onRateLimitPerMinuteChange(raw === '' ? null : parseInt(raw) || null);
				}}
				min="1"
				max="600"
				placeholder="Default"
			/>
		</div>
	</div>

	<div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
		<!-- Enabled -->
		<div class="form-control">
			<label class="label py-1" for="regular-enabled">
				<span class="label-text">Status</span>
			</label>
			<label class="flex cursor-pointer items-center gap-2 py-2">
				<input
					id="regular-enabled"
					type="checkbox"
					class="checkbox shrink-0 checkbox-sm checkbox-primary"
					checked={enabled}
					onchange={(e) => onEnabledChange(e.currentTarget.checked)}
				/>
				<span class="text-sm">{enabled ? 'Enabled' : 'Disabled'}</span>
			</label>
		</div>

		<!-- Search Settings -->
		<ToggleSetting
			checked={enableAutomaticSearch}
			label={m.indexer_label_automaticSearch()}
			description={m.indexer_desc_automaticSearch()}
			onchange={() => onAutomaticSearchChange(!enableAutomaticSearch)}
		/>
		<ToggleSetting
			checked={enableInteractiveSearch}
			label={m.indexer_label_interactiveSearch()}
			description={m.indexer_desc_interactiveSearch()}
			onchange={() => onInteractiveSearchChange(!enableInteractiveSearch)}
		/>
	</div>

	<!-- Authentication Section (collapsible, only when has settings) -->
	{#if prowlarrManaged || jackettManaged}
		<div
			class="flex items-center gap-3 rounded-box border border-base-300 bg-base-200/60 px-4 py-3 text-sm text-base-content/70"
		>
			<Lock class="h-4 w-4 shrink-0" />
			<span
				>Authentication is managed by {prowlarrManaged ? 'Prowlarr' : 'Jackett'}. Use the sync
				action to apply credential changes.</span
			>
		</div>
	{:else if hasAuthSettings && definition}
		{@const AuthIcon = authIcon}
		<div class="collapse rounded-lg bg-base-200" class:collapse-open={authSettingsOpen}>
			<button
				type="button"
				class="collapse-title flex min-h-0 items-center justify-between px-4 py-3 text-sm font-medium"
				onclick={() => (authSettingsOpen = !authSettingsOpen)}
			>
				<div class="flex min-w-0 items-center gap-2">
					<AuthIcon class="h-4 w-4 shrink-0 text-base-content/70" />
					<span>{isStreaming ? 'Configuration' : 'Authentication'}</span>
					{#if !authSettingsOpen}
						<span class="ml-2 text-xs font-normal text-base-content/50">
							{authSummary}
						</span>
					{/if}
				</div>
				<ChevronDown
					class="ml-2 h-4 w-4 shrink-0 transition-transform {authSettingsOpen ? 'rotate-180' : ''}"
				/>
			</button>
			<div class="collapse-content px-4 pb-4">
				<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
					<IndexerSettingsFields
						settingsDefinitions={definition.settings}
						{settings}
						{hasSensitiveSettings}
						onchange={(newSettings) => onSettingsChange(newSettings)}
					/>
				</div>
			</div>
		</div>
	{/if}

	<!-- Torrent Settings (collapsible, torrent protocol only) -->
	{#if isTorrent}
		<div class="collapse rounded-lg bg-base-200" class:collapse-open={torrentSettingsOpen}>
			<button
				type="button"
				class="collapse-title flex min-h-0 items-center justify-between px-4 py-3 text-sm font-medium"
				onclick={() => (torrentSettingsOpen = !torrentSettingsOpen)}
			>
				<div class="min-w-0">
					<span>Torrent Settings</span>
					{#if !torrentSettingsOpen}
						<span class="ml-3 text-xs font-normal text-base-content/50">
							{torrentSummary}
						</span>
					{/if}
				</div>
				<ChevronDown
					class="ml-2 h-4 w-4 shrink-0 transition-transform {torrentSettingsOpen
						? 'rotate-180'
						: ''}"
				/>
			</button>
			<div class="collapse-content px-4 pb-4">
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
					<div class="form-control">
						<label class="label py-1" for="minimumSeeders">
							<span class="label-text">Min Seeders</span>
							<span class="label-text-alt text-xs">0+</span>
						</label>
						<input
							id="minimumSeeders"
							type="number"
							class="input-bordered input input-sm"
							value={minimumSeeders}
							oninput={(e) => onMinimumSeedersChange(parseInt(e.currentTarget.value) || 0)}
							min="0"
						/>
						<p class="label py-0">
							<span class="label-text-alt text-xs">Skip releases below this</span>
						</p>
					</div>

					<div class="form-control">
						<label class="label py-1" for="seedRatio">
							<span class="label-text">Seed Ratio</span>
						</label>
						<input
							id="seedRatio"
							type="text"
							class="input-bordered input input-sm"
							value={seedRatio}
							oninput={(e) => onSeedRatioChange(e.currentTarget.value)}
							placeholder="e.g., 1.0"
						/>
						<p class="label py-0">
							<span class="label-text-alt text-xs">Empty = client default</span>
						</p>
					</div>

					<div class="form-control">
						<label class="label py-1" for="seedTime">
							<span class="label-text">Seed Time</span>
							<span class="label-text-alt text-xs">minutes</span>
						</label>
						<input
							id="seedTime"
							type="number"
							class="input-bordered input input-sm"
							value={seedTime}
							oninput={(e) => {
								const val = e.currentTarget.value;
								onSeedTimeChange(val === '' ? '' : parseInt(val) || 0);
							}}
							min="0"
							placeholder="Minutes"
						/>
					</div>

					<div class="form-control">
						<label class="label py-1" for="packSeedTime">
							<span class="label-text">Pack Seed Time</span>
							<span class="label-text-alt text-xs">minutes</span>
						</label>
						<input
							id="packSeedTime"
							type="number"
							class="input-bordered input input-sm"
							value={packSeedTime}
							oninput={(e) => {
								const val = e.currentTarget.value;
								onPackSeedTimeChange(val === '' ? '' : parseInt(val) || 0);
							}}
							min="0"
							placeholder="Minutes"
						/>
					</div>
				</div>

				<div class="mt-3">
					<ToggleSetting
						checked={rejectDeadTorrents}
						label={m.indexer_label_rejectDeadTorrents()}
						description={m.indexer_desc_rejectDeadTorrents()}
						onchange={() => onRejectDeadTorrentsChange(!rejectDeadTorrents)}
					/>
				</div>
			</div>
		</div>
	{/if}

	<!-- Usenet Settings (collapsible, usenet protocol only) -->
	{#if isUsenet}
		<div class="collapse rounded-lg bg-base-200" class:collapse-open={usenetSettingsOpen}>
			<button
				type="button"
				class="collapse-title flex min-h-0 items-center justify-between px-4 py-3 text-sm font-medium"
				onclick={() => (usenetSettingsOpen = !usenetSettingsOpen)}
			>
				<div class="min-w-0">
					<span>Usenet Settings</span>
					{#if !usenetSettingsOpen}
						<span class="ml-3 text-xs font-normal text-base-content/50">
							Min completion: {minimumCompletionPercentage}%
						</span>
					{/if}
				</div>
				<ChevronDown
					class="ml-2 h-4 w-4 shrink-0 transition-transform {usenetSettingsOpen
						? 'rotate-180'
						: ''}"
				/>
			</button>
			<div class="collapse-content px-4 pb-4">
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<div class="form-control">
						<label class="label py-1" for="minimumCompletionPercentage">
							<span class="label-text">Minimum Completion %</span>
							<span class="label-text-alt text-xs">0-100</span>
						</label>
						<input
							id="minimumCompletionPercentage"
							type="number"
							class="input-bordered input input-sm"
							value={minimumCompletionPercentage}
							oninput={(e) =>
								onMinimumCompletionPercentageChange(parseInt(e.currentTarget.value) || 95)}
							min="0"
							max="100"
						/>
						<p class="label py-0">
							<span class="label-text-alt text-xs">Reject releases below this completion %</span>
						</p>
					</div>
				</div>

				<div class="mt-3">
					<ToggleSetting
						checked={rejectPasswordProtected}
						label="Reject Password Protected"
						description="Skip releases that require a password to extract"
						onchange={() => onRejectPasswordProtectedChange(!rejectPasswordProtected)}
					/>
				</div>
			</div>
		</div>
	{/if}

	<!-- Streaming Info (streaming protocol only) -->
	{#if isStreaming}
		<div class="rounded-lg bg-info/10 p-4">
			<p class="text-sm text-base-content/70">
				Streaming indexers provide instant playback via .strm files. No torrent client required.
			</p>
			<ul class="mt-2 list-inside list-disc text-sm text-base-content/60">
				<li>Results are automatically scored lower than torrents</li>
				<li>Can be upgraded to higher quality torrent releases</li>
				<li>Perfect for watching content immediately</li>
			</ul>
		</div>
	{/if}

	<!-- Category Restriction (Newznab/Torznab only) -->
	{#if isNewznabLike && categoryTree.length > 0}
		<div class="collapse rounded-lg bg-base-200" class:collapse-open={categoriesOpen}>
			<button
				type="button"
				class="collapse-title flex min-h-0 items-center justify-between px-4 py-3 text-sm font-medium"
				onclick={() => (categoriesOpen = !categoriesOpen)}
			>
				<div class="min-w-0">
					<span>Category Restriction</span>
					{#if !categoriesOpen}
						<span class="ml-3 text-xs font-normal text-base-content/50">
							{restrictionSummary}
						</span>
					{/if}
				</div>
				<ChevronDown
					class="ml-2 h-4 w-4 shrink-0 transition-transform {categoriesOpen ? 'rotate-180' : ''}"
				/>
			</button>
			<div class="collapse-content px-4 pb-4">
				<p class="mb-2 text-xs text-base-content/60">
					Select which categories to send for this indexer. Nothing selected = open search (no
					<code>cat=</code> filter). Selecting categories restricts searches to only those.
				</p>
				<div class="mb-3 flex gap-2">
					<button type="button" class="btn btn-ghost btn-xs" onclick={selectAll}>Select All</button>
					<button type="button" class="btn btn-ghost btn-xs" onclick={clearAll}>Clear</button>
				</div>
				<div class="space-y-3">
					{#each categoryTree as group (group.id)}
						{@const childrenChecked = group.children.filter((c) => selectedIds.has(c.id)).length}
						{@const allChildrenChecked =
							group.children.length === 0
								? selectedIds.has(group.id)
								: childrenChecked === group.children.length}
						{@const someChildrenChecked = childrenChecked > 0 && !allChildrenChecked}
						<div>
							<!-- Parent row -->
							<label
								class="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-base-300"
							>
								<input
									type="checkbox"
									class="checkbox shrink-0 checkbox-sm checkbox-primary"
									checked={allChildrenChecked}
									indeterminate={someChildrenChecked}
									onchange={() => toggleParent(group)}
								/>
								<span class="text-sm font-medium">{group.name}</span>
								<span class="text-xs text-base-content/40">({group.id})</span>
							</label>
							<!-- Children grid -->
							{#if group.children.length > 0}
								<div class="mt-1 ml-6 grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
									{#each group.children as child (child.id)}
										<label
											class="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-base-300"
										>
											<input
												type="checkbox"
												class="checkbox shrink-0 checkbox-xs checkbox-primary"
												checked={selectedIds.has(child.id)}
												onchange={() => toggleChild(group.id, child.id, group.children)}
											/>
											<span class="truncate text-sm text-base-content/80"
												>{child.name.includes('/')
													? child.name.split('/').slice(1).join('/')
													: child.name}
												<span class="text-xs text-base-content/40">({child.id})</span></span
											>
										</label>
									{/each}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}
</div>
