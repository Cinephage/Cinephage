<script lang="ts">
	import { browser } from '$app/env';
	import { ClipboardCopy, Download, ExternalLink } from '@lucide/svelte';
	import BugReportLogScope from './BugReportLogScope.svelte';
	import { buildBugReportLogsUrl, fetchBugReportDiagnostics } from '#lib/api/index.js';
	import { getGithubRelease } from '#lib/api/settings.js';
	import { FormInput } from '#lib/components/ui/form/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { copyToClipboard } from '#lib/utils/clipboard.js';
	import { GITHUB_NEW_ISSUE_URL, type BugReportArea } from '#lib/shared/bug-report.js';
	import { ensureVersionPrefix } from '#lib/version.js';
	import type {
		BugReportDiagnosticsResult,
		FormattedLogEntry
	} from '#lib/server/diagnostics/report-builder.js';
	import type { BugReportLogScope as BugReportLogScopeValue } from '#lib/shared/bug-report.js';

	interface Props {
		/** Error-page supportId, pre-fills the Error ID field. */
		initialSupportId?: string | null;
	}

	let { initialSupportId = null }: Props = $props();

	// Seed-only read: the Error ID stays an editable field afterwards, so the
	// initial capture is deliberate (the modal remounts via {#key} per launch).
	// svelte-ignore state_referenced_locally
	let supportId = $state(initialSupportId ?? '');
	let area = $state<BugReportArea | ''>('');
	let logScope = $state<BugReportLogScopeValue>('relevant');
	let keyword = $state('');

	let diagnostics = $state<BugReportDiagnosticsResult | null>(null);
	let latestVersion = $state<string | null>(null);
	let loading = $state(true);
	let loadFailed = $state(false);
	let requestId = 0;

	async function loadDiagnostics(): Promise<void> {
		const id = ++requestId;
		loading = true;
		loadFailed = false;
		try {
			const response = await fetchBugReportDiagnostics({
				supportId: supportId.trim() || undefined,
				area: area || undefined,
				logScope,
				keyword: keyword.trim() || undefined
			});
			if (id !== requestId) return;
			diagnostics = response;
		} catch {
			if (id !== requestId) return;
			loadFailed = true;
		} finally {
			if (id === requestId) loading = false;
		}
	}

	// Refetch when any scope input changes; keyword is debounced so typing
	// does not fire a request per keystroke.
	$effect(() => {
		void logScope;
		void area;
		void supportId;
		void keyword;
		const timer = setTimeout(() => void loadDiagnostics(), keyword ? 400 : 0);
		return () => clearTimeout(timer);
	});

	// Up-to-date line for the form's "latest version" checkbox; failures
	// degrade to "unknown" and never block the kit.
	$effect(() => {
		if (!browser) return;
		getGithubRelease()
			.then((release) => {
				latestVersion = release.version ?? null;
			})
			.catch(() => {
				latestVersion = null;
			});
	});

	const versionStatus = $derived.by(() => {
		const installed = diagnostics?.system.version;
		if (!installed) return null;
		if (!latestVersion) {
			return {
				text: m.bugreport_versionStatus({ installed, latest: m.bugreport_unknown() }),
				upToDate: null
			};
		}
		const upToDate = ensureVersionPrefix(installed) === ensureVersionPrefix(latestVersion);
		return {
			text: m.bugreport_versionStatus({ installed, latest: latestVersion }),
			upToDate
		};
	});

	/** Friendly browser label for the form's browser field; falls back to
	 * the raw user agent when nothing matches. */
	function browserLabel(): string {
		if (!browser) return '';
		const ua = navigator.userAgent;
		const firefox = ua.match(/Firefox\/([\d.]+)/);
		if (firefox) return `Firefox ${firefox[1]}`;
		const edge = ua.match(/Edg(?:e|A|iOS)?\/([\d.]+)/);
		if (edge) return `Edge ${edge[1]}`;
		const chrome = ua.match(/Chrome\/([\d.]+)/);
		if (chrome) return `Chrome ${chrome[1]}`;
		const safari = ua.match(/Version\/([\d.]+).*Safari/);
		if (safari) return `Safari ${safari[1]}`;
		return ua;
	}

	function logLine(entry: FormattedLogEntry): string {
		return `[${entry.time}] ${entry.level.toUpperCase()} ${entry.domain}: ${entry.message}`;
	}

	async function copy(text: string, doneMessage: string): Promise<void> {
		const ok = await copyToClipboard(text);
		if (ok) {
			// Long duration: the paste happens on the GitHub tab the user is
			// about to switch to, so the toast should still be visible after.
			toasts.success(doneMessage, { duration: 10_000 });
		} else {
			toasts.error(m.bugreport_copyFailed());
		}
	}

	async function copyVersion(): Promise<void> {
		if (!diagnostics) return;
		const { version, commit } = diagnostics.system;
		await copy(`${version} (commit ${commit})`, m.bugreport_copyVersionDone());
	}

	async function copyBrowser(): Promise<void> {
		await copy(browserLabel(), m.bugreport_copyBrowserDone());
	}

	async function copyLogs(): Promise<void> {
		if (!diagnostics || diagnostics.logs.entries.length === 0) {
			toasts.warning(m.bugreport_logsEmpty());
			return;
		}
		const text = [
			`# Cinephage logs - ${diagnostics.logs.scopeDescription}`,
			...diagnostics.logs.entries.map(logLine)
		].join('\n');
		await copy(text, m.bugreport_copyLogsDone());
	}

	const logsDownloadUrl = $derived(
		buildBugReportLogsUrl({
			supportId: supportId.trim() || undefined,
			area: area || undefined,
			logScope,
			keyword: keyword.trim() || undefined
		})
	);
