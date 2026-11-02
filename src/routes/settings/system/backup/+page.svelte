<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import {
		Download,
		Upload,
		RefreshCw,
		AlertCircle,
		CheckCircle,
		Database,
		HardDrive,
		ChevronDown,
		ChevronUp,
		FolderOpen
	} from '@lucide/svelte';
	import { FolderBrowser } from '#lib/components/library/index.js';
	import type { LayoutData } from '../$types';
	import { refreshAll } from '$app/navigation';
	import { ConfirmationModal } from '#lib/components/ui/modal/index.js';
	import { formatDisplayDate } from '#lib/utils/format.js';
	import { SettingsPage, SettingsSection } from '#lib/components/ui/settings/index.js';
	import { exportConfig, importConfig } from '#lib/api/settings.js';
	import type { BackupImport } from '#lib/validation/schemas.js';

	let { data: _data }: { data: LayoutData } = $props();

	// =====================
	// Backup & Restore State
	// =====================
	type BackupSectionId =
		'system' | 'profiles' | 'downloads' | 'indexers' | 'subtitles' | 'integrations' | 'liveTv';

	interface BackupSectionPreview {
		id: BackupSectionId;
		tableNames: string[];
		totalRows: number;
		summary: string;
	}

	interface BackupPreview {
		version: number;
		createdAt: string;
		totalSections: number;
		includeIndexerCookies: boolean;
		supportsRestoreModes: string[];
		sections: BackupSectionPreview[];
	}

	const BACKUP_SECTION_GROUPS: BackupSectionPreview[] = [
		{
			id: 'system',
			tableNames: [
				'settings',
				'monitoringSettings',
				'captchaSolverSettings',
				'taskSettings',
				'rootFolders',
				'libraries',
				'libraryRootFolders',
				'librarySettings',
				'namingSettings',
				'namingPresets'
			],
			totalRows: 0,
			summary: ''
		},
		{
			id: 'profiles',
			tableNames: ['scoringProfiles', 'customFormats', 'delayProfiles', 'languageProfiles'],
			totalRows: 0,
			summary: ''
		},
		{
			id: 'downloads',
			tableNames: ['downloadClients', 'nntpServers'],
			totalRows: 0,
			summary: ''
		},
		{
			id: 'indexers',
			tableNames: ['indexers'],
			totalRows: 0,
			summary: ''
		},
		{
			id: 'subtitles',
			tableNames: ['subtitleProviders', 'subtitleSettings'],
			totalRows: 0,
			summary: ''
		},
		{
			id: 'integrations',
			tableNames: ['mediaBrowserServers', 'smartLists'],
			totalRows: 0,
			summary: ''
		},
		{
			id: 'liveTv',
			tableNames: [
				'stalkerPortals',
				'livetvAccounts',
				'channelCategories',
				'channelLineupItems',
				'channelLineupBackups'
			],
			totalRows: 0,
			summary: ''
		}
	];

	function getSectionLabel(sectionId: BackupSectionId): string {
		switch (sectionId) {
			case 'system':
				return m.settings_system_backup_sectionSystem();
			case 'profiles':
				return m.settings_system_backup_sectionProfiles();
			case 'downloads':
				return m.settings_system_backup_sectionDownloads();
			case 'indexers':
				return m.settings_system_backup_sectionIndexers();
			case 'subtitles':
				return m.settings_system_backup_sectionSubtitles();
			case 'integrations':
				return m.settings_system_backup_sectionIntegrations();
			case 'liveTv':
				return m.settings_system_backup_sectionLiveTv();
		}
	}

	function summarizeBackupSection(
		sectionId: BackupSectionId,
		totalRows: number,
		_countsByTable: Record<string, number>
	): string {
		switch (sectionId) {
			case 'system':
				return m.settings_system_backup_summarySystem({ count: String(totalRows) });
			case 'profiles':
				return m.settings_system_backup_summaryProfiles({ count: String(totalRows) });
			case 'downloads':
				return m.settings_system_backup_summaryDownloads({ count: String(totalRows) });
			case 'indexers':
				return m.settings_system_backup_summaryIndexers({ count: String(totalRows) });
			case 'subtitles':
				return m.settings_system_backup_summarySubtitles({ count: String(totalRows) });
			case 'integrations':
				return m.settings_system_backup_summaryIntegrations({ count: String(totalRows) });
			case 'liveTv':
				return m.settings_system_backup_summaryLiveTv({ count: String(totalRows) });
		}
	}

	// =====================
	// DB Backup State
	// =====================
	interface DbBackupFile {
		filename: string;
		path: string;
		sizeBytes: number;
		createdAt: string;
	}

	interface DbBackupSettings {
		enabled: boolean;
		directory: string;
		retentionCount: number;
	}

	let dbBackupSettings = $state<DbBackupSettings>({
		enabled: true,
		directory: '',
		retentionCount: 7
	});
	let dbScheduledBackups = $state<DbBackupFile[]>([]);
	let dbPreUpdateBackups = $state<DbBackupFile[]>([]);
	let dbBackupLoading = $state(false);
	let dbBackupRunning = $state(false);
	let dbBackupError = $state<string | null>(null);
	let dbBackupSuccess = $state<string | null>(null);
	let showFolderBrowser = $state(false);
	let showAllScheduled = $state(false);
	let showAllPreUpdate = $state(false);
	const BACKUP_LIST_PREVIEW = 3;

	async function loadDbBackupData(): Promise<void> {
		dbBackupLoading = true;
		dbBackupError = null;
		try {
			const res = await fetch('/api/settings/system/db-backup');
			const data = await res.json();
			if (data.success) {
				dbBackupSettings = data.settings;
				dbScheduledBackups = data.scheduledBackups;
				dbPreUpdateBackups = data.preUpdateBackups;
			}
		} catch {
			dbBackupError = m.settings_system_backup_db_errorLoad();
		} finally {
			dbBackupLoading = false;
		}
	}

	async function saveDbBackupSettings(): Promise<void> {
		dbBackupError = null;
		dbBackupSuccess = null;
		try {
			const res = await fetch('/api/settings/system/db-backup', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(dbBackupSettings)
			});
			const data = await res.json();
			if (data.success) {
				dbBackupSettings = data.settings;
				dbBackupSuccess = m.settings_system_backup_db_settingsSaved();
				setTimeout(() => {
					dbBackupSuccess = null;
				}, 3000);
			}
		} catch {
			dbBackupError = m.settings_system_backup_db_errorSave();
		}
	}

	async function runDbBackupNow(): Promise<void> {
		dbBackupRunning = true;
		dbBackupError = null;
		dbBackupSuccess = null;
		try {
			const res = await fetch('/api/settings/system/db-backup/run', { method: 'POST' });
			const data = await res.json();
			if (data.success) {
				dbBackupSuccess = m.settings_system_backup_db_backupCreated();
				await loadDbBackupData();
				setTimeout(() => {
					dbBackupSuccess = null;
				}, 4000);
			} else {
				dbBackupError = data.error ?? m.settings_system_backup_db_errorBackup();
			}
		} catch {
			dbBackupError = m.settings_system_backup_db_errorBackup();
		} finally {
			dbBackupRunning = false;
		}
	}

	function fmtBytes(bytes: number): string {
		if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		return `${(bytes / 1024).toFixed(0)} KB`;
	}

	$effect(() => {
		loadDbBackupData();
	});

	let backupExportPassphrase = $state('');
	let backupIncludeIndexerCookies = $state(false);
	let backupImportPassphrase = $state('');
	let backupExporting = $state(false);
	let backupImporting = $state(false);
	let confirmRestoreOpen = $state(false);
	let selectedBackupFile = $state<File | null>(null);
	let backupPreview = $state<BackupPreview | null>(null);
	let backupMessage = $state<string | null>(null);
	let backupError = $state<string | null>(null);
	let backupWarnings = $state<string[]>([]);
	let selectedRestoreSections = $state<BackupSectionId[]>([]);

	function buildBackupPreview(backup: unknown): BackupPreview {
		if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
			throw new Error(m.settings_system_backup_errorInvalidFile());
		}

		const candidate = backup as Record<string, unknown>;
		const data = candidate.data;
		if (!data || typeof data !== 'object' || Array.isArray(data)) {
			throw new Error(m.settings_system_backup_errorMissingData());
		}

		const manifest = candidate.manifest;
		if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
			const typedManifest = manifest as Record<string, unknown>;
			const sections = Array.isArray(typedManifest.sections)
				? typedManifest.sections
						.filter(
							(section): section is Record<string, unknown> =>
								!!section && typeof section === 'object'
						)
						.map((section) => {
							const tableNames = Array.isArray(section.tableNames)
								? section.tableNames.map((name) => String(name))
								: [];
							const sectionId = String(section.id) as BackupSectionId;
							const countsByTable = Object.fromEntries(
								tableNames.map((tableName) => [
									tableName,
									Array.isArray((data as Record<string, unknown>)[tableName])
										? ((data as Record<string, unknown>)[tableName] as unknown[]).length
										: 0
								])
							);

							return {
								id: sectionId,
								tableNames,
								totalRows: typeof section.totalRows === 'number' ? section.totalRows : 0,
								summary: summarizeBackupSection(
									sectionId,
									typeof section.totalRows === 'number' ? section.totalRows : 0,
									countsByTable
								)
							};
						})
				: [];

			return {
				version: typeof candidate.version === 'number' ? candidate.version : 1,
				createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
				totalSections: sections.filter((section) => section.totalRows > 0).length,
				includeIndexerCookies:
					!!candidate.options &&
					typeof candidate.options === 'object' &&
					!Array.isArray(candidate.options) &&
					!!(candidate.options as Record<string, unknown>).includeIndexerCookies,
				supportsRestoreModes: Array.isArray(typedManifest.supportsRestoreModes)
					? typedManifest.supportsRestoreModes.map((mode) => String(mode))
					: ['apply'],
				sections
			};
		}

		const dataRecord = data as Record<string, unknown>;
		const sections = BACKUP_SECTION_GROUPS.map((section) => {
			const countsByTable = Object.fromEntries(
				section.tableNames.map((tableName) => [
					tableName,
					Array.isArray(dataRecord[tableName]) ? (dataRecord[tableName] as unknown[]).length : 0
				])
			);
			const totalRows = Object.values(countsByTable).reduce<number>((sum, count) => sum + count, 0);

			return {
				...section,
				totalRows,
				summary: summarizeBackupSection(section.id, totalRows, countsByTable)
			};
		});

		return {
			version: typeof candidate.version === 'number' ? candidate.version : 1,
			createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
			totalSections: sections.filter((section) => section.totalRows > 0).length,
			includeIndexerCookies: false,
			supportsRestoreModes: ['apply'],
			sections
		};
	}

	async function handleBackupFileChange(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		selectedBackupFile = input.files?.[0] ?? null;
		backupError = null;
		backupMessage = null;
		backupWarnings = [];
		backupPreview = null;

		if (!selectedBackupFile) {
			selectedRestoreSections = [];
			return;
		}

		try {
			const backup = JSON.parse(await selectedBackupFile.text());
			backupPreview = buildBackupPreview(backup);
			selectedRestoreSections = backupPreview.sections
				.filter((section) => section.totalRows > 0)
				.map((section) => section.id);
		} catch (error) {
			selectedBackupFile = null;
			selectedRestoreSections = [];
			backupError =
				error instanceof Error ? error.message : m.settings_system_backup_errorReadFile();
		}
	}

	function toggleRestoreSection(sectionId: BackupSectionId, checked: boolean) {
		if (checked) {
			if (!selectedRestoreSections.includes(sectionId)) {
				selectedRestoreSections = [...selectedRestoreSections, sectionId];
			}
			return;
		}

		selectedRestoreSections = selectedRestoreSections.filter((section) => section !== sectionId);
	}

	async function exportConfigurationBackup() {
		backupExporting = true;
		backupError = null;
		backupMessage = null;
		backupWarnings = [];

		try {
			const payload = await exportConfig(backupExportPassphrase, backupIncludeIndexerCookies);

			const backup = payload.backup;
			const fileName =
				typeof payload.fileName === 'string'
					? payload.fileName
					: m.settings_system_backup_defaultFileName();
			const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = fileName;
			anchor.click();
			URL.revokeObjectURL(url);

			backupMessage = m.settings_system_backup_exportSuccess();
		} catch (error) {
			backupError =
				error instanceof Error ? error.message : m.settings_system_backup_errorExportFailed();
		} finally {
			backupExporting = false;
		}
	}

	async function importConfigurationBackup() {
		if (!selectedBackupFile) {
			backupError = m.settings_system_backup_errorSelectFileFirst();
			return;
		}

		if (selectedRestoreSections.length === 0) {
			backupError = m.settings_system_backup_errorSelectSectionFirst();
			return;
		}

		if (!backupImportPassphrase.trim()) {
			backupError = m.settings_system_backup_errorPassphraseRequired();
			return;
		}

		confirmRestoreOpen = false;
		backupImporting = true;
		backupError = null;
		backupMessage = null;
		backupWarnings = [];

		try {
			const backup = JSON.parse(await selectedBackupFile.text()) as BackupImport['backup'];
			const payload = await importConfig(backupImportPassphrase.trim(), backup, {
				sections: selectedRestoreSections,
				mode: 'apply'
			});

			const result =
				payload && typeof payload === 'object' && !Array.isArray(payload)
					? payload.result
					: undefined;
			const resultRecord =
				result && typeof result === 'object' && !Array.isArray(result)
					? (result as Record<string, unknown>)
					: null;
			const warningCandidates = resultRecord?.warnings;
			backupWarnings = Array.isArray(warningCandidates)
				? warningCandidates.filter(
						(warning: unknown): warning is string => typeof warning === 'string'
					)
				: [];
			backupMessage =
				backupWarnings.length > 0
					? m.settings_system_backup_restoreSuccessWithWarnings()
					: m.settings_system_backup_restoreSuccess();
			selectedBackupFile = null;
			backupPreview = null;
			selectedRestoreSections = [];
			await refreshAll();
		} catch (error) {
			backupError =
				error instanceof Error ? error.message : m.settings_system_backup_errorRestoreFailed();
		} finally {
			backupImporting = false;
		}
	}

	function promptRestoreConfiguration() {
		if (!selectedBackupFile) {
			backupError = m.settings_system_backup_errorSelectFileFirst();
			return;
		}

		if (selectedRestoreSections.length === 0) {
			backupError = m.settings_system_backup_errorSelectSectionFirst();
			return;
		}

		if (!backupImportPassphrase.trim()) {
			backupError = m.settings_system_backup_errorPassphraseRequired();
			return;
		}

		backupError = null;
		confirmRestoreOpen = true;
	}
