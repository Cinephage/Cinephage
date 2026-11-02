<script lang="ts">
	import {
		X,
		Download,
		Loader2,
		CheckCircle,
		XCircle,
		AlertCircle,
		WifiOff,
		RefreshCw,
		Settings,
		Trash2,
		ArrowLeft
	} from '@lucide/svelte';
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import ModalWrapper from '#lib/components/ui/modal/ModalWrapper.svelte';
	import { createIndexer, ApiError } from '#lib/api/index.js';
	import { getResponseErrorMessage } from '#lib/utils/http.js';
	import { refreshAll } from '$app/navigation';
	import { formatRelativeTime } from '#lib/components/activity/activity-display-utils.js';

	interface JackettIndexer {
		id: string;
		name: string;
		type: string;
		baseUrl: string;
		alreadyImported: boolean;
	}

	interface StoredConnection {
		url: string;
		autoSync: boolean;
		syncIntervalHours: number;
		syncAddNew: boolean;
		lastSyncAt: string | null;
		lastSyncResult: SyncResult | null;
		lastSyncError: string | null;
	}

	interface SyncResult {
		updated: number;
		removed: number;
		added: number;
		failed: number;
		errors: string[];
	}

	interface Props {
		open: boolean;
		storedConnection: StoredConnection | null;
		onClose: () => void;
	}

	let { open, storedConnection, onClose }: Props = $props();

	type Step = 'manage' | 'connect' | 'selectIndexers' | 'done';

	let step = $state<Step>('connect');
	let jackettUrl = $state('');
	let apiKey = $state('');
	let adminPassword = $state('');
	let autoSync = $state(false);
	let syncIntervalHours = $state(24);
	let syncAddNew = $state(false);
	let connection = $state<StoredConnection | null>(null);

	$effect(() => {
		if (open) {
			const conn = untrack(() => storedConnection);
			connection = conn;
			step = conn ? 'manage' : 'connect';
			jackettUrl = conn?.url ?? '';
			apiKey = '';
			adminPassword = '';
			autoSync = conn?.autoSync ?? false;
			syncIntervalHours = conn?.syncIntervalHours ?? 24;
			syncAddNew = conn?.syncAddNew ?? false;
			connectError = '';
			syncing = false;
			syncError = '';
			importing = false;
			doneResult = null;
			confirmingDelete = false;
			indexers = [];
			selected.clear();
		}
	});

	let connecting = $state(false);
	let connectError = $state('');

	let indexers = $state<JackettIndexer[]>([]);
	let selected = new SvelteSet<string>();
	let importing = $state(false);
	let browsingIndexers = $state(false);

	let syncing = $state(false);
	let syncError = $state('');

	let doneResult = $state<{ type: 'import' | 'sync'; result: SyncResult } | null>(null);
	let confirmingDelete = $state(false);

	let savingSettings = $state(false);
	let saveSettingsTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleSettingsSave() {
		if (!connection) return;
		if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
		saveSettingsTimer = setTimeout(async () => {
			if (!connection) return;
			savingSettings = true;
			try {
				const res = await fetch('/api/indexers/jackett/connection', {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ url: connection.url, autoSync, syncIntervalHours, syncAddNew })
				});
				if (res.ok) {
					await refreshAll();
				}
			} finally {
				savingSettings = false;
			}
		}, 400);
	}

	function handleClose() {
		onClose();
	}

	async function handleConnect() {
		connectError = '';
		connecting = true;
		try {
			const res = await fetch('/api/indexers/jackett/connection', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					url: jackettUrl,
					apiKey,
					adminPassword: adminPassword || undefined,
					autoSync,
					syncIntervalHours,
					syncAddNew
				})
			});
			const data = await res.json();
			if (!res.ok) {
				connectError = data.error ?? 'Failed to connect to Jackett.';
				return;
			}

			const indexerRes = await fetch('/api/indexers/jackett', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url: jackettUrl, apiKey })
			});
			const indexerData = await indexerRes.json();
			if (!indexerRes.ok) {
				connectError = indexerData.error ?? 'Failed to fetch indexers.';
				return;
			}

			indexers = indexerData.indexers as JackettIndexer[];
			selected.clear();
			for (const i of indexers) {
				if (!i.alreadyImported) selected.add(i.id);
			}
			connection = {
				url: jackettUrl,
				autoSync,
				syncIntervalHours,
				syncAddNew,
				lastSyncAt: null,
				lastSyncResult: null,
				lastSyncError: null
			};
			step = 'selectIndexers';
		} catch {
			connectError = 'Unable to reach Jackett. Check the URL and try again.';
		} finally {
			connecting = false;
		}
	}

	async function handleImport() {
		importing = true;
		const toImport = indexers.filter((i) => selected.has(i.id));
		const result: SyncResult = { updated: 0, added: 0, removed: 0, failed: 0, errors: [] };

		for (const indexer of toImport) {
			try {
				await createIndexer({
					name: indexer.name,
					definitionId: 'torznab',
					baseUrl: indexer.baseUrl,
					alternateUrls: [],
					enabled: true,
					priority: 25,
					settings: { apikey: apiKey },
					enableAutomaticSearch: true,
					enableInteractiveSearch: true,
					minimumSeeders: 1,
					seedRatio: null,
					seedTime: null,
					packSeedTime: null,
					rejectDeadTorrents: true,
					rejectPasswordProtected: true,
					minimumCompletionPercentage: 95
				});
				result.added += 1;
			} catch (e) {
				const error =
					e instanceof ApiError
						? getResponseErrorMessage(e.response, 'Import failed')
						: e instanceof Error
							? e.message
							: 'Unknown error';
				result.failed += 1;
				result.errors.push(`${indexer.name}: ${String(error)}`);
			}
		}

		importing = false;
		doneResult = { type: 'import', result };
		step = 'done';
		await refreshAll();
	}

	async function browseAndImport() {
		browsingIndexers = true;
		connectError = '';
		try {
			const res = await fetch('/api/indexers/jackett/indexers');
			const data = await res.json();
			if (!res.ok) {
				connectError = data.error ?? 'Failed to fetch indexers.';
				return;
			}
			indexers = data.indexers as JackettIndexer[];
			selected.clear();
			for (const i of indexers) {
				if (!i.alreadyImported) selected.add(i.id);
			}
			step = 'selectIndexers';
		} catch {
			connectError = 'Unable to reach Jackett.';
		} finally {
			browsingIndexers = false;
		}
	}

	async function handleSyncNow() {
		syncing = true;
		syncError = '';
		try {
			const res = await fetch('/api/indexers/jackett/sync', { method: 'POST' });
			const data = await res.json();
			if (!res.ok) {
				syncError = data.error ?? 'Sync failed.';
				return;
			}
			await refreshConnection();
			doneResult = { type: 'sync', result: data.result as SyncResult };
			step = 'done';
			await refreshAll();
		} catch {
			syncError = 'Sync failed. Check that Jackett is still accessible.';
		} finally {
			syncing = false;
		}
	}

	async function handleDeleteConnection() {
		try {
			await fetch('/api/indexers/jackett/connection', { method: 'DELETE' });
			connection = null;
			step = 'connect';
			jackettUrl = '';
			apiKey = '';
			autoSync = false;
			syncIntervalHours = 24;
			confirmingDelete = false;
			await refreshAll();
		} catch {
			// ignore
		}
	}

	async function refreshConnection() {
		try {
			const res = await fetch('/api/indexers/jackett/connection');
			if (res.ok) {
				const data = await res.json();
				connection = data.connection as StoredConnection | null;
			}
		} catch {
			// ignore
		}
	}

	function toggleAll(checked: boolean) {
		selected.clear();
		if (checked) {
			for (const i of indexers) {
				if (!i.alreadyImported) selected.add(i.id);
			}
		}
	}

	function toggleOne(id: string, checked: boolean) {
		if (checked) selected.add(id);
		else selected.delete(id);
	}

	const selectableIds = $derived(indexers.filter((i) => !i.alreadyImported).map((i) => i.id));
	const allSelected = $derived(
		selectableIds.length > 0 && selectableIds.every((id) => selected.has(id))
	);
	const someSelected = $derived(selected.size > 0 && !allSelected);

	const stepTitle = $derived(
		step === 'manage'
			? 'Jackett Connection'
			: step === 'selectIndexers'
				? 'Select Indexers'
				: step === 'done'
					? 'Done'
					: connection
						? 'Change Connection'
						: 'Connect to Jackett'
	);
