<script lang="ts">
	import { RefreshCw } from '@lucide/svelte';
	import { FormInput, FormSelect } from '#lib/components/ui/form/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import {
		BUG_REPORT_AREAS,
		type BugReportArea,
		type BugReportLogScope
	} from '#lib/shared/bug-report.js';
	import type { FormattedLogEntry } from '#lib/server/diagnostics/report-builder.js';

	interface Props {
		logScope: BugReportLogScope;
		keyword: string;
		/** Area feeding the "relevant" scope; hidden when an Error ID drives it. */
		area: BugReportArea | '';
		areaSelectable: boolean;
		entries: FormattedLogEntry[];
		totalMatched: number;
		trimmedCount: number;
		loading: boolean;
		onRefresh: () => void;
	}

	let {
		logScope = $bindable(),
		keyword = $bindable(),
		area = $bindable(),
		areaSelectable,
		entries,
		totalMatched,
		trimmedCount,
		loading,
		onRefresh
	}: Props = $props();

	const scopeOptions: Array<{ value: BugReportLogScope; label: () => string; help: () => string }> =
		[
			{
				value: 'relevant',
				label: m.bugreport_logsScope_relevant,
				help: m.bugreport_logsScope_relevantHelp
			},
			{
				value: 'errors',
				label: m.bugreport_logsScope_errors,
				help: m.bugreport_logsScope_errorsHelp
			},
			{
				value: 'all',
				label: m.bugreport_logsScope_all,
				help: m.bugreport_logsScope_allHelp
			}
		];

	// Localized area labels keyed by machine id; the GitHub-facing English
	// labels are only used on the issue form itself.
	const areaLabels: Record<BugReportArea, () => string> = {
		ui: m.bugreport_area_ui,
		api: m.bugreport_area_api,
		indexers: m.bugreport_area_indexers,
		downloads: m.bugreport_area_downloads,
		library: m.bugreport_area_library,
		subtitles: m.bugreport_area_subtitles,
		monitoring: m.bugreport_area_monitoring,
		database: m.bugreport_area_database,
		deployment: m.bugreport_area_deployment,
		other: m.bugreport_area_other
	};

	const areaOptions = [
		{ value: '', label: m.bugreport_areaSelect() },
		...BUG_REPORT_AREAS.map((value) => ({ value, label: areaLabels[value]() }))
	];

	const levelBadgeClasses: Record<string, string> = {
		error: 'badge-error',
		warn: 'badge-warning',
		info: 'badge-info',
		debug: 'badge-ghost'
	};
</script>

<div class="space-y-3">
	<div class="text-sm font-medium">{m.bugreport_logsTitle()}</div>
	<div class="space-y-1.5">
		{#each scopeOptions as option (option.value)}
			<label class="label cursor-pointer justify-start gap-3 py-0.5">
				<input
					type="radio"
					class="radio radio-sm"
					name="bug-report-log-scope"
					value={option.value}
					bind:group={logScope}
				/>
				<span class="label-text">
					{option.label()}
					<span class="text-xs opacity-60">— {option.help()}</span>
				</span>
			</label>
		{/each}
	</div>

	{#if logScope === 'relevant' && areaSelectable}
		<FormSelect
			id="bug-report-log-area"
			label={m.bugreport_logsAreaLabel()}
			helpText={m.bugreport_logsAreaHelp()}
			bind:value={area}
			options={areaOptions}
		/>
	{/if}

	<FormInput
		id="bug-report-log-keyword"
		label={m.bugreport_logsKeywordLabel()}
		helpText={m.bugreport_logsKeywordHelp()}
		placeholder={m.bugreport_logsKeywordPlaceholder()}
		bind:value={keyword}
	/>

	<div class="rounded-lg border border-base-300">
		<div class="flex items-center justify-between gap-2 border-b border-base-300 px-3 py-2">
			<span class="text-xs text-base-content/70">
				{m.bugreport_logsCount({ count: String(totalMatched) })}
			</span>
			<button
				type="button"
				class="btn btn-ghost btn-xs"
				onclick={onRefresh}
				disabled={loading}
				title={m.bugreport_logsRefresh()}
			>
				<RefreshCw class="h-3.5 w-3.5 {loading ? 'animate-spin' : ''}" />
				{m.bugreport_logsRefresh()}
			</button>
		</div>

		{#if loading}
			<div class="flex items-center justify-center gap-2 px-3 py-8 text-sm text-base-content/60">
				<span class="loading loading-sm loading-spinner"></span>
				{m.bugreport_logsLoading()}
			</div>
		{:else if entries.length === 0}
			<div class="px-3 py-8 text-center text-sm text-base-content/60">
				{m.bugreport_logsEmpty()}
			</div>
		{:else}
			<ul class="max-h-60 divide-y divide-base-300 overflow-y-auto font-mono text-xs">
				{#each entries as entry (entry.id)}
					<li class="flex items-start gap-2 px-3 py-1.5">
						<span class="shrink-0 opacity-60">{entry.time}</span>
						<span class="badge shrink-0 badge-xs {levelBadgeClasses[entry.level] ?? 'badge-ghost'}">
							{entry.level}
						</span>
						<span class="shrink-0 opacity-60">{entry.domain}</span>
						<span class="min-w-0 break-words">{entry.message}</span>
					</li>
				{/each}
			</ul>
			{#if trimmedCount > 0}
				<div class="border-t border-base-300 px-3 py-1.5 text-xs text-base-content/60">
					{m.bugreport_logsTrimmed({ count: String(trimmedCount) })}
				</div>
			{/if}
		{/if}
	</div>
</div>
