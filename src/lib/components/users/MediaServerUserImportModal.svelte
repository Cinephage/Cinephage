<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { refreshAll } from '$app/navigation';
	import { SvelteSet } from 'svelte/reactivity';
	import { Loader2, RefreshCw, Server, ShieldCheck } from '@lucide/svelte';
	import { apiGet, apiPost } from '#lib/api/client.js';
	import { toasts } from '#lib/stores/toast.svelte.js';
	import { ModalWrapper, ModalHeader, ModalFooter } from '#lib/components/ui/modal/index.js';
	import MediaServerImportResults from './MediaServerImportResults.svelte';

	// Local mirrors of the API shapes; server types must not cross the
	// client boundary.
	interface ImportableServer {
		id: string;
		name: string;
	}

	type ImportStatus =
		'importable' | 'linked' | 'disabled' | 'invalid-username' | 'username-taken' | 'email-taken';

	interface ImportCandidate {
		id: string;
		name: string;
		isAdministrator: boolean;
		status: ImportStatus;
		linkedTo: string | null;
		suggestedEmail: string;
	}

	interface ImportRowResult {
		serverUserId: string;
		serverUsername: string;
		status: 'created' | 'failed';
		error: string | null;
		userId: string | null;
		username: string | null;
		email: string | null;
		tempPassword: string | null;
		linked: boolean;
	}

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	let { open, onClose }: Props = $props();

	const IMPORT_URL = '/api/settings/users/media-server-import';

	type Step = 'select' | 'results';
	let step = $state<Step>('select');
	let servers = $state<ImportableServer[] | null>(null);
	let serverId = $state('');
	let users = $state<ImportCandidate[] | null>(null);
	let rosterLoading = $state(false);
	let rosterFailed = $state(false);
	let selected = new SvelteSet<string>();
	let importing = $state(false);
	let results = $state<ImportRowResult[] | null>(null);
	let copiedId = $state<string | null>(null);

	$effect(() => {
		if (open) {
			step = 'select';
			servers = null;
			serverId = '';
			users = null;
			rosterLoading = false;
			rosterFailed = false;
			selected.clear();
			importing = false;
			results = null;
			copiedId = null;
			void loadServers();
		}
	});

	async function loadServers(): Promise<void> {
		try {
			const res = await apiGet<{ servers: ImportableServer[] }>(IMPORT_URL);
			servers = res.servers ?? [];
			if (servers.length === 1) {
				serverId = servers[0]!.id;
				await loadRoster(serverId);
			}
		} catch {
			servers = [];
		}
	}

	async function loadRoster(id: string): Promise<void> {
		users = null;
		rosterFailed = false;
		rosterLoading = true;
		selected.clear();
		try {
			const res = await apiGet<{ users: ImportCandidate[] | null }>(IMPORT_URL, { serverId: id });
			users = res.users ?? [];
			for (const candidate of users) {
				if (candidate.status === 'importable') selected.add(candidate.id);
			}
		} catch {
			rosterFailed = true;
		} finally {
			rosterLoading = false;
		}
	}

	function toggleAll(checked: boolean): void {
		selected.clear();
		if (checked) {
			for (const candidate of users ?? []) {
				if (candidate.status === 'importable') selected.add(candidate.id);
			}
		}
	}

	const importable = $derived(
		(users ?? []).filter((candidate) => candidate.status === 'importable')
	);
	const allSelected = $derived(
		importable.length > 0 && importable.every((candidate) => selected.has(candidate.id))
	);
	const someSelected = $derived(selected.size > 0 && !allSelected);

	function statusBadge(candidate: ImportCandidate): {
		label: string;
		class: string;
		title: string | null;
	} {
		switch (candidate.status) {
			case 'importable':
				return { label: m.users_importStatusImportable(), class: 'badge-ghost', title: null };
			case 'linked':
				return {
					label: m.users_importStatusLinked(),
					class: 'badge-primary',
					title: candidate.linkedTo
						? m.users_importLinkedTo({ username: candidate.linkedTo })
						: null
				};
			case 'disabled':
				return { label: m.users_importStatusDisabled(), class: 'badge-ghost', title: null };
			case 'invalid-username':
				return {
					label: m.users_importStatusInvalidUsername(),
					class: 'badge-warning',
					title: null
				};
			case 'username-taken':
				return { label: m.users_importStatusUsernameTaken(), class: 'badge-warning', title: null };
			case 'email-taken':
				return { label: m.users_importStatusEmailTaken(), class: 'badge-warning', title: null };
		}
	}

	async function handleImport(): Promise<void> {
		if (selected.size === 0) {
			toasts.error(m.users_importNoneSelected());
			return;
		}
		importing = true;
		try {
			const res = await apiPost<{ results: ImportRowResult[] }>(IMPORT_URL, {
				serverId,
				serverUserIds: [...selected]
			});
			results = res.results ?? [];
			step = 'results';
			void refreshAll();
		} catch (error) {
			toasts.error(error instanceof Error ? error.message : m.users_importLoadFailed());
		} finally {
			importing = false;
		}
	}

	async function handleCopy(row: ImportRowResult): Promise<void> {
		if (!row.tempPassword) return;
		try {
			await navigator.clipboard.writeText(row.tempPassword);
			copiedId = row.serverUserId;
		} catch {
			toasts.error(m.users_importLoadFailed());
		}
	}

	const title = $derived(step === 'results' ? m.users_importResultsTitle() : m.users_importTitle());