</script>

<ModalWrapper {open} onClose={handleClose} maxWidth="lg" flexContent>
	<!-- Header -->
	<div class="flex shrink-0 items-center justify-between border-b border-base-300 px-6 py-4">
		<div class="flex items-center gap-2">
			{#if step === 'selectIndexers'}
				<button
					type="button"
					class="btn -ml-1 btn-square btn-ghost btn-xs"
					onclick={() => (step = connection ? 'manage' : 'connect')}
					aria-label="Back"
				>
					<ArrowLeft class="h-4 w-4" />
				</button>
			{/if}
			<Download class="h-5 w-5 text-primary" />
			<h2 class="text-lg font-semibold">{stepTitle}</h2>
		</div>
		<button type="button" class="btn btn-square btn-ghost btn-sm" onclick={handleClose}>
			<X class="h-4 w-4" />
		</button>
	</div>

	<!-- Step: Connect / Change Connection -->
	{#if step === 'connect'}
		<div class="flex-1 space-y-4 overflow-y-auto p-6">
			<p class="text-sm text-base-content/70">
				{connection
					? 'Enter new connection details. Existing imported indexers will not be affected.'
					: 'Enter your Jackett URL and API key. Each indexer will be imported as a separate Torznab entry.'}
			</p>
			<div class="form-control">
				<label class="label" for="jackett-url">
					<span class="label-text">Jackett URL</span>
				</label>
				<input
					id="jackett-url"
					type="url"
					class="input-bordered input w-full"
					placeholder="http://localhost:9117"
					bind:value={jackettUrl}
					disabled={connecting}
				/>
			</div>
			<div class="form-control">
				<label class="label" for="jackett-key">
					<span class="label-text">API Key</span>
				</label>
				<input
					id="jackett-key"
					type="password"
					class="input-bordered input w-full font-mono"
					placeholder="Your Jackett API key"
					bind:value={apiKey}
					disabled={connecting}
					onkeydown={(e) => e.key === 'Enter' && jackettUrl && apiKey && handleConnect()}
				/>
				<p class="mt-1 text-xs text-base-content/60">
					Found in Jackett under the dashboard - API Key field at the top right
				</p>
			</div>
			<div class="form-control">
				<label class="label" for="jackett-admin-password">
					<span class="label-text"
						>Admin Password <span class="text-base-content/50">(optional)</span></span
					>
				</label>
				<input
					id="jackett-admin-password"
					type="password"
					class="input-bordered input w-full"
					placeholder="Leave blank if no password is set"
					bind:value={adminPassword}
					disabled={connecting}
				/>
				<p class="mt-1 text-xs text-base-content/60">
					Only required if you set one in Jackett under Config → Admin password
				</p>
			</div>
			<div class="divider my-2 text-xs text-base-content/50">Auto-sync</div>
			<div class="flex items-center justify-between">
				<div>
					<p class="text-sm font-medium">Automatic sync</p>
					<p class="text-xs text-base-content/60">
						Update existing indexers and remove deleted ones on a schedule
					</p>
				</div>
				<input type="checkbox" class="toggle toggle-primary toggle-sm" bind:checked={autoSync} />
			</div>
			{#if autoSync}
				<div class="form-control">
					<label class="label py-1" for="sync-interval">
						<span class="label-text text-sm">Sync interval</span>
					</label>
					<select
						id="sync-interval"
						class="select-bordered select select-sm"
						bind:value={syncIntervalHours}
					>
						<option value={6}>Every 6 hours</option>
						<option value={12}>Every 12 hours</option>
						<option value={24}>Daily (recommended)</option>
						<option value={48}>Every 2 days</option>
						<option value={168}>Weekly</option>
					</select>
				</div>
			{/if}
			<div class="flex items-center justify-between">
				<div>
					<p class="text-sm font-medium">Import new indexers during sync</p>
					<p class="text-xs text-base-content/60">
						Automatically add Jackett indexers you haven't imported yet
					</p>
				</div>
				<input type="checkbox" class="toggle toggle-primary toggle-sm" bind:checked={syncAddNew} />
			</div>
			{#if connectError}
				<div class="alert py-2 text-sm alert-error">{connectError}</div>
			{/if}
		</div>
		<div class="flex shrink-0 justify-between gap-2 border-t border-base-300 px-6 py-4">
			<button type="button" class="btn btn-ghost btn-sm" onclick={handleClose}>Cancel</button>
			<button
				type="button"
				class="btn btn-primary btn-sm"
				onclick={handleConnect}
				disabled={!jackettUrl || !apiKey || connecting}
			>
				{#if connecting}
					<Loader2 class="h-4 w-4 animate-spin" />
					Connecting...
				{:else}
					Connect
				{/if}
			</button>
		</div>

		<!-- Step: Manage existing connection -->
	{:else if step === 'manage'}
		<div class="flex-1 space-y-4 overflow-y-auto p-6">
			<div
				class="space-y-2 rounded-box p-4 {connection?.lastSyncError
					? 'border border-warning/30 bg-warning/5'
					: 'bg-base-200/60'}"
			>
				<div class="flex items-start justify-between gap-4">
					<div class="min-w-0">
						<p class="text-xs font-semibold tracking-wide text-base-content/50 uppercase">
							Connected to
						</p>
						<p class="mt-0.5 truncate text-sm font-medium">{connection?.url}</p>
					</div>
					{#if connection?.lastSyncError}
						<WifiOff class="mt-0.5 h-5 w-5 shrink-0 text-warning" />
					{:else}
						<CheckCircle class="mt-0.5 h-5 w-5 shrink-0 text-success" />
					{/if}
				</div>
				{#if connection?.lastSyncError}
					<p class="text-xs text-warning">{connection.lastSyncError}</p>
				{/if}
				<div class="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-xs text-base-content/60">
					<span>Last synced: {formatRelativeTime(connection?.lastSyncAt ?? null)}</span>
					{#if connection?.lastSyncResult && !connection?.lastSyncError}
						{@const r = connection.lastSyncResult}
						{#if r.failed > 0}
							<span class="flex items-center gap-1 text-warning">
								<AlertCircle class="h-3.5 w-3.5" />
								{r.updated} updated · {r.removed} removed{r.added > 0 ? ` · ${r.added} added` : ''} ·
								{r.failed} failed
							</span>
						{:else}
							<span
								>{r.updated} updated · {r.removed} removed{r.added > 0
									? ` · ${r.added} added`
									: ''}</span
							>
						{/if}
					{/if}
				</div>
			</div>

			<div class="flex items-center justify-between">
				<div>
					<p class="text-sm font-medium">Sync now</p>
					<p class="text-xs text-base-content/60">Update existing indexers, remove deleted ones</p>
				</div>
				<button
					type="button"
					class="btn gap-1.5 btn-primary btn-sm"
					onclick={handleSyncNow}
					disabled={syncing}
				>
					{#if syncing}
						<Loader2 class="h-4 w-4 animate-spin" />
						Syncing...
					{:else}
						<RefreshCw class="h-4 w-4" />
						Sync
					{/if}
				</button>
			</div>

			{#if syncError}
				<div class="alert py-2 text-sm alert-error">{syncError}</div>
			{/if}

			<div class="divider my-1 text-xs text-base-content/50">Auto-sync settings</div>

			<div class="flex items-center justify-between">
				<div>
					<p class="text-sm font-medium">Automatic sync</p>
					<p class="text-xs text-base-content/60">Keep indexers in sync automatically</p>
				</div>
				<input
					type="checkbox"
					class="toggle toggle-primary toggle-sm"
					checked={autoSync}
					onchange={(e) => {
						autoSync = (e.currentTarget as HTMLInputElement).checked;
						scheduleSettingsSave();
					}}
				/>
			</div>
			{#if autoSync}
				<div class="form-control">
					<label class="label py-1" for="manage-sync-interval">
						<span class="label-text text-sm">Sync interval</span>
					</label>
					<select
						id="manage-sync-interval"
						class="select-bordered select select-sm"
						value={syncIntervalHours}
						onchange={(e) => {
							syncIntervalHours = Number((e.currentTarget as HTMLSelectElement).value);
							scheduleSettingsSave();
						}}
					>
						<option value={6}>Every 6 hours</option>
						<option value={12}>Every 12 hours</option>
						<option value={24}>Daily (recommended)</option>
						<option value={48}>Every 2 days</option>
						<option value={168}>Weekly</option>
					</select>
				</div>
			{/if}

			<div class="flex items-center justify-between">
				<div>
					<p class="text-sm font-medium">Import new indexers during sync</p>
					<p class="text-xs text-base-content/60">
						Automatically add Jackett indexers you haven't imported yet
					</p>
				</div>
				<input
					type="checkbox"
					class="toggle toggle-primary toggle-sm"
					checked={syncAddNew}
					onchange={(e) => {
						syncAddNew = (e.currentTarget as HTMLInputElement).checked;
						scheduleSettingsSave();
					}}
				/>
			</div>

			{#if connectError}
				<div class="alert py-2 text-sm alert-error">{connectError}</div>
			{/if}

			<div class="divider my-1"></div>

			{#if confirmingDelete}
				<div class="space-y-2 rounded-box border border-error/30 bg-error/5 p-3">
					<p class="text-sm font-medium text-error">Delete this connection?</p>
					<p class="text-xs text-base-content/70">
						Already imported indexers will remain in Cinephage. Only the saved connection and
						auto-sync will be removed.
					</p>
					<div class="flex gap-2 pt-1">
						<button type="button" class="btn btn-error btn-xs" onclick={handleDeleteConnection}>
							<Trash2 class="h-3.5 w-3.5" />
							Yes, delete
						</button>
						<button
							type="button"
							class="btn btn-ghost btn-xs"
							onclick={() => (confirmingDelete = false)}>Cancel</button
						>
					</div>
				</div>
			{:else}
				<div class="flex items-center justify-between">
					<button
						type="button"
						class="btn gap-1.5 btn-ghost text-base-content/60 btn-sm"
						onclick={() => {
							jackettUrl = connection?.url ?? '';
							apiKey = '';
							connectError = '';
							step = 'connect';
						}}
					>
						<Settings class="h-4 w-4" />
						Change connection
					</button>
					<button
						type="button"
						class="btn gap-1.5 btn-ghost text-error/70 btn-sm"
						onclick={() => (confirmingDelete = true)}
					>
						<Trash2 class="h-4 w-4" />
						Delete connection
					</button>
				</div>
			{/if}
		</div>
		<div class="flex shrink-0 justify-between gap-2 border-t border-base-300 px-6 py-4">
			<button
				type="button"
				class="btn gap-1.5 btn-ghost btn-sm"
				disabled={browsingIndexers}
				onclick={browseAndImport}
			>
				{#if browsingIndexers}
					<Loader2 class="h-4 w-4 animate-spin" />
					Loading...
				{:else}
					<Download class="h-4 w-4" />
					Browse &amp; import
				{/if}
			</button>
			<button type="button" class="btn btn-primary btn-sm" onclick={handleClose}>
				{#if savingSettings}
					<Loader2 class="h-4 w-4 animate-spin" />
				{/if}
				Close
			</button>
		</div>

		<!-- Step: Browse / select indexers -->
	{:else if step === 'selectIndexers'}
		{#if indexers.length === 0}
			<div class="flex flex-col items-center justify-center gap-3 p-10">
				<Loader2 class="h-6 w-6 animate-spin text-base-content/40" />
				<p class="text-sm text-base-content/60">Loading indexers from Jackett...</p>
			</div>
		{:else}
			<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
				<div class="shrink-0 border-b border-base-300 px-6 py-3">
					<p class="text-sm text-base-content/70">
						{indexers.length} indexer{indexers.length !== 1 ? 's' : ''} found.
						{selected.size} selected for import.
					</p>
				</div>
				<div class="flex-1 overflow-y-auto">
					<div class="flex items-center gap-3 border-b border-base-300 bg-base-200/40 px-4 py-2.5">
						<input
							type="checkbox"
							class="checkbox checkbox-sm checkbox-primary"
							checked={allSelected}
							indeterminate={someSelected}
							onchange={(e) => toggleAll((e.target as HTMLInputElement).checked)}
						/>
						<span class="text-sm font-medium">Select all</span>
					</div>
					{#each indexers as indexer (indexer.id)}
						<label
							class="flex cursor-pointer items-center gap-3 border-b border-base-300/40 px-4 py-3 last:border-0 hover:bg-base-200/40 {indexer.alreadyImported
								? 'opacity-50'
								: ''}"
						>
							<input
								type="checkbox"
								class="checkbox shrink-0 checkbox-sm checkbox-primary"
								checked={selected.has(indexer.id)}
								disabled={indexer.alreadyImported}
								onchange={(e) => toggleOne(indexer.id, (e.target as HTMLInputElement).checked)}
							/>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-1.5">
									<span class="text-sm font-medium">{indexer.name}</span>
									{#if indexer.alreadyImported}
										<span class="badge badge-ghost badge-xs">already added</span>
									{/if}
								</div>
								<div class="mt-0.5 text-xs text-base-content/50">
									Torznab · {indexer.type}
								</div>
							</div>
						</label>
					{/each}
				</div>
			</div>
			<div class="flex shrink-0 justify-between gap-2 border-t border-base-300 px-6 py-4">
				<button
					type="button"
					class="btn btn-ghost btn-sm"
					onclick={() => (step = connection ? 'manage' : 'connect')}
				>
					Back
				</button>
				<button
					type="button"
					class="btn btn-primary btn-sm"
					onclick={handleImport}
					disabled={selected.size === 0 || importing}
				>
					{#if importing}
						<Loader2 class="h-4 w-4 animate-spin" />
						Importing...
					{:else}
						Import {selected.size} indexer{selected.size !== 1 ? 's' : ''}
					{/if}
				</button>
			</div>
		{/if}

		<!-- Step: Done -->
	{:else if step === 'done' && doneResult}
		{@const { result } = doneResult}
		<div class="flex-1 space-y-4 overflow-y-auto p-6">
			<div class="flex items-start gap-2">
				{#if result.failed === 0}
					<CheckCircle class="mt-0.5 h-5 w-5 shrink-0 text-success" />
					<div>
						<p class="text-sm font-medium">
							{doneResult.type === 'sync' ? 'Sync complete' : 'Import complete'}
						</p>
						<p class="mt-0.5 text-sm text-base-content/70">
							{#if doneResult.type === 'sync'}
								{result.updated} updated · {result.removed} removed{result.added > 0
									? ` · ${result.added} added`
									: ''}
							{:else}
								Imported {result.added} indexer{result.added !== 1 ? 's' : ''}
							{/if}
						</p>
					</div>
				{:else if result.updated === 0 && result.added === 0 && result.removed === 0}
					<XCircle class="mt-0.5 h-5 w-5 shrink-0 text-error" />
					<p class="text-sm font-medium">
						All {result.failed} operation{result.failed !== 1 ? 's' : ''} failed.
					</p>
				{:else}
					<AlertCircle class="mt-0.5 h-5 w-5 shrink-0 text-warning" />
					<div>
						<p class="text-sm font-medium">Completed with errors</p>
						<p class="mt-0.5 text-sm text-base-content/70">
							{result.updated} updated · {result.removed} removed{result.added > 0
								? ` · ${result.added} added`
								: ''} · {result.failed} failed
						</p>
					</div>
				{/if}
			</div>
			{#if result.errors.length > 0}
				<div class="space-y-1.5">
					{#each result.errors as error (error)}
						<div class="flex items-start gap-2 text-sm text-error">
							<XCircle class="mt-0.5 h-4 w-4 shrink-0" />
							<span>{error}</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
		<div class="flex shrink-0 justify-end border-t border-base-300 px-6 py-4">
			<button type="button" class="btn btn-primary btn-sm" onclick={handleClose}>Done</button>
		</div>
	{/if}
</ModalWrapper>