</script>

<div class="space-y-6">
	<p class="text-sm text-base-content/70">{m.bugreport_description()}</p>

	<FormInput
		id="bug-report-support-id"
		label={m.bugreport_errorIdLabel()}
		helpText={m.bugreport_errorIdHelp()}
		placeholder="e.g., 3f2a91c4"
		bind:value={supportId}
	/>

	<div class="rounded-lg border border-base-300">
		<div class="flex items-center justify-between gap-2 border-b border-base-300 px-3 py-2">
			<span class="text-sm font-medium">{m.bugreport_systemTitle()}</span>
			{#if versionStatus?.upToDate === true}
				<span class="badge badge-sm badge-success">{m.bugreport_upToDate()}</span>
			{:else if versionStatus?.upToDate === false}
				<span class="badge badge-sm badge-warning">{m.bugreport_outdated()}</span>
			{/if}
		</div>
		<div class="space-y-1 px-3 py-2 font-mono text-xs">
			{#if diagnostics}
				<div>
					{m.bugreport_systemVersion({
						version: diagnostics.system.version,
						commit: diagnostics.system.commit
					})}
				</div>
				<div>{m.bugreport_systemNode({ value: diagnostics.system.node })}</div>
				<div>{m.bugreport_systemOs({ value: diagnostics.system.os })}</div>
				<div>
					{m.bugreport_systemSchema({
						value: diagnostics.system.schemaVersion ?? '?'
					})}
				</div>
				<div>{versionStatus?.text ?? ''}</div>
			{:else}
				<div class="py-2 text-base-content/60">{m.bugreport_logsLoading()}</div>
			{/if}
		</div>
		<div class="border-t border-base-300 px-3 py-1.5 text-xs text-base-content/60">
			{#if diagnostics}
				{m.bugreport_dropdownHint({
					deployment: diagnostics.system.githubDeploymentOption,
					os: diagnostics.system.githubOsOption ?? m.bugreport_unknown()
				})}
			{/if}
		</div>
		<div class="flex flex-wrap gap-2 border-t border-base-300 px-3 py-2">
			<button type="button" class="btn btn-outline btn-sm" onclick={() => void copyVersion()}>
				<ClipboardCopy class="h-3.5 w-3.5" />
				{m.bugreport_copyVersion()}
			</button>
			<button type="button" class="btn btn-outline btn-sm" onclick={() => void copyBrowser()}>
				<ClipboardCopy class="h-3.5 w-3.5" />
				{m.bugreport_copyBrowser()}
			</button>
		</div>
	</div>

	<BugReportLogScope
		bind:logScope
		bind:keyword
		bind:area
		areaSelectable={supportId.trim().length === 0}
		entries={diagnostics?.logs.entries ?? []}
		totalMatched={diagnostics?.logs.totalMatched ?? 0}
		trimmedCount={diagnostics?.logs.trimmedCount ?? 0}
		{loading}
		onRefresh={() => void loadDiagnostics()}
	/>

	{#if loadFailed}
		<div class="alert text-sm alert-warning">{m.bugreport_loadFailed()}</div>
	{/if}

	<div class="flex flex-col gap-2 sm:flex-row sm:justify-end">
		<button type="button" class="btn btn-outline" onclick={() => void copyLogs()}>
			<ClipboardCopy class="h-4 w-4" />
			{m.bugreport_copyLogs()}
		</button>
		<a class="btn btn-outline" href={logsDownloadUrl} download>
			<Download class="h-4 w-4" />
			{m.bugreport_downloadLogs()}
		</a>
		<a
			class="btn btn-primary"
			href={GITHUB_NEW_ISSUE_URL}
			target="_blank"
			rel="noopener noreferrer"
		>
			{m.bugreport_openGithub()}
			<ExternalLink class="h-3.5 w-3.5" />
		</a>
	</div>

	<p class="text-xs text-base-content/60">
		{m.bugreport_downloadHint()} - {m.bugreport_privacyBody()}
	</p>
</div>
