<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		Folder,
		Settings,
		Trash2,
		Film,
		Tv,
		Star,
		Eye,
		EyeOff,
		HardDrive,
		ShieldCheck,
		ShieldX,
		GitBranchMinus,
		GitBranchPlus
	} from '@lucide/svelte';
	import type { RootFolder } from '#lib/types/downloadClient.js';
	import { sortRootFoldersForMediaType } from '#lib/utils/root-folders.js';

	interface Props {
		folders: RootFolder[];
		onEdit: (folder: RootFolder) => void;
		onDelete: (folder: RootFolder) => void;
	}

	let { folders, onEdit, onDelete }: Props = $props();

	const movieFolders = $derived(sortRootFoldersForMediaType(folders, 'movie'));
	const tvFolders = $derived(sortRootFoldersForMediaType(folders, 'tv'));

	type FolderSection = {
		id: 'movie' | 'tv';
		title: string;
		icon: typeof Film;
		folders: RootFolder[];
	};

	const sections = $derived(
		[
			{
				id: 'movie',
				title: m.rootFolders_movieFoldersTitle(),
				icon: Film,
				folders: movieFolders
			},
			{
				id: 'tv',
				title: m.rootFolders_tvFoldersTitle(),
				icon: Tv,
				folders: tvFolders
			}
		].filter((section) => section.folders.length > 0) as FolderSection[]
	);
</script>

{#if folders.length === 0}
	<div class="py-12 text-center text-base-content/60">
		<Folder class="mx-auto mb-4 h-12 w-12 opacity-40" />
		<p class="text-lg font-medium">{m.rootFolders_noFoldersConfigured()}</p>
		<p class="mt-1 text-sm">{m.rootFolders_addFoldersHint()}</p>
	</div>
{:else}
	<div class="space-y-6">
		{#each sections as section (section.id)}
			<section class="space-y-3">
				<div class="flex items-start gap-3">
					<div
						class="mt-0.5 rounded-lg p-2 {section.id === 'movie'
							? 'bg-primary/15 text-primary'
							: 'bg-secondary/15 text-secondary'}"
					>
						<section.icon class="h-4 w-4" />
					</div>
					<div class="min-w-0">
						<h3 class="font-semibold">{section.title}</h3>
					</div>
				</div>

				<div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
					{#each section.folders as folder (folder.id)}
						<div class="card bg-base-200 shadow-sm">
							<div class="card-body p-4">
								<div class="flex items-start justify-between gap-3">
									<div class="flex min-w-0 items-start gap-3">
										<div
											class="shrink-0 rounded-lg p-2 {folder.mediaType === 'movie'
												? 'bg-primary/20 text-primary'
												: 'bg-secondary/20 text-secondary'}"
										>
											{#if folder.mediaType === 'movie'}
												<Film class="h-5 w-5" />
											{:else}
												<Tv class="h-5 w-5" />
											{/if}
										</div>
										<div class="min-w-0">
											<h3 class="flex flex-wrap items-center gap-2">
												<span class="font-semibold break-all">{folder.name}</span>
												{#if folder.isDefault}
													<span class="badge gap-1 badge-sm badge-primary">
														<Star class="h-3 w-3" />
														{m.rootFolders_badgeDefault()}
													</span>
												{/if}
												{#if (folder.mediaSubType ?? 'standard') === 'anime'}
													<span class="badge badge-sm badge-accent"
														>{m.settings_general_badgeAnime()}</span
													>
												{/if}
												{#if folder.readOnly}
													<span
														class="badge gap-1 badge-outline badge-sm"
														title={m.rootFolders_readOnlyLabel()}
													>
														<Eye class="h-3 w-3" />
														{m.rootFolders_badgeReadOnly()}
													</span>
												{/if}
											</h3>
											<p class="max-w-full font-mono text-sm break-all text-base-content/60">
												{folder.path}
											</p>
										</div>
									</div>

									<div class="flex shrink-0 gap-1">
										<button
											class="btn btn-square btn-ghost btn-sm"
											onclick={() => onEdit(folder)}
											title={m.action_edit()}
										>
											<Settings class="h-4 w-4" />
										</button>
										<button
											class="btn btn-square btn-ghost text-error btn-sm"
											onclick={() => onDelete(folder)}
											title={m.action_delete()}
										>
											<Trash2 class="h-4 w-4" />
										</button>
									</div>
								</div>

								<div class="mt-3 grid grid-cols-4 gap-2 border-t border-base-300 pt-3">
									<div
										class="flex flex-col items-center gap-1 rounded-lg"
										title={m.settings_general_statusTooltip({
											label: m.rootFolders_preserveSymlinksLabel(),
											status: folder.preserveSymlinks ? m.common_enabled() : m.common_disabled()
										})}
									>
										<span
											class={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
												folder.preserveSymlinks
													? 'border-success/30 bg-success/10 text-success'
													: 'border-error/30 bg-error/10 text-error'
											}`}
										>
											{#if folder.preserveSymlinks}
												<GitBranchPlus class="h-3.5 w-3.5" />
											{:else}
												<GitBranchMinus class="h-3.5 w-3.5" />
											{/if}
										</span>
									</div>
									<div
										class="flex flex-col items-center gap-1 rounded-lg"
										title={m.settings_general_statusTooltip({
											label: m.rootFolders_monitorNewContent(),
											status: folder.defaultMonitored ? m.common_enabled() : m.common_disabled()
										})}
									>
										<span
											class={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
												folder.defaultMonitored
													? 'border-success/30 bg-success/10 text-success'
													: 'border-error/30 bg-error/10 text-error'
											}`}
										>
											{#if folder.defaultMonitored}
												<Eye class="h-3.5 w-3.5" />
											{:else}
												<EyeOff class="h-3.5 w-3.5" />
											{/if}
										</span>
									</div>
									<div
										class="flex flex-col items-center gap-1 rounded-lg"
										title={m.settings_general_statusTooltip({
											label: m.settings_general_pathAccessible(),
											status: folder.accessible ? m.settings_general_yes() : m.settings_general_no()
										})}
									>
										<span
											class={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
												folder.accessible
													? 'border-success/30 bg-success/10 text-success'
													: 'border-error/30 bg-error/10 text-error'
											}`}
										>
											{#if folder.accessible}
												<ShieldCheck class="h-3.5 w-3.5" />
											{:else}
												<ShieldX class="h-3.5 w-3.5" />
											{/if}
										</span>
									</div>
									<div
										class="flex flex-col items-center gap-1 rounded-lg"
										title={folder.readOnly
											? 'Free Space: N/A'
											: folder.freeSpaceFormatted
												? `Free Space: ${folder.freeSpaceFormatted}`
												: 'Free Space: Unknown'}
									>
										<span
											class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium text-base-content/80"
										>
											<HardDrive class="h-3.5 w-3.5 shrink-0" />
											{#if folder.readOnly}
												{m.common_na()}
											{:else if folder.freeSpaceFormatted}
												<span class="whitespace-nowrap">{folder.freeSpaceFormatted}</span>
											{:else}
												{m.rootFolders_unknown()}
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
