<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		Compass,
		Download,
		Activity,
		DatabaseSearch,
		ListTodo,
		AlertTriangle,
		Search,
		HardDrive,
		Settings
	} from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import type { DashboardConfig } from '#lib/types/dashboard.js';

	interface Props {
		config: DashboardConfig;
		hasLibraryContent: boolean;
		hasMissingEpisodes: boolean;
	}

	let { config, hasLibraryContent, hasMissingEpisodes }: Props = $props();

	const needsSetup = $derived(
		config.indexerCount === 0 &&
			config.downloadClientCount === 0 &&
			config.rootFolderCount === 0 &&
			!hasLibraryContent
	);
</script>

<div class="card bg-base-200">
	<div class="card-body items-center gap-4 py-5 text-center">
		<div class="space-y-1">
			<div class="text-sm font-medium tracking-[0.2em] text-base-content/45 uppercase">
				{needsSetup ? m.dashboard_quickActions_setupTitle() : m.dashboard_quickActions_title()}
			</div>
		</div>
		<div class="flex w-full flex-wrap justify-center gap-2.5">
			{#if needsSetup}
				<a
					href={resolve('settings/integrations/indexers')}
					class="btn min-w-34 justify-center border-warning bg-warning text-warning-content btn-sm hover:border-warning hover:bg-warning/90"
				>
					<DatabaseSearch class="h-4 w-4" />
					{m.dashboard_quickActions_addIndexer()}
				</a>
				<a
					href={resolve('settings/integrations/download-clients')}
					class="btn min-w-34 justify-center border-warning bg-warning text-warning-content btn-sm hover:border-warning hover:bg-warning/90"
				>
					<Download class="h-4 w-4" />
					{m.dashboard_quickActions_addDownloadClient()}
				</a>
				<a
					href={resolve('settings/library/root-folders')}
					class="btn min-w-34 justify-center border-warning bg-warning text-warning-content btn-sm hover:border-warning hover:bg-warning/90"
				>
					<HardDrive class="h-4 w-4" />
					{m.dashboard_quickActions_addRootFolder()}
				</a>
				{#if !config.tmdbConfigured}
					<a
						href={resolve('settings/system/metadata-providers')}
						class="btn min-w-34 justify-center border-warning bg-warning text-warning-content btn-sm hover:border-warning hover:bg-warning/90"
					>
						<Settings class="h-4 w-4" />
						{m.dashboard_quickActions_configureTmdb()}
					</a>
				{/if}
			{:else}
				<a
					href={resolve('discover')}
					class="btn min-w-34 justify-center border-info bg-info text-info-content btn-sm hover:border-info hover:bg-info/90"
				>
					<Compass class="h-4 w-4" />
					{m.dashboard_quickActions_discover()}
				</a>
				<a
					href={resolve('library/import')}
					class="btn min-w-34 justify-center border-primary bg-primary text-primary-content btn-sm hover:border-primary hover:bg-primary/90"
				>
					<Download class="h-4 w-4" />
					{m.dashboard_quickActions_import()}
				</a>
				<a
					href={resolve('activity')}
					class="btn min-w-34 justify-center border-secondary bg-secondary text-secondary-content btn-sm hover:border-secondary hover:bg-secondary/90"
				>
					<Activity class="h-4 w-4" />
					{m.dashboard_quickActions_viewActivity()}
				</a>
				{#if config.indexerCount === 0}
					<a
						href={resolve('settings/integrations/indexers')}
						class="btn min-w-34 justify-center border-warning bg-warning text-warning-content btn-sm hover:border-warning hover:bg-warning/90"
					>
						<AlertTriangle class="h-4 w-4" />
						{m.dashboard_quickActions_addIndexer()}
					</a>
				{:else}
					<a
						href={resolve('settings/integrations/indexers')}
						class="btn min-w-34 justify-center border-accent bg-accent text-accent-content btn-sm hover:border-accent hover:bg-accent/90"
					>
						<DatabaseSearch class="h-4 w-4" />
						{m.dashboard_quickActions_indexers()}
					</a>
				{/if}
				{#if hasMissingEpisodes}
					<a
						href={resolve('settings/monitoring/tasks')}
						class="btn min-w-34 justify-center border-warning bg-warning text-warning-content btn-sm hover:border-warning hover:bg-warning/90"
					>
						<Search class="h-4 w-4" />
						{m.dashboard_quickActions_searchMissing()}
					</a>
				{:else}
					<a
						href={resolve('settings/monitoring/tasks')}
						class="btn min-w-34 justify-center border-warning bg-warning text-warning-content btn-sm hover:border-warning hover:bg-warning/90"
					>
						<ListTodo class="h-4 w-4" />
						{m.dashboard_quickActions_tasks()}
					</a>
				{/if}
			{/if}
		</div>
	</div>
</div>