</script>

<ModalWrapper {open} {onClose} maxWidth="xl" flexContent>
	<ModalHeader {title} {onClose} />
	<div class="min-h-0 flex-1 overflow-y-auto">
		{#if step === 'select'}
			<p class="mb-4 text-sm text-base-content/70">{m.users_importDescription()}</p>

			{#if servers === null}
				<div class="flex items-center justify-center gap-2 py-12 text-base-content/50">
					<Loader2 class="h-5 w-5 animate-spin" />
					<span class="text-sm">{m.users_importLoading()}</span>
				</div>
			{:else if servers.length === 0}
				<div class="flex flex-col items-center gap-2 py-12 text-center">
					<Server class="h-8 w-8 text-base-content/40" />
					<p>{m.users_importNoServers()}</p>
					<p class="text-sm text-base-content/60">{m.users_importNoServersHint()}</p>
				</div>
			{:else}
				{#if servers.length > 1}
					<div class="mb-4">
						<label class="label" for="import-server-select">
							<span class="label-text">{m.users_importServerLabel()}</span>
						</label>
						<select
							id="import-server-select"
							class="select-bordered select w-full"
							bind:value={serverId}
							onchange={(event) => loadRoster(event.currentTarget.value)}
						>
							{#each servers as server (server.id)}
								<option value={server.id}>{server.name}</option>
							{/each}
						</select>
					</div>
				{/if}

				{#if rosterLoading}
					<div class="flex items-center justify-center gap-2 py-12 text-base-content/50">
						<Loader2 class="h-5 w-5 animate-spin" />
						<span class="text-sm">{m.users_importLoading()}</span>
					</div>
				{:else if rosterFailed}
					<div class="flex flex-col items-center gap-2 py-12 text-center">
						<p class="text-error">{m.users_importLoadFailed()}</p>
						<button
							type="button"
							class="btn btn-ghost btn-sm"
							onclick={() => serverId && loadRoster(serverId)}
						>
							<RefreshCw class="h-4 w-4" />
							{m.common_retry()}
						</button>
					</div>
				{:else if users !== null && users.length === 0}
					<p class="py-12 text-center text-base-content/60">{m.users_importNoUsers()}</p>
				{:else if users !== null}
					<div class="space-y-2">
						<label class="flex cursor-pointer items-center gap-3 border-b border-base-300 pb-2">
							<input
								type="checkbox"
								class="checkbox checkbox-sm checkbox-primary"
								checked={allSelected}
								indeterminate={someSelected}
								onchange={(event) => toggleAll(event.currentTarget.checked)}
							/>
							<span class="text-sm font-medium">{m.users_importSelectAll()}</span>
							<span class="ml-auto text-xs text-base-content/50">
								{m.users_importSelectedCount({
									selected: String(selected.size),
									total: String(users.length)
								})}
							</span>
						</label>
						{#each users as candidate (candidate.id)}
							{@const badge = statusBadge(candidate)}
							<label
								class="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-base-200/60 {candidate.status ===
								'importable'
									? ''
									: 'opacity-50'}"
							>
								<input
									type="checkbox"
									class="checkbox checkbox-sm checkbox-primary"
									disabled={candidate.status !== 'importable'}
									checked={selected.has(candidate.id)}
									onchange={(event) =>
										event.currentTarget.checked
											? selected.add(candidate.id)
											: selected.delete(candidate.id)}
								/>
								<span class="flex min-w-0 items-center gap-1.5 font-medium">
									{candidate.name}
									{#if candidate.isAdministrator}
										<ShieldCheck class="h-3.5 w-3.5 shrink-0 text-base-content/40" />
									{/if}
								</span>
								<span class="ml-auto flex items-center gap-2">
									{#if candidate.status === 'importable'}
										<span class="hidden text-xs text-base-content/40 sm:inline">
											{candidate.suggestedEmail}
										</span>
									{/if}
									<span class="badge badge-sm {badge.class}" title={badge.title ?? undefined}>
										{badge.label}
									</span>
								</span>
							</label>
						{/each}
					</div>
				{/if}
			{/if}
		{:else if results}
			<p class="mb-4 text-sm text-base-content/70">{m.users_importHint()}</p>
			<MediaServerImportResults {results} {copiedId} onCopy={handleCopy} />
		{/if}
	</div>

	{#if step === 'select' && servers !== null && servers.length > 0}
		<ModalFooter
			onCancel={onClose}
			onSave={handleImport}
			saving={importing}
			saveDisabled={selected.size === 0 || rosterLoading}
			saveLabel={m.users_importStart({ count: String(selected.size) })}
		/>
	{:else if step === 'results'}
		<div class="modal-action mt-6 border-t border-base-300 pt-4">
			<button type="button" class="btn btn-primary" onclick={onClose}>
				{m.users_importDone()}
			</button>
		</div>
	{/if}
</ModalWrapper>