</script>

<svelte:head>
	<title>{m.settings_system_backup_pageTitle()}</title>
</svelte:head>

<SettingsPage title={m.nav_backupRestore()} subtitle={m.settings_system_backup_subtitle()}>
	<SettingsSection title="">
		<div class="alert overflow-hidden alert-info">
			<AlertCircle class="h-5 w-5" />
			<div class="min-w-0">
				<p class="font-medium">{m.settings_system_backup_noticeTitle()}</p>
				<p class="text-sm wrap-break-word">
					{m.settings_system_backup_noticeDescription()}
				</p>
			</div>
		</div>

		{#if backupError}
			<div class="alert alert-error">
				<AlertCircle class="h-4 w-4" />
				<span>{backupError}</span>
			</div>
		{/if}

		{#if backupWarnings.length > 0}
			<div class="alert alert-warning">
				<AlertCircle class="h-4 w-4" />
				<div class="space-y-1">
					<div class="font-medium">{m.settings_system_backup_restoreWarningsTitle()}</div>
					<ul class="list-inside list-disc text-sm">
						{#each backupWarnings as warning (warning)}
							<li>{warning}</li>
						{/each}
					</ul>
				</div>
			</div>
		{/if}

		{#if backupMessage}
			<div class="alert alert-success">
				<CheckCircle class="h-4 w-4" />
				<span>{backupMessage}</span>
			</div>
		{/if}

		<div class="grid gap-4 lg:grid-cols-2">
			<!-- Export -->
			<div class="min-w-0 overflow-hidden rounded-lg bg-base-100 p-4">
				<div class="mb-3 flex items-center gap-2">
					<Download class="h-5 w-5" />
					<h3 class="text-base font-semibold">{m.settings_system_backup_exportTitle()}</h3>
				</div>

				<p class="mb-4 text-sm wrap-break-word text-base-content/70">
					{m.settings_system_backup_exportDescription()}
				</p>

				<label
					class="label flex-wrap items-start gap-2 whitespace-normal"
					for="backup-export-passphrase"
				>
					<span class="label-text">{m.settings_system_backup_exportPassphraseLabel()}</span>
				</label>
				<input
					id="backup-export-passphrase"
					type="password"
					class="input-bordered input w-full"
					placeholder={m.settings_system_backup_exportPassphrasePlaceholder()}
					bind:value={backupExportPassphrase}
				/>

				<label class="label mt-4 cursor-pointer justify-start gap-3 whitespace-normal">
					<input
						type="checkbox"
						class="checkbox checkbox-sm checkbox-primary"
						bind:checked={backupIncludeIndexerCookies}
					/>
					<div class="min-w-0">
						<span class="label-text font-medium"
							>{m.settings_system_backup_includeCookiesLabel()}</span
						>
						<p class="text-sm wrap-break-word text-base-content/70">
							{m.settings_system_backup_includeCookiesHelp()}
						</p>
					</div>
				</label>

				<div class="mt-4 flex justify-end">
					<button
						class="btn w-full gap-2 btn-primary sm:w-auto"
						onclick={exportConfigurationBackup}
						disabled={backupExporting || backupExportPassphrase.trim().length < 16}
					>
						{#if backupExporting}
							<RefreshCw class="h-4 w-4 animate-spin" />
							{m.settings_system_backup_exporting()}
						{:else}
							<Download class="h-4 w-4" />
							{m.settings_system_backup_exportButton()}
						{/if}
					</button>
				</div>
			</div>

			<!-- Restore -->
			<div class="min-w-0 overflow-hidden rounded-lg bg-base-100 p-4">
				<div class="mb-3 flex items-center gap-2">
					<Upload class="h-5 w-5" />
					<h3 class="text-base font-semibold">{m.settings_system_backup_restoreTitle()}</h3>
				</div>

				<p class="mb-4 text-sm wrap-break-word text-base-content/70">
					{m.settings_system_backup_restoreDescription()}
				</p>

				<label
					class="label flex-wrap items-start gap-2 whitespace-normal"
					for="backup-restore-file"
				>
					<span class="label-text">{m.settings_system_backup_fileLabel()}</span>
				</label>
				<input
					id="backup-restore-file"
					type="file"
					class="file-input-bordered file-input w-full max-w-full min-w-0 focus:border-primary focus:outline-none"
					accept="application/json,.json"
					onchange={handleBackupFileChange}
				/>

				{#if backupPreview}
					<div class="mt-4 min-w-0 overflow-hidden rounded-lg border border-base-300 p-4">
						<div
							class="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
						>
							<div class="min-w-0">
								<div class="font-medium">{m.settings_system_backup_previewTitle()}</div>
								<div class="text-sm wrap-break-word text-base-content/70">
									{m.settings_system_backup_version({ version: String(backupPreview.version) })}
									{#if backupPreview.createdAt}
										• {formatDisplayDate(backupPreview.createdAt, {
											month: 'short',
											day: 'numeric',
											hour: 'numeric',
											minute: '2-digit'
										})}
									{/if}
								</div>
							</div>
							<div class="text-right text-sm text-base-content/70">
								<div>
									{m.settings_system_backup_sectionCount({
										count: String(backupPreview.totalSections)
									})}
								</div>
							</div>
						</div>

						<div class="space-y-2">
							<div class="text-sm font-medium">
								{m.settings_system_backup_restoreSectionsTitle()}
							</div>
							{#each backupPreview.sections.filter((section) => section.totalRows > 0) as section (section.id)}
								<label
									class="flex cursor-pointer items-start gap-3 rounded-lg border border-base-300 p-3"
								>
									<input
										type="checkbox"
										class="checkbox mt-0.5 checkbox-sm checkbox-primary"
										checked={selectedRestoreSections.includes(section.id)}
										onchange={(event) =>
											toggleRestoreSection(
												section.id,
												(event.currentTarget as HTMLInputElement).checked
											)}
									/>
									<div class="min-w-0">
										<div class="font-medium">{getSectionLabel(section.id)}</div>
										<div class="text-sm text-base-content/70">
											{section.summary}
										</div>
									</div>
								</label>
							{/each}
						</div>

						{#if backupPreview.includeIndexerCookies}
							<div class="mt-4 alert overflow-hidden alert-warning">
								<AlertCircle class="h-4 w-4" />
								<span class="wrap-break-word">
									{m.settings_system_backup_cookieWarning()}
								</span>
							</div>
						{/if}
					</div>
				{/if}

				<label
					class="label mt-3 flex-wrap items-start gap-2 whitespace-normal"
					for="backup-import-passphrase"
				>
					<span class="label-text">{m.settings_system_backup_restorePassphraseLabel()}</span>
				</label>
				<input
					id="backup-import-passphrase"
					type="password"
					class="input-bordered input w-full"
					placeholder={m.settings_system_backup_restorePassphrasePlaceholder()}
					bind:value={backupImportPassphrase}
				/>

				<div class="mt-4 flex justify-end">
					<button
						class="btn w-full gap-2 btn-warning sm:w-auto"
						onclick={promptRestoreConfiguration}
						disabled={backupImporting ||
							!selectedBackupFile ||
							selectedRestoreSections.length === 0 ||
							!backupImportPassphrase.trim()}
					>
						{#if backupImporting}
							<RefreshCw class="h-4 w-4 animate-spin" />
							{m.settings_system_backup_restoring()}
						{:else}
							<Upload class="h-4 w-4" />
							{m.settings_system_backup_restoreButton()}
						{/if}
					</button>
				</div>
			</div>
		</div>
	</SettingsSection>

	<SettingsSection title={m.settings_system_backup_db_sectionTitle()}>
		{#if showFolderBrowser}
			<FolderBrowser
				value={dbBackupSettings.directory || '/'}
				onSelect={(path) => {
					dbBackupSettings.directory = path;
					showFolderBrowser = false;
					saveDbBackupSettings();
				}}
				onCancel={() => (showFolderBrowser = false)}
			/>
		{:else}
			<div class="space-y-6">
				{#if dbBackupError}
					<div class="alert alert-error">
						<AlertCircle class="h-4 w-4" />
						<span>{dbBackupError}</span>
					</div>
				{/if}

				{#if dbBackupSuccess}
					<div class="alert alert-success">
						<CheckCircle class="h-4 w-4" />
						<span>{dbBackupSuccess}</span>
					</div>
				{/if}

				<!-- Settings -->
				<div class="space-y-4 rounded-box border border-base-300 bg-base-200 p-4">
					<div class="flex items-center justify-between">
						<div>
							<p class="font-medium">{m.settings_system_backup_db_scheduledTitle()}</p>
							<p class="text-sm text-base-content/60">
								{m.settings_system_backup_db_scheduledDesc()}
							</p>
							{#if dbScheduledBackups.length > 0}
								{@const latest = [...dbScheduledBackups].sort((a, b) =>
									b.filename.localeCompare(a.filename)
								)[0]}
								<p class="mt-1 text-xs text-base-content/40">
									{m.settings_system_backup_db_lastBackup({
										timestamp: latest.filename
											.replace('cinephage-backup-', '')
											.replace('.db', '')
											.replace(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/, '$1-$2-$3 $4:$5:$6')
									})}
								</p>
							{/if}
						</div>
						<input
							type="checkbox"
							class="toggle toggle-primary"
							bind:checked={dbBackupSettings.enabled}
							onchange={saveDbBackupSettings}
						/>
					</div>

					<div class="space-y-2">
						<label class="label" for="db-backup-retention">
							<span class="label-text font-medium"
								>{m.settings_system_backup_db_copiesToKeep()}</span
							>
						</label>
						<select
							id="db-backup-retention"
							class="select-bordered select w-full max-w-xs"
							bind:value={dbBackupSettings.retentionCount}
							onchange={saveDbBackupSettings}
						>
							{#each [3, 5, 7, 14, 30] as n (n)}
								<option value={n}>{n}</option>
							{/each}
						</select>
						<p class="text-xs text-base-content/50">
							{m.settings_system_backup_db_copiesToKeepHint()}
						</p>
					</div>

					<div class="space-y-2">
						<label class="label" for="db-backup-dir">
							<span class="label-text font-medium"
								>{m.settings_system_backup_db_backupFolder()}</span
							>
						</label>
						<div class="flex gap-2">
							<input
								id="db-backup-dir"
								type="text"
								class="input-bordered input flex-1"
								placeholder="Default: data/backups/scheduled"
								bind:value={dbBackupSettings.directory}
								onblur={saveDbBackupSettings}
							/>
							<button
								class="btn btn-square btn-outline"
								title="Browse folders"
								onclick={() => (showFolderBrowser = true)}
							>
								<FolderOpen class="h-4 w-4" />
							</button>
						</div>
						<p class="text-xs text-base-content/50">
							{m.settings_system_backup_db_backupFolderHint()}
						</p>
					</div>

					<div class="flex justify-end">
						<button
							class="btn gap-2 btn-primary btn-sm"
							onclick={runDbBackupNow}
							disabled={dbBackupRunning}
						>
							{#if dbBackupRunning}
								<RefreshCw class="h-4 w-4 animate-spin" />
								{m.settings_system_backup_db_backingUp()}
							{:else}
								<HardDrive class="h-4 w-4" />
								{m.settings_system_backup_db_backUpNow()}
							{/if}
						</button>
					</div>
				</div>

				<!-- Scheduled backup list -->
				<div class="space-y-2">
					<h4 class="flex items-center gap-2 text-sm font-medium">
						<Database class="h-4 w-4" />
						{m.settings_system_backup_db_scheduledTitle()}
						{#if dbScheduledBackups.length > 0}
							<span class="badge badge-sm badge-primary">{dbScheduledBackups.length}</span>
						{/if}
					</h4>
					{#if dbBackupLoading}
						<p class="text-sm text-base-content/50">{m.settings_system_backup_db_noScheduled()}</p>
					{:else if dbScheduledBackups.length === 0}
						<p class="text-sm text-base-content/50">{m.settings_system_backup_db_noScheduled()}</p>
					{:else}
						{@const reversed = [...dbScheduledBackups].reverse()}
						{@const visible = showAllScheduled ? reversed : reversed.slice(0, BACKUP_LIST_PREVIEW)}
						<ul class="space-y-1">
							{#each visible as f (f.filename)}
								<li
									class="flex items-center justify-between rounded-box bg-base-200 px-3 py-2 text-sm"
								>
									<span class="truncate font-mono">{f.filename}</span>
									<span class="ml-4 shrink-0 text-base-content/50">{fmtBytes(f.sizeBytes)}</span>
								</li>
							{/each}
						</ul>
						{#if reversed.length > BACKUP_LIST_PREVIEW}
							<button
								class="flex items-center gap-1 text-xs text-base-content/50 transition-colors hover:text-base-content"
								onclick={() => (showAllScheduled = !showAllScheduled)}
							>
								{#if showAllScheduled}
									<ChevronUp class="h-3 w-3" /> {m.settings_system_backup_db_showFewer()}
								{:else}
									<ChevronDown class="h-3 w-3" />
									{m.settings_system_backup_db_showAll({ count: String(reversed.length) })}
								{/if}
							</button>
						{/if}
					{/if}
				</div>

				<!-- Pre-update backup list -->
				<div class="space-y-2">
					<h4 class="flex items-center gap-2 text-sm font-medium">
						<Database class="h-4 w-4 text-warning" />
						{m.settings_system_backup_db_preUpdateTitle()}
						<span class="badge badge-sm badge-secondary"
							>{m.settings_system_backup_db_alwaysOn()}</span
						>
					</h4>
					<p class="alert-sm alert alert-info">
						{m.settings_system_backup_db_preUpdateDesc()}
					</p>
					{#if dbBackupLoading}
						<p class="text-sm text-base-content/50">{m.common_loading()}</p>
					{:else if dbPreUpdateBackups.length === 0}
						<p class="text-sm text-base-content/50">{m.settings_system_backup_db_noPreUpdate()}</p>
					{:else}
						{@const reversedPre = [...dbPreUpdateBackups].reverse()}
						{@const visiblePre = showAllPreUpdate
							? reversedPre
							: reversedPre.slice(0, BACKUP_LIST_PREVIEW)}
						<ul class="space-y-1">
							{#each visiblePre as f (f.filename)}
								<li
									class="flex items-center justify-between rounded-box bg-base-200 px-3 py-2 text-sm"
								>
									<span class="truncate font-mono">{f.filename}</span>
									<span class="ml-4 shrink-0 text-base-content/50">{fmtBytes(f.sizeBytes)}</span>
								</li>
							{/each}
						</ul>
						{#if reversedPre.length > BACKUP_LIST_PREVIEW}
							<button
								class="flex items-center gap-1 text-xs text-base-content/50 transition-colors hover:text-base-content"
								onclick={() => (showAllPreUpdate = !showAllPreUpdate)}
							>
								{#if showAllPreUpdate}
									<ChevronUp class="h-3 w-3" /> {m.settings_system_backup_db_showFewer()}
								{:else}
									<ChevronDown class="h-3 w-3" />
									{m.settings_system_backup_db_showAll({ count: String(reversedPre.length) })}
								{/if}
							</button>
						{/if}
					{/if}
				</div>
			</div>
		{/if}
	</SettingsSection>
</SettingsPage>

<ConfirmationModal
	open={confirmRestoreOpen}
	title={m.settings_system_backup_confirmTitle()}
	message={m.settings_system_backup_confirmMessage({
		count: String(selectedRestoreSections.length)
	})}
	confirmLabel={m.settings_system_backup_restoreButton()}
	confirmVariant="warning"
	loading={backupImporting}
	onConfirm={importConfigurationBackup}
	onCancel={() => (confirmRestoreOpen = false)}
/>
