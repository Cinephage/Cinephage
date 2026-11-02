<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		Film,
		Tv,
		Settings,
		Trash2,
		Search,
		SearchSlash,
		Captions,
		CaptionsOff
	} from '@lucide/svelte';
	import type { PageData } from '../../../routes/settings/library/libraries/$types';

	type LibraryRootFolder = {
		id: string;
		name: string;
		path?: string;
	};

	type LibraryEntity = NonNullable<PageData['libraries']>[number] & {
		rootFolders?: LibraryRootFolder[];
	};

	type StorageBreakdownItem = {
		id: string;
		usedBytes: number;
		itemCount: number;
	};

	interface Props {
		libraries: LibraryEntity[];
		storageBreakdown: StorageBreakdownItem[];
		onEdit: (library: LibraryEntity) => void;
		onDelete: (library: LibraryEntity) => void;
		formatBytes: (value: number) => string;
	}

	let { libraries, storageBreakdown, onEdit, onDelete, formatBytes }: Props = $props();

	type LibrarySection = {
		id: 'movie' | 'tv';
		title: string;
		icon: typeof Film;
		sectionClasses: string;
		cardClasses: string;
		libraries: LibraryEntity[];
	};

	function getStorageEntry(libraryId: string): StorageBreakdownItem | undefined {
		return storageBreakdown.find((item) => item.id === libraryId);
	}

	function formatRootFolderSummary(rootFolders: LibraryRootFolder[] | undefined) {
		if (!rootFolders || rootFolders.length === 0) return m.settings_general_noRootFoldersAssigned();
		const names = rootFolders.map((folder) => folder.name);
		if (names.length <= 2) return names.join(', ');
		return m.settings_general_rootFoldersSummaryMore({
			names: names.slice(0, 2).join(', '),
			count: names.length - 2
		});
	}

	function hasAssignedRootFolders(rootFolders: LibraryRootFolder[] | undefined): boolean {
		return (rootFolders?.length ?? 0) > 0;
	}

	function getStatusBadgeClass(enabled: boolean): string {
		return enabled
			? 'border-success/30 bg-success/10 text-success'
			: 'border-error/30 bg-error/10 text-error';
	}

	const sections = $derived(
		[
			{
				id: 'movie',
				title: m.settings_general_movieLibraries(),
				icon: Film,
				sectionClasses: 'bg-primary/15 text-primary',
				cardClasses: 'bg-primary/20 text-primary',
				libraries: libraries.filter((library) => library.mediaType === 'movie')
			},
			{
				id: 'tv',
				title: m.settings_general_tvLibraries(),
				icon: Tv,
				sectionClasses: 'bg-secondary/15 text-secondary',
				cardClasses: 'bg-secondary/20 text-secondary',
				libraries: libraries.filter((library) => library.mediaType === 'tv')
			}
		].filter((section) => section.libraries.length > 0) as LibrarySection[]
	);
</script>

{#if libraries.length === 0}
	<div class="rounded-lg border border-dashed border-base-300 p-6 text-sm text-base-content/60">
		{m.settings_general_noLibrariesConfigured()}
	</div>
{:else}
	<div class="space-y-6">
		{#each sections as section (section.id)}
			<section class="space-y-3">
				<div class="flex items-start gap-3">
					<div class="mt-0.5 rounded-lg p-2 {section.sectionClasses}">
						<section.icon class="h-4 w-4" />
					</div>
					<div class="min-w-0">
						<h3 class="font-semibold">{section.title}</h3>
					</div>
				</div>

				<div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
					{#each section.libraries as library (library.id)}
						{@const usage = getStorageEntry(library.id)}
						<div class="card bg-base-200 shadow-sm">
							<div class="card-body p-4">
								<div class="flex items-start justify-between gap-3">
									<div class="flex min-w-0 items-center gap-3">
										<div class="rounded-lg p-2 {section.cardClasses}">
											<section.icon class="h-5 w-5" />
										</div>
										<div class="min-w-0">
											<h4 class="flex flex-wrap items-center gap-2">
												<span class="font-semibold">{library.name}</span>
												{#if library.isSystem}
													<span class="badge badge-outline badge-sm"
														>{m.settings_general_badgeSystem()}</span
													>
												{/if}
												{#if library.mediaSubType === 'anime'}
													<span class="badge badge-sm badge-accent"
														>{m.settings_general_badgeAnime()}</span
													>
												{/if}
											</h4>
											<p class="text-sm text-base-content/60">
												{m.settings_general_rootFoldersLabel()}:
												<span
													class={hasAssignedRootFolders(library.rootFolders)
														? ''
														: 'badge badge-sm badge-warning'}
												>
													{formatRootFolderSummary(library.rootFolders)}
												</span>
											</p>
											<p class="text-xs text-base-content/50">
												{m.settings_general_itemsUsed({
													count: usage?.itemCount ?? 0,
													used: formatBytes(usage?.usedBytes ?? 0)
												})}
											</p>
										</div>
									</div>

									<div class="flex gap-1">
										<button
											class="btn btn-square btn-ghost btn-sm"
											onclick={() => onEdit(library)}
											title={m.action_edit()}
										>
											<Settings class="h-4 w-4" />
										</button>
										{#if !library.isSystem}
											<button
												class="btn btn-square btn-ghost text-error btn-sm"
												onclick={() => onDelete(library)}
												title={m.action_delete()}
											>
												<Trash2 class="h-4 w-4" />
											</button>
										{/if}
									</div>
								</div>

								<div class="mt-3 grid grid-cols-2 gap-2 border-t border-base-300 pt-3">
									<div
										class="flex flex-col items-center gap-1 rounded-lg"
										title={m.settings_general_statusTooltip({
											label: m.settings_general_searchOnAddLabel(),
											status: library.defaultSearchOnAdd ? m.common_enabled() : m.common_disabled()
										})}
									>
										<span
											class={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${getStatusBadgeClass(
												library.defaultSearchOnAdd
											)}`}
										>
											{#if library.defaultSearchOnAdd}
												<Search class="h-3.5 w-3.5" />
											{:else}
												<SearchSlash class="h-3.5 w-3.5" />
											{/if}
										</span>
									</div>
									<div
										class="flex flex-col items-center gap-1 rounded-lg"
										title={m.settings_general_statusTooltip({
											label: m.settings_general_wantSubtitles(),
											status: library.defaultWantsSubtitles
												? m.common_enabled()
												: m.common_disabled()
										})}
									>
										<span
											class={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${getStatusBadgeClass(
												library.defaultWantsSubtitles
											)}`}
										>
											{#if library.defaultWantsSubtitles}
												<Captions class="h-3.5 w-3.5" />
											{:else}
												<CaptionsOff class="h-3.5 w-3.5" />
											{/if}
										</span>
									</div>
								</div>
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/each}
	</div>
{/if}
